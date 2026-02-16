/**
 * Notification Preferences Manager
 *
 * Manages user notification preferences including:
 * - Global enable/disable
 * - Quiet hours with timezone support
 * - Per-type notification settings
 * - Delivery channel preferences
 */

import { createClient } from '@supabase/supabase-js';

// ============================================================
// TYPES
// ============================================================

export interface NotificationTypePreferences {
  enabled: boolean;
  threshold?: number;
  options?: Record<string, unknown>;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  notifications_enabled: boolean;
  quiet_hours_start: string | null;  // HH:mm format
  quiet_hours_end: string | null;    // HH:mm format
  timezone: string;
  telegram_enabled: boolean;
  email_enabled: boolean;
  email_address: string | null;
  type_preferences: Record<string, NotificationTypePreferences>;
  created_at: string;
  updated_at: string;
}

export type NotificationType =
  | 'heartbeat'
  | 'email_received'
  | 'email_important'
  | 'cron_executed'
  | 'error_alert'
  | 'goal_reminder'
  | 'sync_complete';

// Default preferences
const DEFAULT_TYPE_PREFERENCES: Record<string, NotificationTypePreferences> = {
  heartbeat: { enabled: true, options: { suppress_ok: true } },
  email_received: { enabled: false },
  email_important: { enabled: true, options: { keywords: ['urgent', 'important', 'asap'] } },
  cron_executed: { enabled: true },
  error_alert: { enabled: true },
  goal_reminder: { enabled: true, options: { hours_before: [24, 4, 1] } },
  sync_complete: { enabled: false },
};

// ============================================================
// NOTIFICATION PREFERENCES MANAGER
// ============================================================

export class NotificationPreferencesManager {
  private supabase: ReturnType<typeof createClient>;
  private cache: Map<string, NotificationPreferences> = new Map();
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private cacheTimestamps: Map<string, number> = new Map();

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Get notification preferences for a user
   * Returns cached version if fresh, otherwise fetches from DB
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    // Check cache
    const cached = this.cache.get(userId);
    const timestamp = this.cacheTimestamps.get(userId) || 0;

    if (cached && Date.now() - timestamp < this.cacheTTL) {
      return cached;
    }

    // Fetch from database
    const { data, error } = await this.supabase
      .rpc('get_notification_preferences', { p_user_id: userId })
      .single();

    if (error) {
      console.error('[NotificationPrefs] Error fetching preferences:', error);
      // Return defaults on error
      return this.getDefaultPreferences(userId);
    }

    // Cache and return
    this.cache.set(userId, data);
    this.cacheTimestamps.set(userId, Date.now());
    return data;
  }

  /**
   * Check if a notification should be sent
   * Considers global enable, quiet hours, and type-specific settings
   */
  async shouldNotify(
    userId: string,
    type: NotificationType,
    options?: { bypassQuietHours?: boolean }
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);

    // Global notifications disabled
    if (!prefs.notifications_enabled) {
      return false;
    }

    // Check quiet hours (unless bypassing)
    if (!options?.bypassQuietHours && this.isInQuietHours(prefs)) {
      return false;
    }

    // Check type-specific preference
    const typePref = prefs.type_preferences[type];
    if (typePref && !typePref.enabled) {
      return false;
    }

    return true;
  }

  /**
   * Check if current time is within quiet hours
   */
  private isInQuietHours(prefs: NotificationPreferences): boolean {
    if (!prefs.quiet_hours_start || !prefs.quiet_hours_end) {
      return false;
    }

    try {
      const now = new Date();
      const timezone = prefs.timezone || 'UTC';

      // Get current time in user's timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const currentTimeStr = formatter.format(now);
      const [currentHour, currentMinute] = currentTimeStr.split(':').map(Number);
      const currentMinutes = currentHour * 60 + currentMinute;

      // Parse quiet hours
      const [startHour, startMinute] = prefs.quiet_hours_start.split(':').map(Number);
      const [endHour, endMinute] = prefs.quiet_hours_end.split(':').map(Number);

      const startMinutes = startHour * 60 + startMinute;
      const endMinutes = endHour * 60 + endMinute;

      // Handle overnight quiet hours (e.g., 22:00 - 07:00)
      if (startMinutes > endMinutes) {
        // Overnight: current >= start OR current < end
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
      } else {
        // Same day: current >= start AND current < end
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }
    } catch (error) {
      console.error('[NotificationPrefs] Error checking quiet hours:', error);
      return false;
    }
  }

  /**
   * Update notification preferences
   */
  async updatePreferences(
    userId: string,
    updates: Partial<Omit<NotificationPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
  ): Promise<NotificationPreferences> {
    const { data, error } = await this.supabase
      .rpc('update_notification_preferences', {
        p_user_id: userId,
        p_updates: updates,
      })
      .single();

    if (error) {
      throw new Error(`Failed to update preferences: ${error.message}`);
    }

    // Invalidate cache
    this.cache.delete(userId);
    this.cacheTimestamps.delete(userId);

    return data;
  }

  /**
   * Set preference for a specific notification type
   */
  async setTypePreference(
    userId: string,
    type: NotificationType,
    enabled: boolean,
    options?: Record<string, unknown>
  ): Promise<void> {
    const { error } = await this.supabase.rpc('set_notification_type_preference', {
      p_user_id: userId,
      p_notification_type: type,
      p_enabled: enabled,
      p_options: options || {},
    });

    if (error) {
      throw new Error(`Failed to set type preference: ${error.message}`);
    }

    // Invalidate cache
    this.cache.delete(userId);
    this.cacheTimestamps.delete(userId);
  }

  /**
   * Get default preferences for a user
   */
  private getDefaultPreferences(userId: string): NotificationPreferences {
    return {
      id: '',
      user_id: userId,
      notifications_enabled: true,
      quiet_hours_start: '22:00',
      quiet_hours_end: '07:00',
      timezone: 'UTC',
      telegram_enabled: true,
      email_enabled: false,
      email_address: null,
      type_preferences: DEFAULT_TYPE_PREFERENCES,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Clear cache for a user (or all users)
   */
  clearCache(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
      this.cacheTimestamps.delete(userId);
    } else {
      this.cache.clear();
      this.cacheTimestamps.clear();
    }
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let instance: NotificationPreferencesManager | null = null;

export function getNotificationPreferencesManager(): NotificationPreferencesManager {
  if (!instance) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    }

    instance = new NotificationPreferencesManager(supabaseUrl, supabaseKey);
  }

  return instance;
}
