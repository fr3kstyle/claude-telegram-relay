/**
 * Auth Module
 *
 * Unified authentication and token management.
 */

export { TokenManager, getTokenManager } from './token-manager.ts';
export type { OAuthProvider, OAuthToken } from './token-manager.ts';

export {
  startTokenRefreshScheduler,
  stopTokenRefreshScheduler,
  getTokenRefreshStats,
  isTokenRefreshSchedulerRunning,
  triggerTokenRefreshCheck,
  registerRefreshHandler,
} from './token-refresh-scheduler.ts';
