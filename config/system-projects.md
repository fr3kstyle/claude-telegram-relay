# System Projects Configuration

## Active Projects

### claude-telegram-relay
- **Path:** `/home/radxa/claude-telegram-relay`
- **Type:** TypeScript/Deno
- **Description:** Autonomous AI relay system with Telegram, CLI, and agent loop
- **Status:** Active development
- **Priority:** High

### reachy_mini_env
- **Path:** `/home/radxa/reachy_mini_env`
- **Type:** Python
- **Description:** Robotics environment for Reachy Mini
- **Status:** Available
- **Priority:** Medium

## Project Detection

Projects are auto-detected by:
1. Git repositories in home directory
2. package.json / deno.json / pyproject.toml presence
3. Recent file modifications

## Project Commands

- `/cd <project>` - Switch context to project
- `/status` - Show all project statuses
- `/focus <project>` - Enter focus mode for project

## Project Memory Isolation

Each project has isolated:
- Goals with parent_id filtering
- Context window prioritization
- Action history

Use `/focus <project>` to enable isolation mode.
