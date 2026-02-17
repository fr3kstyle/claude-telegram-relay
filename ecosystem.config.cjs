module.exports = {
  apps: [
    // ============================================================
    // Core Services
    // ============================================================
    {
      name: "claude-relay",
      script: "bun",
      args: "run src/relay.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
    },
    {
      name: "agent-loop",
      script: "bun",
      args: "run src/agent-loop.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      watch: false,
    },
    {
      name: "deep-think",
      script: "bun",
      args: "run src/deep-think.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      cron_restart: "0 */2 * * *",
      autorestart: false,
      watch: false,
    },
    {
      name: "goal-engine",
      script: "bun",
      args: "run src/goal-engine.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      cron_restart: "30 * * * *",
      autorestart: false,
      watch: false,
    },

    // ============================================================
    // BEHEMOTH Trading Services
    // ============================================================

    // Scanners (different tiers with different frequencies)
    {
      name: "scanner-top10",
      script: "bun",
      args: "run src/trading/scanners/top10-scanner.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      watch: false,
    },
    {
      name: "scanner-top20",
      script: "bun",
      args: "run src/trading/scanners/top20-scanner.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 15000,
      max_restarts: 5,
      watch: false,
    },
    {
      name: "scanner-top50",
      script: "bun",
      args: "run src/trading/scanners/top50-scanner.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 30000,
      max_restarts: 5,
      watch: false,
    },

    // Trading Engine
    {
      name: "trade-executor",
      script: "bun",
      args: "run src/trading/engine/trade-executor.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 3,
      watch: false,
    },
    {
      name: "risk-monitor",
      script: "bun",
      args: "run src/trading/engine/risk-manager.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      watch: false,
    },
    {
      name: "position-manager",
      script: "bun",
      args: "run src/trading/engine/position-manager.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      watch: false,
    },

    // Learning Engine (runs hourly for pattern mining)
    {
      name: "learning-engine",
      script: "bun",
      args: "run src/trading/learning/pattern-miner.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      cron_restart: "0 * * * *",
      autorestart: false,
      watch: false,
    },

    // Telegram Alerter (listens for alerts via realtime)
    {
      name: "telegram-alerter",
      script: "bun",
      args: "run src/trading/alerts/telegram-alerter.ts",
      cwd: "/home/radxa/claude-telegram-relay",
      env: {
        NODE_ENV: "production",
        PATH: "/home/radxa/.npm-global/bin:/home/radxa/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      },
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      watch: false,
    },
  ],
};
