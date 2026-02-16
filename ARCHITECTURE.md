# Claude Telegram Relay - System Architecture

## Overview

A dual-loop autonomous agent system bridging Telegram to Claude Code CLI. The system combines reactive message handling with proactive autonomous operation.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Telegram Bot API                           │
│                           ↓ ↑                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Relay (Bun/TypeScript)                │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │   │
│  │  │   relay.ts  │  │ agent-loop.ts │  │ deep-think.ts  │  │   │
│  │  │  (Reactive) │  │  (Autonomous) │  │   (Strategic)  │  │   │
│  │  └──────┬──────┘  └───────┬───────┘  └───────┬────────┘  │   │
│  │         │                 │                   │           │   │
│  │  ┌──────┴─────────────────┴───────────────────┴────────┐  │   │
│  │  │              Memory System (memory.ts)               │  │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │   │
│  │  │  │   Facts    │  │   Goals    │  │   Strategies   │  │  │   │
│  │  │  └────────────┘  └────────────┘  └────────────────┘  │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                     │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │                   Supabase (PostgreSQL)                      │  │
│  │  global_memory │ threads │ cron_jobs │ logs_v2 │ agent_state│  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Claude CLI (claude)                       │  │
│  │   Tools: Bash, Read, Write, Edit, Glob, Grep, Task, Web...   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Reactive Layer (`src/relay.ts`)

The main relay handling Telegram messages with full Claude Code capabilities.

**Message Flow:**
```
Telegram Message → Auth Check → Thread Resolution → buildPrompt() → callClaude() → processIntents() → Response
```

**Key Features:**
- **Threading**: Each Telegram topic gets its own Claude session via `--resume`
- **Memory Layers**: Soul + Global Memory + Semantic Search + Thread Context
- **Streaming**: Real-time progress updates with liveness indicators
- **Voice I/O**: Groq Whisper transcription + ElevenLabs TTS
- **Intent System**: Tags parsed from responses to manage memory

### 2. Autonomous Layer (`src/agent-loop.ts`)

Background agent running continuous cognitive cycles.

**Cycle Operations:**
1. Fetch active goals and pending actions
2. Execute up to 3 priority actions per cycle
3. Decompose complex goals into sub-tasks
4. Generate reflections on outcomes
5. Self-heal blocked items ready for retry

**Configuration:**
- Default interval: 3 minutes (`AGENT_LOOP_INTERVAL`)
- State persisted to `~/.claude-relay/agent-state.json`

### 3. Strategic Layer (`src/deep-think.ts`)

High-token reasoning during idle time.

**4-Pass Analysis:**
1. **Strategic Planning** (3-5k tokens) - Long-term improvements
2. **System Optimization** (2-3k tokens) - Process efficiency
3. **Memory Consolidation** (2k tokens) - Pattern synthesis
4. **Risk Analysis** (2k tokens) - Dependency risks

**Triggers:**
- Active goals > 2
- Idle time > 5 minutes
- Token budget available

### 4. Goal Engine (`src/goal-engine.ts`)

Hierarchical goal decomposition.

**Decomposition Process:**
```
Complex Goal → Claude Analysis → Sub-Goals + Actions → Database Insert
```

**Auto-Trigger Keywords:**
build, create, develop, implement, design, set up, configure, integrate, migrate, refactor, launch, deploy, automate, optimize, establish

## Memory System

### Memory Types

| Type | Weight | Purpose |
|------|--------|---------|
| strategy | 2.5 | Long-term strategic directions |
| goal | 2.0 | Active objectives |
| action | 1.8 | Executable tasks |
| preference | 1.5 | User preferences |
| fact | 1.0 | Learned information |
| reflection | 0.8 | Insights and lessons |
| completed_goal | 0.3 | Historical achievements |
| reminder | 1.0 | Scheduled reminders |
| system_event | 1.0 | System logs |

### Status Values

| Status | Meaning |
|--------|---------|
| active | Currently relevant |
| pending | Queued for action |
| blocked | Waiting on dependency |
| completed | Finished |
| archived | Historical |

### Intent Tags

```typescript
// Memory Management
[REMEMBER: fact to store]
[FORGET: search text to remove]
[GOAL: objective | DEADLINE: 2026-03-01]
[DONE: search text to complete goal]
[ACTION: task | PRIORITY: 1-5]
[STRATEGY: strategic direction]
[REFLECTION: insight learned]
[BLOCKED: reason for blockage]

// Control
[CRON: schedule | prompt]
[VOICE_REPLY]
```

### Weighted Recall Formula

```
final_score = semantic_similarity × type_weight × recency_weight × priority_weight

where:
  recency_weight = exp(-days_since_created / 30)
  type_weight = { strategy: 2.5, goal: 2.0, action: 1.8, ... }
```

## Database Schema

### Tables

```sql
-- Core memory storage
global_memory (
  id UUID PRIMARY KEY,
  type TEXT,           -- fact/goal/action/strategy/reflection/...
  content TEXT,
  status TEXT,         -- active/pending/blocked/completed/archived
  priority INTEGER,
  deadline TIMESTAMPTZ,
  parent_id UUID,      -- Hierarchical relationships
  weight FLOAT,
  embedding VECTOR(1536),
  metadata JSONB,
  created_at TIMESTAMPTZ
)

-- Conversation threads
threads (
  id UUID PRIMARY KEY,
  telegram_chat_id BIGINT,
  telegram_thread_id BIGINT,
  claude_session_id TEXT,
  summary TEXT,
  message_count INTEGER
)

-- Scheduled jobs
cron_jobs (
  id UUID PRIMARY KEY,
  name TEXT,
  schedule TEXT,       -- cron/interval/once
  prompt TEXT,
  target_thread_id BIGINT,
  source TEXT,         -- user/agent/file
  enabled BOOLEAN,
  next_run_at TIMESTAMPTZ
)

-- Agent state
agent_loop_state (
  id UUID PRIMARY KEY,
  loop_type TEXT,
  status TEXT,         -- idle/running/paused/error
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  error_count INTEGER,
  config JSONB
)

-- Observability
logs_v2 (
  id UUID PRIMARY KEY,
  event TEXT,
  message TEXT,
  level TEXT,
  metadata JSONB,
  thread_id BIGINT
)
```

### Key RPCs

```sql
-- Agent state queries
get_pending_actions(limit INT)
get_active_goals_with_children()
get_strategies()
get_reflections(limit INT)
get_agent_state()

-- Memory operations
mark_action_completed(id UUID)
mark_action_blocked(id UUID, error TEXT)
complete_goal_cascade(goal_id UUID)
block_goal(goal_id UUID, reason TEXT)
decompose_goal(parent_id, type, content, priority)

-- Search
search_weighted_memory(embedding, threshold, limit)
match_memory(query_embedding, threshold, limit)
```

## Systemd Services

### claude-relay.service
Main Telegram relay service.

```bash
systemctl start claude-relay
systemctl status claude-relay
journalctl -u claude-relay -f
```

### claude-agent-loop.service
Autonomous agent loop.

```ini
[Service]
ExecStart=/home/radxa/.bun/bin/bun run src/agent-loop.ts
Environment=AGENT_LOOP_INTERVAL=180000
Restart=on-failure
```

### claude-deep-think.timer
Hourly strategic analysis.

```ini
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
```

## Search Architecture

### 3-Tier Fallback

1. **Semantic Search** (`embed-local.ts`)
   - OpenAI text-embedding-3-small
   - `match_memory()` RPC with vector similarity
   - Requires embeddings generated

2. **Text Search RPC**
   - PostgreSQL full-text search
   - `search_memory_text()` function
   - Works without embeddings

3. **ILIKE Fallback**
   - Simple pattern matching
   - Works without any index

## Security

### Execution Guards

- **Auth Gate**: Only `TELEGRAM_USER_ID` can interact
- **Rate Limiting**: 10 messages/minute/user
- **Path Sanitization**: Prevents traversal in uploads
- **Output Cap**: 1MB max before truncation
- **Memory Cap**: 200 chars per REMEMBER/GOAL/DONE entry
- **Dangerous Commands**: Confirmation required for rm -rf, git push --force, etc.

### Process Management

- **Orphan Cleanup**: `killOrphanedProcesses()` terminates zombie processes
- **Inactivity Timeout**: 15-minute limit on Claude CLI calls
- **Retry Logic**: Automatic session reset on expiry

## File Structure

```
claude-telegram-relay/
├── src/
│   ├── relay.ts          # Main Telegram relay
│   ├── agent-loop.ts     # Autonomous agent
│   ├── deep-think.ts     # Strategic reasoning
│   ├── goal-engine.ts    # Goal decomposition
│   ├── memory.ts         # Memory intent processing
│   ├── execution.ts      # Command execution
│   ├── embed-local.ts    # Local embeddings
│   ├── features.ts       # Advanced features
│   ├── metrics.ts        # Telemetry
│   ├── scheduler.ts      # Adaptive scheduling
│   └── cli.ts            # CLI interface
├── config/
│   ├── profile.md        # User profile
│   ├── system-core.md    # Core identity
│   ├── system-style.md   # Communication style
│   ├── system-projects.md # Project context
│   └── system-tools.md   # Available tools
├── daemon/
│   ├── claude-relay.service
│   ├── claude-agent-loop.service
│   ├── claude-deep-think.service
│   └── claude-deep-think.timer
├── supabase/
│   ├── functions/
│   │   ├── embed/        # Auto-embed on INSERT
│   │   └── search/       # Semantic search
│   └── migrations/       # Schema migrations
├── setup/                # Setup scripts
└── examples/             # Reference patterns
```

## Runtime State

All state in `~/.claude-relay/`:
- `bot.lock` - PID single-instance lock
- `agent-state.json` - Agent loop state
- `deep-think-state.json` - Deep think state
- `uploads/` - Temporary media downloads
- `temp/` - Whisper/TTS temp files
- `logs/` - Service logs

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=...
TELEGRAM_USER_ID=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...

# Optional - Voice
GROQ_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

# Optional - Agent
AGENT_LOOP_INTERVAL=180000
DEEP_THINK_IDLE_MINUTES=5
CLAUDE_PATH=/path/to/claude

# Optional - Migration
SUPABASE_DB_URL=postgresql://...
```

## Dependencies

| Package | Purpose |
|---------|---------|
| grammy ^1.37+ | Telegram Bot API |
| @supabase/supabase-js ^2.95+ | Database client |
| croner ^10+ | Cron parsing |
| Bun runtime | Process spawning |
| ffmpeg | Audio conversion |

## Metrics & Observability

### Tracked Metrics
- Token usage
- Cost estimates
- Action success rate
- Retry counts
- Execution time

### Log Events
- `heartbeat_tick/delivered/ok/error`
- `cron_created/executed/delivered/error`
- `schema_migration`
- `agent_event`

## Activation Checklist

1. [ ] Database connection verified
2. [ ] Schema migrations applied
3. [ ] OpenAI API key for embeddings
4. [ ] Groq API key for transcription
5. [ ] ElevenLabs API key for TTS
6. [ ] Edge Functions deployed (optional)
7. [ ] claude-relay.service running
8. [ ] claude-agent-loop.service running
9. [ ] claude-deep-think.timer enabled
