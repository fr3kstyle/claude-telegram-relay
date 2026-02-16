/**
 * Token Refresh Scheduler
 *
 * Proactively refreshes OAuth tokens before they expire.
 * Runs on a periodic interval and checks for tokens expiring soon.
 * Integrates with the relay lifecycle (start/stop).
 */

import { getTokenManager, type OAuthProvider } from './token-manager.ts';

// Default check interval: every 30 minutes
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Refresh tokens expiring within 1 hour
const DEFAULT_REFRESH_WINDOW_HOURS = 1;

// Registered refresh handlers per provider
type RefreshHandler = (email: string) => Promise<boolean>;
const refreshHandlers: Map<OAuthProvider, RefreshHandler> = new Map();

// Scheduler state
let schedulerTimer: Timer | null = null;
let isRunning = false;
let checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
let refreshWindowHours = DEFAULT_REFRESH_WINDOW_HOURS;

// Stats for observability
interface SchedulerStats {
  lastCheck: Date | null;
  tokensRefreshed: number;
  refreshErrors: number;
  lastError: string | null;
}

const stats: SchedulerStats = {
  lastCheck: null,
  tokensRefreshed: 0,
  refreshErrors: 0,
  lastError: null,
};

/**
 * Register a refresh handler for a provider
 *
 * The handler should attempt to refresh the token and return true on success.
 * This allows providers to implement their own refresh logic.
 */
export function registerRefreshHandler(
  provider: OAuthProvider,
  handler: RefreshHandler
): void {
  refreshHandlers.set(provider, handler);
  console.log(`[TokenRefreshScheduler] Registered handler for ${provider}`);
}

/**
 * Check and refresh tokens that are expiring soon
 */
async function checkAndRefreshTokens(): Promise<void> {
  stats.lastCheck = new Date();
  const tokenManager = getTokenManager();

  console.log('[TokenRefreshScheduler] Checking for tokens expiring soon...');

  try {
    // Get tokens expiring within the refresh window
    const expiringTokens = await tokenManager.getTokensExpiringSoon(refreshWindowHours);

    if (expiringTokens.length === 0) {
      console.log('[TokenRefreshScheduler] No tokens expiring soon');
      return;
    }

    console.log(`[TokenRefreshScheduler] Found ${expiringTokens.length} tokens expiring within ${refreshWindowHours}h`);

    for (const { provider, email } of expiringTokens) {
      const handler = refreshHandlers.get(provider as OAuthProvider);

      if (!handler) {
        console.log(`[TokenRefreshScheduler] No handler for ${provider}, using TokenManager auto-refresh`);
        // TokenManager.getAccessToken will handle refresh automatically
        try {
          await tokenManager.getAccessToken(provider as OAuthProvider, email);
          stats.tokensRefreshed++;
          console.log(`[TokenRefreshScheduler] Refreshed ${provider}:${email} via TokenManager`);
        } catch (err) {
          stats.refreshErrors++;
          stats.lastError = err instanceof Error ? err.message : String(err);
          console.error(`[TokenRefreshScheduler] Failed to refresh ${provider}:${email}:`, err);
        }
        continue;
      }

      // Use custom handler
      try {
        const success = await handler(email);
        if (success) {
          stats.tokensRefreshed++;
          console.log(`[TokenRefreshScheduler] Refreshed ${provider}:${email} via handler`);
        } else {
          stats.refreshErrors++;
          console.log(`[TokenRefreshScheduler] Handler returned false for ${provider}:${email}`);
        }
      } catch (err) {
        stats.refreshErrors++;
        stats.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[TokenRefreshScheduler] Handler error for ${provider}:${email}:`, err);
      }
    }
  } catch (err) {
    stats.lastError = err instanceof Error ? err.message : String(err);
    console.error('[TokenRefreshScheduler] Check failed:', err);
  }
}

/**
 * Scheduler tick - called on interval
 */
function schedulerTick(): void {
  if (!isRunning) return;
  checkAndRefreshTokens().catch(err => {
    console.error('[TokenRefreshScheduler] Tick error:', err);
  });
}

/**
 * Start the token refresh scheduler
 */
export function startTokenRefreshScheduler(
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
  windowHours: number = DEFAULT_REFRESH_WINDOW_HOURS
): void {
  if (isRunning) {
    console.log('[TokenRefreshScheduler] Already running');
    return;
  }

  checkIntervalMs = intervalMs;
  refreshWindowHours = windowHours;
  isRunning = true;

  // Run first check immediately
  schedulerTick();

  // Schedule periodic checks
  schedulerTimer = setInterval(schedulerTick, checkIntervalMs);

  console.log(`[TokenRefreshScheduler] Started (interval: ${checkIntervalMs / 60000}min, window: ${refreshWindowHours}h)`);
}

/**
 * Stop the token refresh scheduler
 */
export function stopTokenRefreshScheduler(): void {
  if (!isRunning) return;

  isRunning = false;

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  console.log('[TokenRefreshScheduler] Stopped');
}

/**
 * Get scheduler stats for observability
 */
export function getTokenRefreshStats(): SchedulerStats & { isRunning: boolean } {
  return {
    ...stats,
    isRunning,
  };
}

/**
 * Check if scheduler is running
 */
export function isTokenRefreshSchedulerRunning(): boolean {
  return isRunning;
}

/**
 * Trigger an immediate token check (for testing or manual trigger)
 */
export async function triggerTokenRefreshCheck(): Promise<void> {
  await checkAndRefreshTokens();
}
