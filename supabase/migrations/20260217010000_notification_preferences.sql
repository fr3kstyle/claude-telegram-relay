-- ============================================================
-- Schema v2.7: Notification Preferences
-- ============================================================
-- User-configurable notification preferences for various events.
-- Supports notification types, delivery channels, and quiet hours.
--
-- Tables:
-- - notification_preferences: Per-user notification settings
--
-- Features:
-- - Multiple notification types (email, system, alerts)
-- - Delivery channels (telegram, email, push)
-- - Quiet hours with timezone support
-- - Per-type enable/disable with custom thresholds

-- ============================================================
-- 1. NOTIFICATION PREFERENCES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,  -- Telegram user ID or system identifier

  -- Global notification settings
  notifications_enabled BOOLEAN DEFAULT true,
  quiet_hours_start TIME,  -- e.g., '22:00'
  quiet_hours_end TIME,    -- e.g., '07:00'
  timezone TEXT DEFAULT 'UTC',

  -- Delivery channels
  telegram_enabled BOOLEAN DEFAULT true,
  email_enabled BOOLEAN DEFAULT false,
  email_address TEXT,  -- For email notifications

  -- Per-type preferences (JSONB for flexibility)
  -- Structure: { "type": { "enabled": bool, "threshold": number, "options": {} } }
  type_preferences JSONB DEFAULT '{}',

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);

-- ============================================================
-- 2. NOTIFICATION TYPES ENUM
-- ============================================================
-- Supported notification types (stored in type_preferences JSONB)
-- - heartbeat: Heartbeat cycle notifications
-- - email_received: New email notifications
-- - email_important: Important email alerts
-- - cron_executed: Cron job completion
-- - error_alert: System error alerts
-- - goal_reminder: Goal deadline reminders
-- - sync_complete: Email sync completion

-- ============================================================
-- 3. HELPER RPCs
-- ============================================================

-- Get notification preferences for a user (creates default if not exists)
CREATE OR REPLACE FUNCTION get_notification_preferences(
  p_user_id TEXT
)
RETURNS notification_preferences AS $$
DECLARE
  prefs notification_preferences%ROWTYPE;
BEGIN
  SELECT * INTO prefs FROM notification_preferences
  WHERE user_id = p_user_id;

  -- Return default preferences if not found
  IF NOT FOUND THEN
    RETURN ROW(
      gen_random_uuid(),
      p_user_id,
      true,  -- notifications_enabled
      '22:00'::TIME,  -- quiet_hours_start
      '07:00'::TIME,  -- quiet_hours_end
      'UTC',  -- timezone
      true,  -- telegram_enabled
      false, -- email_enabled
      NULL,  -- email_address
      jsonb_build_object(
        'heartbeat', jsonb_build_object('enabled', true, 'suppress_ok', true),
        'email_received', jsonb_build_object('enabled', false),
        'email_important', jsonb_build_object('enabled', true, 'keywords', jsonb_build_array('urgent', 'important', 'asap')),
        'cron_executed', jsonb_build_object('enabled', true),
        'error_alert', jsonb_build_object('enabled', true),
        'goal_reminder', jsonb_build_object('enabled', true, 'hours_before', jsonb_build_array(24, 4, 1)),
        'sync_complete', jsonb_build_object('enabled', false)
      ),
      NOW(),
      NOW()
    );
  END IF;

  RETURN prefs;
END;
$$ LANGUAGE plpgsql;

-- Update notification preferences
CREATE OR REPLACE FUNCTION update_notification_preferences(
  p_user_id TEXT,
  p_updates JSONB
)
RETURNS notification_preferences AS $$
DECLARE
  prefs notification_preferences%ROWTYPE;
BEGIN
  -- Upsert preferences
  INSERT INTO notification_preferences (user_id, notifications_enabled, quiet_hours_start, quiet_hours_end, timezone, telegram_enabled, email_enabled, email_address, type_preferences)
  VALUES (
    p_user_id,
    COALESCE((p_updates->>'notifications_enabled')::BOOLEAN, true),
    (p_updates->>'quiet_hours_start')::TIME,
    (p_updates->>'quiet_hours_end')::TIME,
    COALESCE(p_updates->>'timezone', 'UTC'),
    COALESCE((p_updates->>'telegram_enabled')::BOOLEAN, true),
    COALESCE((p_updates->>'email_enabled')::BOOLEAN, false),
    p_updates->>'email_address',
    COALESCE(p_updates->'type_preferences', '{}'::JSONB)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    notifications_enabled = COALESCE(EXCLUDED.notifications_enabled, notification_preferences.notifications_enabled),
    quiet_hours_start = COALESCE(EXCLUDED.quiet_hours_start, notification_preferences.quiet_hours_start),
    quiet_hours_end = COALESCE(EXCLUDED.quiet_hours_end, notification_preferences.quiet_hours_end),
    timezone = COALESCE(EXCLUDED.timezone, notification_preferences.timezone),
    telegram_enabled = COALESCE(EXCLUDED.telegram_enabled, notification_preferences.telegram_enabled),
    email_enabled = COALESCE(EXCLUDED.email_enabled, notification_preferences.email_enabled),
    email_address = COALESCE(EXCLUDED.email_address, notification_preferences.email_address),
    type_preferences = COALESCE(EXCLUDED.type_preferences, notification_preferences.type_preferences),
    updated_at = NOW()
  RETURNING * INTO prefs;

  RETURN prefs;
END;
$$ LANGUAGE plpgsql;

-- Check if notifications are allowed (considers quiet hours)
CREATE OR REPLACE FUNCTION is_notification_allowed(
  p_user_id TEXT,
  p_notification_type TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  prefs notification_preferences%ROWTYPE;
  current_time TIME;
  in_quiet_hours BOOLEAN;
  type_enabled BOOLEAN;
BEGIN
  -- Get preferences
  SELECT * INTO prefs FROM notification_preferences
  WHERE user_id = p_user_id;

  -- If no preferences, allow by default
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  -- Global notifications disabled
  IF NOT prefs.notifications_enabled THEN
    RETURN false;
  END IF;

  -- Check quiet hours
  IF prefs.quiet_hours_start IS NOT NULL AND prefs.quiet_hours_end IS NOT NULL THEN
    current_time := CURRENT_TIME AT TIME ZONE prefs.timezone;

    -- Handle overnight quiet hours (e.g., 22:00 - 07:00)
    IF prefs.quiet_hours_start > prefs.quiet_hours_end THEN
      in_quiet_hours := current_time >= prefs.quiet_hours_start OR current_time < prefs.quiet_hours_end;
    ELSE
      in_quiet_hours := current_time >= prefs.quiet_hours_start AND current_time < prefs.quiet_hours_end;
    END IF;

    IF in_quiet_hours THEN
      RETURN false;
    END IF;
  END IF;

  -- Check type-specific preference
  IF p_notification_type IS NOT NULL THEN
    type_enabled := (prefs.type_preferences->p_notification_type->>'enabled')::BOOLEAN;
    -- If type pref not set, default to true
    IF type_enabled IS NULL THEN
      RETURN true;
    END IF;
    RETURN type_enabled;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Update a specific notification type preference
CREATE OR REPLACE FUNCTION set_notification_type_preference(
  p_user_id TEXT,
  p_notification_type TEXT,
  p_enabled BOOLEAN DEFAULT true,
  p_options JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO notification_preferences (user_id, type_preferences)
  VALUES (
    p_user_id,
    jsonb_build_object(p_notification_type, jsonb_build_object('enabled', p_enabled) || p_options)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    type_preferences = notification_preferences.type_preferences ||
      jsonb_build_object(p_notification_type, jsonb_build_object('enabled', p_enabled) || p_options),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. DEFAULT PREFERENCES FOR EXISTING USER
-- ============================================================
-- Insert default preferences for the configured Telegram user if env var exists
-- This will be handled by the application code, not migration

COMMENT ON TABLE notification_preferences IS 'User-configurable notification preferences with quiet hours support';
COMMENT ON FUNCTION get_notification_preferences IS 'Get preferences for a user, returns defaults if not found';
COMMENT ON FUNCTION is_notification_allowed IS 'Check if a notification should be sent (considers quiet hours)';

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_notification_prefs" ON notification_preferences FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 6. LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Notification preferences schema v2.7 applied',
  '{"version": "20260217010000", "features": ["notification_preferences", "quiet_hours", "type_preferences", "helper_rpcs"]}'::jsonb
);
