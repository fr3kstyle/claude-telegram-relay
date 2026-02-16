/**
 * Execution Module
 *
 * Safe command execution with security guards.
 * Validates dangerous operations before execution.
 */

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
  retryCount: number;
}

export interface CommandValidation {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

// Commands that require explicit confirmation
const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-rf\b/, reason: "Recursive forced delete" },
  { pattern: /\brm\s+-fr\b/, reason: "Recursive forced delete" },
  { pattern: /\brm\s+.*\*/, reason: "Wildcard delete" },
  { pattern: /git\s+push\s+.*--force/, reason: "Force push to remote" },
  { pattern: /git\s+push\s+.*-f\b/, reason: "Force push to remote" },
  { pattern: /systemctl\s+stop/, reason: "Stopping system service" },
  { pattern: /systemctl\s+restart/, reason: "Restarting system service" },
  { pattern: /systemctl\s+disable/, reason: "Disabling system service" },
  { pattern: /DROP\s+(DATABASE|TABLE|SCHEMA)/i, reason: "Database drop operation" },
  { pattern: /TRUNCATE\s+TABLE/i, reason: "Table truncation" },
  { pattern: /DELETE\s+FROM/i, reason: "Delete from table (without WHERE check)" },
  { pattern: /chmod\s+(-R\s+)?777/, reason: "Insecure permissions" },
  { pattern: /chown\s+.*\*/, reason: "Wildcard ownership change" },
  { pattern: />\s*\/dev\/sda/, reason: "Direct disk write" },
  { pattern: /dd\s+.*of=\/dev/, reason: "Disk write operation" },
  { pattern: /:(){ :\|:& };:/, reason: "Fork bomb" },
  { pattern: /curl.*\|\s*(sudo\s+)?bash/, reason: "Piping curl to bash" },
  { pattern: /wget.*\|\s*(sudo\s+)?bash/, reason: "Piping wget to bash" },
];

// Commands that are always blocked
const BLOCKED_PATTERNS = [
  { pattern: /mkfs/, reason: "Format filesystem" },
  { pattern: /fdisk/, reason: "Disk partitioning" },
  { pattern: /shutdown\s+now/, reason: "Immediate shutdown" },
  { pattern: /reboot/, reason: "System reboot without confirmation" },
  { pattern: /init\s+0/, reason: "Shutdown via init" },
  { pattern: /init\s+6/, reason: "Reboot via init" },
];

// Command whitelist for autonomous execution (no confirmation needed)
const AUTONOMOUS_WHITELIST = [
  /^ls\b/,
  /^cat\s+\S/,  // cat with file
  /^head\b/,
  /^tail\b/,
  /^pwd\b/,
  /^echo\b/,
  /^which\b/,
  /^grep\b/,
  /^find\b/,
  /^git\s+status\b/,
  /^git\s+log\b/,
  /^git\s+diff\b/,
  /^git\s+branch\b/,
  /^git\s+fetch\b/,
  /^npm\s+list\b/,
  /^npm\s+outdated\b/,
  /^deno\s+check\b/,
  /^python3?\s+--version\b/,
  /^node\s+--version\b/,
];

/**
 * Validate a command before execution
 */
export function validateCommand(command: string): CommandValidation {
  // Check blocked patterns first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reason: `BLOCKED: ${reason} - This operation is not allowed autonomously`,
      };
    }
  }

  // Check dangerous patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: `Requires confirmation: ${reason}`,
      };
    }
  }

  // Check if command is in autonomous whitelist
  const isWhitelisted = AUTONOMOUS_WHITELIST.some(pattern => pattern.test(command));

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: isWhitelisted ? "Whitelisted for autonomous execution" : undefined,
  };
}

/**
 * Execute a command with validation and tracking
 */
export async function executeCommand(
  command: string,
  options: {
    timeout?: number;
    cwd?: string;
    onConfirm?: (reason: string) => Promise<boolean>;
    onProgress?: (output: string) => void;
  } = {}
): Promise<ExecutionResult> {
  const startTime = Date.now();
  let retryCount = 0;

  // Validate command
  const validation = validateCommand(command);

  if (!validation.allowed) {
    return {
      success: false,
      output: "",
      error: validation.reason,
      executionTime: Date.now() - startTime,
      retryCount: 0,
    };
  }

  // Request confirmation if needed
  if (validation.requiresConfirmation && options.onConfirm) {
    const confirmed = await options.onConfirm(validation.reason || "Dangerous operation");
    if (!confirmed) {
      return {
        success: false,
        output: "",
        error: "Operation cancelled by user",
        executionTime: Date.now() - startTime,
        retryCount: 0,
      };
    }
  }

  // Execute command
  try {
    const proc = Deno.run({
      cmd: ["bash", "-c", command],
      cwd: options.cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const stdout = await proc.output();
    const stderr = await proc.stderrOutput();
    const status = await proc.status();
    proc.close();

    const output = new TextDecoder().decode(stdout);
    const error = new TextDecoder().decode(stderr);

    return {
      success: status.success,
      output,
      error: error || undefined,
      executionTime: Date.now() - startTime,
      retryCount,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      executionTime: Date.now() - startTime,
      retryCount,
    };
  }
}

/**
 * Execute with automatic retry on failure
 */
export async function executeWithRetry(
  command: string,
  maxRetries: number = 3,
  options: {
    timeout?: number;
    cwd?: string;
    delayMs?: number;
  } = {}
): Promise<ExecutionResult> {
  const delay = options.delayMs || 1000;
  let lastResult: ExecutionResult | null = null;
  let retries = 0;

  while (retries <= maxRetries) {
    const result = await executeCommand(command, options);
    lastResult = { ...result, retryCount: retries };

    if (result.success) {
      return lastResult;
    }

    retries++;
    if (retries <= maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delay * retries));
    }
  }

  return lastResult!;
}

/**
 * Batch execute multiple commands
 */
export async function executeBatch(
  commands: string[],
  options: {
    stopOnError?: boolean;
    cwd?: string;
  } = {}
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const command of commands) {
    const result = await executeCommand(command, { cwd: options.cwd });
    results.push(result);

    if (!result.success && options.stopOnError !== false) {
      break;
    }
  }

  return results;
}
