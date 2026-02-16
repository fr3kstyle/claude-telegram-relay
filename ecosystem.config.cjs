module.exports = {
  apps: [
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
  ],
};
