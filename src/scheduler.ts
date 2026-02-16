/**
 * Adaptive Scheduler Module
 *
 * Dynamic scheduling based on work patterns and activity levels.
 * Replaces fixed intervals with intelligent timing.
 */

export interface WorkPattern {
  highFocus: { start: number; end: number };   // Hours (0-23)
  executionMode: { start: number; end: number };
  lowCognitive: { start: number; end: number };
}

export interface SchedulerConfig {
  baseIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  workPattern: WorkPattern;
}

const DEFAULT_WORK_PATTERN: WorkPattern = {
  highFocus: { start: 8, end: 12 },      // 8am-12pm
  executionMode: { start: 13, end: 18 }, // 1pm-6pm
  lowCognitive: { start: 21, end: 24 },  // 9pm onwards
};

const DEFAULT_CONFIG: SchedulerConfig = {
  baseIntervalMs: 30 * 60 * 1000,  // 30 minutes
  minIntervalMs: 5 * 60 * 1000,    // 5 minutes
  maxIntervalMs: 2 * 60 * 60 * 1000, // 2 hours
  workPattern: DEFAULT_WORK_PATTERN,
};

export type ScheduleMode = "aggressive" | "normal" | "low" | "idle";

/**
 * Get current hour in local timezone
 */
function getCurrentHour(timezone: string = "Australia/Brisbane"): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(now), 10);
}

/**
 * Determine current schedule mode based on time and activity
 */
export function getScheduleMode(
  timezone: string = "Australia/Brisbane",
  config: SchedulerConfig = DEFAULT_CONFIG
): ScheduleMode {
  const hour = getCurrentHour(timezone);
  const { workPattern } = config;

  // High focus hours - aggressive mode for proactive work
  if (hour >= workPattern.highFocus.start && hour < workPattern.highFocus.end) {
    return "aggressive";
  }

  // Execution mode - normal but active
  if (hour >= workPattern.executionMode.start && hour < workPattern.executionMode.end) {
    return "normal";
  }

  // Low cognitive - minimal activity
  if (hour >= workPattern.lowCognitive.start || hour < 6) {
    return "low";
  }

  // Default to normal
  return "normal";
}

/**
 * Calculate adaptive interval based on mode and activity
 */
export function calculateInterval(
  mode: ScheduleMode,
  activeActionCount: number = 0,
  config: SchedulerConfig = DEFAULT_CONFIG
): number {
  let interval = config.baseIntervalMs;

  switch (mode) {
    case "aggressive":
      interval = config.minIntervalMs; // 5 min
      if (activeActionCount > 5) {
        interval = Math.max(interval / 2, 2 * 60 * 1000); // 2 min if busy
      }
      break;

    case "normal":
      interval = config.baseIntervalMs; // 30 min
      if (activeActionCount > 3) {
        interval = config.minIntervalMs; // 5 min if busy
      }
      break;

    case "low":
      interval = config.maxIntervalMs; // 2 hours
      break;

    case "idle":
      interval = config.maxIntervalMs * 2; // 4 hours
      break;
  }

  return Math.max(config.minIntervalMs, Math.min(config.maxIntervalMs * 2, interval));
}

/**
 * Nightly consolidation pass - runs at 2am
 */
export async function runNightlyConsolidation(): Promise<string> {
  const insights: string[] = [];

  // 1. Summarize day's activity
  insights.push("=== Nightly Consolidation Pass ===");
  insights.push(`Timestamp: ${new Date().toISOString()}`);

  // 2. This would normally query the database
  // For now, return the structure
  insights.push("- Daily summary: [would query logs table]");
  insights.push("- Completed goals archived: [would update memory]");
  insights.push("- Embedding compression: [would compress vectors]");
  insights.push("- Recurring themes: [would analyze patterns]");

  // 3. Suggest system improvements
  insights.push("- System upgrade suggestions: [would analyze metrics]");

  return insights.join("\n");
}

/**
 * Check if nightly consolidation should run
 */
export function shouldRunNightlyConsolidation(
  timezone: string = "Australia/Brisbane"
): boolean {
  const hour = getCurrentHour(timezone);
  const minute = new Date().getMinutes();

  // Run at 2:00 AM
  return hour === 2 && minute < 5;
}

/**
 * Scheduler state for tracking
 */
export interface SchedulerState {
  lastRun: Date;
  nextRun: Date;
  mode: ScheduleMode;
  intervalMs: number;
  consecutiveIdleRuns: number;
}

/**
 * Create scheduler instance
 */
export function createScheduler(
  config: SchedulerConfig = DEFAULT_CONFIG,
  timezone: string = "Australia/Brisbane"
) {
  const state: SchedulerState = {
    lastRun: new Date(),
    nextRun: new Date(),
    mode: "normal",
    intervalMs: config.baseIntervalMs,
    consecutiveIdleRuns: 0,
  };

  return {
    state,

    /**
     * Get next interval based on current conditions
     */
    getNextInterval(activeActionCount: number): number {
      state.mode = getScheduleMode(timezone, config);
      state.intervalMs = calculateInterval(state.mode, activeActionCount, config);
      return state.intervalMs;
    },

    /**
     * Mark a run as complete
     */
    markRun(hadActivity: boolean): void {
      state.lastRun = new Date();
      state.nextRun = new Date(Date.now() + state.intervalMs);

      if (hadActivity) {
        state.consecutiveIdleRuns = 0;
      } else {
        state.consecutiveIdleRuns++;
      }
    },

    /**
     * Check if it's time to run
     */
    shouldRun(): boolean {
      return Date.now() >= state.nextRun.getTime();
    },

    /**
     * Check if nightly consolidation should run
     */
    checkNightlyConsolidation(): boolean {
      return shouldRunNightlyConsolidation(timezone);
    },

    /**
     * Get current state summary
     */
    getStatus(): string {
      return `Mode: ${state.mode} | Interval: ${Math.round(state.intervalMs / 60000)}min | Idle runs: ${state.consecutiveIdleRuns}`;
    },
  };
}
