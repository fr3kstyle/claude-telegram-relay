-- ============================================================
-- Email Statistics RPC Functions
-- ============================================================
-- Aggregation functions for email analytics and dashboard summaries.
-- Run this file in: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new

-- ============================================================
-- 1. OVERALL EMAIL STATISTICS
-- ============================================================
-- Returns summary stats across all accounts or a specific account
CREATE OR REPLACE FUNCTION get_email_stats(
  p_account_id UUID DEFAULT NULL,
  p_since_days INT DEFAULT 30
)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_since_date TIMESTAMPTZ;
BEGIN
  v_since_date := NOW() - (p_since_days || ' days')::interval;

  SELECT jsonb_build_object(
    'total_messages', (SELECT COUNT(*) FROM email_messages WHERE (p_account_id IS NULL OR account_id = p_account_id)),
    'messages_since', (SELECT COUNT(*) FROM email_messages WHERE (p_account_id IS NULL OR account_id = p_account_id) AND date >= v_since_date),
    'unread_count', (SELECT COUNT(*) FROM email_messages WHERE is_read = false AND (p_account_id IS NULL OR account_id = p_account_id)),
    'starred_count', (SELECT COUNT(*) FROM email_messages WHERE is_starred = true AND (p_account_id IS NULL OR account_id = p_account_id)),
    'draft_count', (SELECT COUNT(*) FROM email_messages WHERE is_draft = true AND (p_account_id IS NULL OR account_id = p_account_id)),
    'important_count', (SELECT COUNT(*) FROM email_messages WHERE is_important = true AND (p_account_id IS NULL OR account_id = p_account_id)),
    'with_attachments', (SELECT COUNT(*) FROM email_messages WHERE jsonb_array_length(attachments) > 0 AND (p_account_id IS NULL OR account_id = p_account_id)),
    'with_embeddings', (SELECT COUNT(*) FROM email_messages WHERE embedding IS NOT NULL AND (p_account_id IS NULL OR account_id = p_account_id)),
    'unique_senders', (SELECT COUNT(DISTINCT from_email) FROM email_messages WHERE (p_account_id IS NULL OR account_id = p_account_id)),
    'unique_threads', (SELECT COUNT(DISTINCT thread_id) FROM email_messages WHERE thread_id IS NOT NULL AND (p_account_id IS NULL OR account_id = p_account_id)),
    'oldest_message_date', (SELECT MIN(date) FROM email_messages WHERE (p_account_id IS NULL OR account_id = p_account_id)),
    'newest_message_date', (SELECT MAX(date) FROM email_messages WHERE (p_account_id IS NULL OR account_id = p_account_id)),
    'period_days', p_since_days
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 2. EMAIL VOLUME BY TIME PERIOD
-- ============================================================
-- Returns message counts grouped by day/week/month
CREATE OR REPLACE FUNCTION get_email_volume_by_period(
  p_account_id UUID DEFAULT NULL,
  p_period TEXT DEFAULT 'day',  -- 'day', 'week', 'month'
  p_since_days INT DEFAULT 30
)
RETURNS TABLE (
  period_start DATE,
  period_end DATE,
  message_count BIGINT,
  unread_count BIGINT
) AS $$
DECLARE
  v_since_date TIMESTAMPTZ;
BEGIN
  v_since_date := NOW() - (p_since_days || ' days')::interval;

  RETURN QUERY
  SELECT
    CASE
      WHEN p_period = 'day' THEN DATE(em.date)
      WHEN p_period = 'week' THEN DATE_TRUNC('week', em.date)::DATE
      WHEN p_period = 'month' THEN DATE_TRUNC('month', em.date)::DATE
      ELSE DATE(em.date)
    END AS period_start,
    CASE
      WHEN p_period = 'day' THEN DATE(em.date)
      WHEN p_period = 'week' THEN (DATE_TRUNC('week', em.date) + INTERVAL '6 days')::DATE
      WHEN p_period = 'month' THEN (DATE_TRUNC('month', em.date) + INTERVAL '1 month - 1 day')::DATE
      ELSE DATE(em.date)
    END AS period_end,
    COUNT(*) AS message_count,
    SUM(CASE WHEN em.is_read = false THEN 1 ELSE 0 END) AS unread_count
  FROM email_messages em
  WHERE em.date >= v_since_date
    AND (p_account_id IS NULL OR em.account_id = p_account_id)
  GROUP BY
    CASE
      WHEN p_period = 'day' THEN DATE(em.date)
      WHEN p_period = 'week' THEN DATE_TRUNC('week', em.date)::DATE
      WHEN p_period = 'month' THEN DATE_TRUNC('month', em.date)::DATE
      ELSE DATE(em.date)
    END,
    CASE
      WHEN p_period = 'day' THEN DATE(em.date)
      WHEN p_period = 'week' THEN (DATE_TRUNC('week', em.date) + INTERVAL '6 days')::DATE
      WHEN p_period = 'month' THEN (DATE_TRUNC('month', em.date) + INTERVAL '1 month - 1 day')::DATE
      ELSE DATE(em.date)
    END
  ORDER BY period_start DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. TOP SENDERS
-- ============================================================
-- Returns most frequent email senders
CREATE OR REPLACE FUNCTION get_top_senders(
  p_account_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 10,
  p_since_days INT DEFAULT 30
)
RETURNS TABLE (
  from_email TEXT,
  from_name TEXT,
  message_count BIGINT,
  unread_count BIGINT,
  last_message_date TIMESTAMPTZ
) AS $$
DECLARE
  v_since_date TIMESTAMPTZ;
BEGIN
  v_since_date := NOW() - (p_since_days || ' days')::interval;

  RETURN QUERY
  SELECT
    em.from_email,
    em.from_name,
    COUNT(*) AS message_count,
    SUM(CASE WHEN em.is_read = false THEN 1 ELSE 0 END) AS unread_count,
    MAX(em.date) AS last_message_date
  FROM email_messages em
  WHERE em.date >= v_since_date
    AND (p_account_id IS NULL OR em.account_id = p_account_id)
    AND em.from_email IS NOT NULL
  GROUP BY em.from_email, em.from_name
  ORDER BY message_count DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. EMAIL ACCOUNT HEALTH
-- ============================================================
-- Returns sync health status for all accounts
CREATE OR REPLACE FUNCTION get_email_account_health()
RETURNS TABLE (
  email TEXT,
  display_name TEXT,
  provider TEXT,
  is_active BOOLEAN,
  sync_enabled BOOLEAN,
  last_sync_at TIMESTAMPTZ,
  sync_status TEXT,
  total_messages INTEGER,
  messages_synced INTEGER,
  error_count INTEGER,
  last_error TEXT,
  sync_age_hours FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ea.email,
    ea.display_name,
    ea.provider,
    ea.is_active,
    ea.sync_enabled,
    ess.last_sync_at,
    ess.sync_status,
    ea.total_messages,
    ess.messages_synced,
    ess.error_count,
    ess.last_error,
    CASE
      WHEN ess.last_sync_at IS NULL THEN -1
      ELSE EXTRACT(EPOCH FROM (NOW() - ess.last_sync_at)) / 3600
    END AS sync_age_hours
  FROM email_accounts ea
  LEFT JOIN email_sync_state ess ON ess.account_id = ea.id
  ORDER BY ea.email;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. RECENT EMAIL SUMMARY
-- ============================================================
-- Quick snapshot for dashboards/notifications
CREATE OR REPLACE FUNCTION get_recent_email_summary(
  p_account_id UUID DEFAULT NULL,
  p_hours INT DEFAULT 24
)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_since_date TIMESTAMPTZ;
BEGIN
  v_since_date := NOW() - (p_hours || ' hours')::interval;

  SELECT jsonb_build_object(
    'period_hours', p_hours,
    'new_messages', (
      SELECT COUNT(*) FROM email_messages
      WHERE date >= v_since_date AND (p_account_id IS NULL OR account_id = p_account_id)
    ),
    'new_unread', (
      SELECT COUNT(*) FROM email_messages
      WHERE date >= v_since_date AND is_read = false AND (p_account_id IS NULL OR account_id = p_account_id)
    ),
    'new_starred', (
      SELECT COUNT(*) FROM email_messages
      WHERE date >= v_since_date AND is_starred = true AND (p_account_id IS NULL OR account_id = p_account_id)
    ),
    'total_unread', (
      SELECT COUNT(*) FROM email_messages
      WHERE is_read = false AND (p_account_id IS NULL OR account_id = p_account_id)
    ),
    'top_senders', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'email', from_email,
        'name', from_name,
        'count', cnt
      )), '[]'::jsonb)
      FROM (
        SELECT from_email, from_name, COUNT(*) as cnt
        FROM email_messages
        WHERE date >= v_since_date AND (p_account_id IS NULL OR account_id = p_account_id)
        GROUP BY from_email, from_name
        ORDER BY cnt DESC
        LIMIT 5
      ) sub
    ),
    'latest_messages', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id,
        'subject', subject,
        'from', from_email,
        'from_name', from_name,
        'date', date,
        'is_read', is_read,
        'is_starred', is_starred
      )), '[]'::jsonb)
      FROM (
        SELECT id, subject, from_email, from_name, date, is_read, is_starred
        FROM email_messages
        WHERE (p_account_id IS NULL OR account_id = p_account_id)
        ORDER BY date DESC
        LIMIT 5
      ) sub
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. LABEL/FOLDER DISTRIBUTION
-- ============================================================
-- Returns breakdown by Gmail labels or folders
CREATE OR REPLACE FUNCTION get_label_distribution(
  p_account_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  label TEXT,
  message_count BIGINT,
  unread_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    label.value::TEXT AS label,
    COUNT(*) AS message_count,
    SUM(CASE WHEN em.is_read = false THEN 1 ELSE 0 END) AS unread_count
  FROM email_messages em,
       jsonb_array_elements_text(em.labels) AS label
  WHERE (p_account_id IS NULL OR em.account_id = p_account_id)
    AND jsonb_array_length(em.labels) > 0
  GROUP BY label.value
  ORDER BY message_count DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Email stats RPC functions applied',
  '{"version": "20260217020000", "functions": ["get_email_stats", "get_email_volume_by_period", "get_top_senders", "get_email_account_health", "get_recent_email_summary", "get_label_distribution"]}'::jsonb
);
