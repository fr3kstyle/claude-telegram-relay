# Claude Telegram Relay - Complete Capabilities Documentation

> A comprehensive reference of ALL features, systems, integrations, and capabilities of this autonomous multi-agent system.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Core Agents](#core-agents)
3. [Memory Systems](#memory-systems)
4. [Communication Layer](#communication-layer)
5. [Intent System](#intent-system)
6. [External Integrations](#external-integrations)
7. [Voice & Audio](#voice--audio)
8. [Scheduling & Automation](#scheduling--automation)
9. [Database Schema](#database-schema)
10. [Security Features](#security-features)
11. [Self-Improvement](#self-improvement)
12. [Environment Variables](#environment-variables)
13. [Commands Reference](#commands-reference)
14. [APIs & External Services](#apis--external-services)
15. [Proactive Capabilities](#proactive-capabilities)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLAUDE TELEGRAM RELAY SYSTEM                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │ claude-relay│    │ agent-loop  │    │ deep-think  │    │ goal-engine │ │
│  │   (Main)    │    │ (Autonomous)│    │  (Reasoning)│    │ (Decompose) │ │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘ │
│         │                  │                  │                  │         │
│         └──────────────────┴──────────────────┴──────────────────┘         │
│                                    │                                        │
│                         ┌──────────┴──────────┐                             │
│                         │    Supabase DB      │                             │
│                         │  - Memory           │                             │
│                         │  - Threads          │                             │
│                         │  - Cron Jobs        │                             │
│                         │  - Logs             │                             │
│                         └──────────┬──────────┘                             │
│                                    │                                        │
│    ┌───────────┐  ┌───────────┐  ┌┴───────────┐  ┌───────────┐            │
│    │  Telegram │  │   Google  │  │   Groq     │  │ ElevenLabs│            │
│    │    Bot    │  │   APIs    │  │  Whisper   │  │    TTS    │            │
│    └───────────┘  └───────────┘  └────────────┘  └───────────┘            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Agents

### 1. claude-relay (Main Bot)
**File:** `src/relay.ts` (144KB)

The primary Telegram bot interface that handles:
- All message types (text, voice, photos, documents)
- Session management with Claude CLI
- Memory operations and intent processing
- Heartbeat and cron scheduling
- Voice transcription and TTS
- Thread-based conversations

**Key Capabilities:**
- Long-polling Telegram updates via Grammy
- Claude CLI integration with session persistence
- Real-time streaming with liveness indicators
- Multi-threaded conversations
- Circuit breakers for external APIs
- Rate limiting and security guards

### 2. agent-loop (Autonomous Agent)
**File:** `src/agent-loop.ts` (28KB)

Self-directed agent that runs continuously:
- **Interval:** 3 minutes (configurable via `AGENT_LOOP_INTERVAL`)
- **Alert Rate Limit:** 30 minutes between Telegram notifications
- **Purpose:** Proactive task execution, goal management, system monitoring

**Agent Cycle Tasks:**
1. Fetches current goals, actions, strategies, reflections
2. Builds comprehensive context prompt
3. Executes Claude with autonomous prompt
4. Parses intents (ACTION, GOAL, STRATEGY, REFLECTION, BLOCKED, DONE, REMEMBER)
5. Sends Telegram alerts for important events

### 3. deep-think (High-Token Reasoning)
**File:** `src/deep-think.ts` (13KB)

Deep reasoning engine for complex analysis:
- **Trigger:** Requires 2+ active goals
- **Purpose:** Strategic planning, complex problem decomposition
- **Output:** Creates strategies and reflections

### 4. goal-engine (Goal Decomposition)
**File:** `src/goal-engine.ts` (10KB)

Decomposes complex goals into actionable sub-tasks:
- Analyzes goal complexity
- Creates child actions with priorities
- Maintains goal hierarchy

---

## Memory Systems

### Layer 1: Bot Soul
**Table:** `bot_soul`
**Purpose:** Personality and behavior instructions loaded into every prompt

```sql
bot_soul (
  id uuid PRIMARY KEY,
  content text,           -- Personality instructions
  is_active boolean,      -- Only one active at a time
  created_at timestamptz
)
```

### Layer 2: Global Memory (Typed)
**Table:** `global_memory` / `memory`
**Types:** fact, goal, preference, strategy, action, reflection, completed_goal, system_event

```sql
memory (
  id uuid PRIMARY KEY,
  content text,
  type text,              -- fact/goal/action/strategy/reflection/etc
  status text,            -- active/completed/blocked
  priority integer,
  deadline timestamptz,
  parent_id uuid,         -- For goal hierarchy
  weight float,           -- Importance weighting
  metadata jsonb,         -- Flexible additional data
  embedding vector(1536), -- OpenAI embeddings
  search_vector tsvector, -- Full-text search
  retry_count integer,
  last_error text
)
```

### Layer 3: Semantic Memory
**Mechanism:** Vector similarity search via OpenAI embeddings
**RPC Functions:**
- `match_memory(query_embedding, match_threshold, match_count)`
- `search_memory_text(query_text, match_count)`
- `hybrid_search(query_text, match_count)` - Combines semantic + text

### Layer 4: Thread Context
**Tables:** `threads`, `thread_messages`

```sql
threads (
  id uuid PRIMARY KEY,
  telegram_chat_id bigint,
  telegram_thread_id bigint,
  claude_session_id text,
  summary text,
  message_count integer,
  last_message_at timestamptz
)

thread_messages (
  id uuid PRIMARY KEY,
  thread_id uuid,
  role text,              -- user/assistant
  content text,
  created_at timestamptz
)
```

---

## Communication Layer

### Telegram Integration
**Framework:** Grammy v1.37+
**Features:**
- Long-polling message updates
- Native thread/topic support
- Typing indicators (every 4s)
- Progress messages (every 15s)
- Voice message handling
- Photo/document processing

### Thread Model
- **DMs:** Single conversation per user
- **Groups with Topics:** One conversation per topic
- **Groups without Topics:** Single shared conversation
- **Session Persistence:** Per-thread Claude session via `--resume`

---

## Intent System

Claude can include special tags in responses that trigger actions:

| Tag | Syntax | Action |
|-----|--------|--------|
| REMEMBER | `[REMEMBER: fact text]` | Store as fact in memory |
| GOAL | `[GOAL: goal text]` | Create new goal |
| GOAL+DEADLINE | `[GOAL: text \| DEADLINE: date]` | Goal with deadline |
| DONE | `[DONE: search text]` | Mark matching goal complete |
| FORGET | `[FORGET: search text]` | Delete matching memory |
| VOICE_REPLY | `[VOICE_REPLY]` | Respond with TTS audio |
| CRON | `[CRON: schedule \| prompt]` | Create scheduled job |
| ACTION | `[ACTION: task \| PRIORITY: 1-5]` | Create action item |
| STRATEGY | `[STRATEGY: direction]` | Record strategy |
| REFLECTION | `[REFLECTION: insight]` | Store lesson learned |
| BLOCKED | `[BLOCKED: reason]` | Mark item as blocked |

---

## External Integrations

### Google Services (OAuth 2.0)
**File:** `src/google-oauth.ts`, `src/google-apis.ts`

**Supported APIs:**
- **Gmail:** Read, send, search, archive, drafts
- **Calendar:** List, create, delete events
- **Drive:** List, search, download, create files

**OAuth Flow:**
```bash
bun run src/google-oauth.ts setup    # Generate auth URLs
bun run src/google-oauth.ts token <email> <code>  # Exchange code
bun run src/google-oauth.ts list      # Show authorized accounts
```

**Token Storage:** `~/.claude-relay/google-tokens/`

### Microsoft Services (OAuth 2.0)
**File:** `src/microsoft-oauth.ts`, `src/email/outlook-provider.ts`

**Supported APIs:**
- Outlook Mail (via Microsoft Graph)
- OneDrive
- Calendar

### Email Provider Abstraction
**File:** `src/email/provider-factory.ts`

**Supported Providers:**
- Gmail (via Google OAuth)
- Outlook (via Microsoft OAuth)
- IMAP (extensible)
- SMTP (extensible)

**Capabilities:**
- Unified interface across providers
- Auto-discovery of accounts
- Provider-specific feature detection

---

## Voice & Audio

### Speech-to-Text (Transcription)
**Provider:** Groq Whisper API
**Model:** `whisper-large-v3-turbo`
**Features:**
- Auto language detection
- .oga → .wav conversion via ffmpeg
- Rate limiting with circuit breaker

### Text-to-Speech
**Primary Provider:** ElevenLabs v3
**Fallback Provider:** Edge TTS
**Configuration:**
```env
TTS_PROVIDER=elevenlabs          # or "edge"
ELEVENLABS_API_KEY=sk_xxx
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
EDGE_TTS_VOICE=en-US-AriaNeural
EDGE_TTS_SPEED=1.3
```

### Voice Reply Logic
| Input Type | Tag Present | Response |
|------------|-------------|----------|
| Voice message | N/A | Voice + Text |
| Text message | `[VOICE_REPLY]` | Voice + Text |
| Text message | None | Text only |

---

## Scheduling & Automation

### Heartbeat System
**Interval:** 60 minutes (configurable)
**Active Hours:** Configurable window (default 08:00-22:00)
**Purpose:** Periodic check-in with proactive messaging

**Heartbeat Cycle:**
1. Check active hours
2. Read `HEARTBEAT.md` checklist
3. Call Claude with checklist context
4. Parse response for intents
5. Deliver to dedicated thread or DM

**Suppression:** Response contains `HEARTBEAT_OK` → message suppressed

### Cron Scheduler
**Check Interval:** 10 minutes (configurable)
**Schedule Types:**
- **Cron:** `0 7 * * *` (5-field expressions)
- **Interval:** `every 2h`, `every 1d`, `every 7d`
- **Once:** `in 20m`, `in 2h`

**Table:** `cron_jobs`
```sql
cron_jobs (
  id uuid PRIMARY KEY,
  name text,
  schedule text,
  schedule_type text,     -- cron/interval/once
  prompt text,
  target_thread_id uuid,
  source text,            -- user/agent/file
  enabled boolean,
  next_run_at timestamptz,
  last_run_at timestamptz
)
```

**Commands:**
```
/cron list                     - Show all jobs
/cron add "every 2h" "prompt"  - Create job
/cron add "0 9 * * *" "prompt" - Cron expression
/cron remove <number>          - Delete job
/cron enable <number>          - Enable job
/cron disable <number>         - Disable job
```

---

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `threads` | Conversation sessions |
| `thread_messages` | Message history |
| `memory` / `global_memory` | Typed memory entries |
| `bot_soul` | Personality definitions |
| `logs_v2` | System event logs |
| `cron_jobs` | Scheduled tasks |
| `heartbeat_config` | Heartbeat settings |
| `email_accounts` | OAuth email accounts |
| `agent_loop_state` | Agent execution state |

### RPC Functions

| Function | Purpose |
|----------|---------|
| `get_facts()` | Retrieve all facts |
| `match_memory()` | Semantic search via embeddings |
| `search_memory_text()` | Full-text search fallback |
| `hybrid_search()` | Combined semantic + text search |
| `log_system_event()` | Structured event logging |
| `run_goal_hygiene()` | Clean up orphan goals |
| `get_agent_context()` | Fetch agent context |

---

## Security Features

### Authentication
- **User Gate:** Only `TELEGRAM_USER_ID` can interact
- **Silent Rejection:** Unauthorized users get no response

### Rate Limiting
- **Limit:** 10 messages per minute per user
- **Circuit Breakers:** For Groq, ElevenLabs APIs

### Guards
- **Output Size Cap:** 3MB max Claude output
- **Memory Length Cap:** 200 chars for REMEMBER/GOAL/FORGET
- **Filename Sanitization:** Prevents path traversal

### Single Instance Lock
- PID-based lock file: `~/.claude-relay/bot.lock`
- Prevents multiple bot instances

---

## Self-Improvement

### Experience Replay
**File:** `src/experience-replay.ts`
**Purpose:** Learn from past successes/failures

### Reflexion
**File:** `src/reflexion.ts`
**Purpose:** Self-critique and improvement suggestions

### Auto-Improve
**File:** `src/auto-improve.ts`
**Purpose:** Automated code improvements

### Self-Improve System
**File:** `src/self-improve.ts`
**Tables:** `improvement_suggestions`, `applied_improvements`

---

## Environment Variables

### Required
```env
TELEGRAM_BOT_TOKEN=xxx           # From @BotFather
TELEGRAM_USER_ID=123456789        # From @userinfobot
```

### Supabase
```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=xxx          # Service role key
```

### Voice & Audio
```env
GROQ_API_KEY=xxx                  # Whisper transcription
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
FFMPEG_PATH=/usr/bin/ffmpeg
ELEVENLABS_API_KEY=xxx
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
TTS_PROVIDER=elevenlabs
EDGE_TTS_VOICE=en-US-AriaNeural
EDGE_TTS_SPEED=1.3
```

### Agent Configuration
```env
AGENT_LOOP_INTERVAL=180000        # 3 minutes
AGENT_ALERT_INTERVAL=1800000      # 30 minutes
CLAUDE_PATH=/usr/bin/claude
PROJECT_DIR=/home/radxa
```

### Integrations
```env
BRAVE_API_KEY=xxx                 # Brave Search
OPENAI_API_KEY=xxx                # Embeddings
```

---

## Commands Reference

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/soul <text>` | Set bot personality |
| `/new` | Reset Claude session for thread |
| `/memory` | Show facts and goals |
| `/stop` | Emergency stop all operations |
| `/cron list` | Show scheduled jobs |
| `/cron add "<schedule>" <prompt>` | Create job |
| `/cron remove <number>` | Delete job |
| `/cron enable/disable <number>` | Toggle job |

### CLI Commands

```bash
bun run start          # Run relay
bun run dev            # Development mode
bun run setup          # Interactive setup
bun run setup:verify   # Verify configuration
bun run test:telegram  # Test Telegram connection
bun run test:supabase  # Test Supabase connection
```

### OAuth Setup

```bash
# Google OAuth
bun run src/google-oauth.ts setup
bun run src/google-oauth.ts url Fr3kchy@gmail.com
bun run src/google-oauth.ts token email code
bun run src/google-oauth.ts list

# Microsoft OAuth
bun run src/microsoft-oauth.ts setup
```

---

## APIs & External Services

### Telegram Bot API
- **Library:** Grammy
- **Features:** Long-polling, threads, typing indicators

### Claude CLI
- **Integration:** Spawn process with `--resume` for sessions
- **Output Format:** NDJSON stream
- **Timeout:** 15 minute inactivity guard

### Groq API
- **Purpose:** Whisper voice transcription
- **Circuit Breaker:** 3 failures → 1 minute reset

### ElevenLabs API
- **Purpose:** Text-to-speech
- **Model:** eleven_v3
- **Max Chars:** 4500 per request

### OpenAI API
- **Purpose:** Text embeddings (semantic search)
- **Model:** text-embedding-3-small

### Brave Search API
- **Purpose:** Web search capability
- **Integration:** Via BRAVE_API_KEY

---

## Proactive Capabilities

### Autonomous Agent Actions
The agent-loop can autonomously:
1. **Execute Shell Commands** - Run any CLI command
2. **Manage Goals** - Create, decompose, complete goals
3. **Store Memories** - Remember facts, lessons, strategies
4. **Send Alerts** - Notify via Telegram (rate-limited)
5. **Self-Reflect** - Analyze performance and improve

### Scheduled Automation
- Periodic heartbeat check-ins
- Cron-based task execution
- One-time delayed tasks
- File-based job definitions (HEARTBEAT.md)

### Email Automation
- Read unread emails
- Search email archives
- Send emails
- Manage drafts
- Archive messages

### Calendar Management
- List upcoming events
- Create new events
- Delete events
- Search events

### File Management (Google Drive)
- List files
- Search by name/content
- Download files
- Create new files

---

## File Structure

```
claude-telegram-relay/
├── src/
│   ├── relay.ts              # Main bot (144KB)
│   ├── agent-loop.ts         # Autonomous agent
│   ├── deep-think.ts         # Reasoning engine
│   ├── goal-engine.ts        # Goal decomposition
│   ├── google-oauth.ts       # Google OAuth
│   ├── google-apis.ts        # Gmail/Calendar/Drive
│   ├── microsoft-oauth.ts    # Microsoft OAuth
│   ├── email-sync.ts         # Email synchronization
│   ├── memory.ts             # Memory operations
│   ├── metrics.ts            # System metrics
│   ├── scheduler.ts          # Task scheduling
│   ├── self-improve.ts       # Self-improvement
│   ├── reflexion.ts          # Self-reflection
│   ├── experience-replay.ts  # Learning from experience
│   ├── auto-improve.ts       # Auto-improvements
│   ├── cli.ts                # CLI interface
│   ├── features.ts           # Feature flags
│   ├── execution.ts          # Execution management
│   ├── embed-local.ts        # Local embeddings
│   ├── email/
│   │   ├── gmail-provider.ts
│   │   ├── outlook-provider.ts
│   │   ├── provider-factory.ts
│   │   ├── email-context.ts
│   │   ├── validation.ts
│   │   ├── types.ts
│   │   └── index.ts
│   └── auth/
│       ├── token-manager.ts
│       ├── token-refresh-scheduler.ts
│       └── index.ts
├── supabase/
│   ├── migrations/           # Schema migrations
│   └── functions/            # Edge functions
├── ecosystem.config.cjs      # PM2 config
├── CLAUDE.md                 # Claude Code guidance
├── HEARTBEAT.md              # Heartbeat checklist
├── CAPABILITIES.md           # This file
└── .env                      # Environment config
```

---

## Runtime State

All state lives in `~/.claude-relay/`:

| Path | Purpose |
|------|---------|
| `bot.lock` | Single-instance lock (PID) |
| `uploads/` | Temporary media downloads |
| `temp/` | Whisper/TTS temp files |
| `google-tokens/` | OAuth tokens |
| `agent-state.json` | Agent loop state |

---

## PM2 Services

| Service | Script | Purpose |
|---------|--------|---------|
| claude-relay | relay.ts | Main Telegram bot |
| agent-loop | agent-loop.ts | Autonomous agent |
| deep-think | deep-think.ts | Deep reasoning |
| goal-engine | goal-engine.ts | Goal decomposition |

**Management:**
```bash
pm2 start ecosystem.config.cjs
pm2 logs claude-relay
pm2 restart all
pm2 save
```

---

## Monitoring & Observability

### Logs Table
```sql
logs_v2 (
  event text,           -- Event type
  message text,
  metadata jsonb,
  thread_id uuid,
  created_at timestamptz
)
```

### Event Types
- `heartbeat_tick`, `heartbeat_ok`, `heartbeat_delivered`
- `cron_created`, `cron_executed`, `cron_error`
- `emergency_stop`
- `agent_cycle`, `agent_alert`

### Console Logging
- Structured JSON for errors
- `[Component]` prefixes for filtering
- Liveness event streaming

---

## Extensibility

### Adding New Email Providers
1. Create provider in `src/email/xxx-provider.ts`
2. Implement `EmailProvider` interface
3. Register in `provider-factory.ts`
4. Add OAuth handler if needed

### Adding New Intent Tags
1. Add regex pattern in `processIntents()`
2. Implement handler function
3. Update documentation

### Adding New APIs
1. Create OAuth handler in `src/xxx-oauth.ts`
2. Create API wrapper in `src/xxx-apis.ts`
3. Add to context in `buildPrompt()`

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Max Claude Output | 3MB |
| Max Memory Entry | 200 chars |
| Rate Limit | 10 msg/min |
| Agent Interval | 3 minutes |
| Alert Rate Limit | 30 minutes |
| Cron Check | 10 minutes |
| Typing Indicator | 4 seconds |
| Progress Update | 15 seconds |

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| "Another instance running" | Delete `~/.claude-relay/bot.lock` |
| 409 Conflict | Kill duplicate relay processes |
| Memory ops failed | Check Supabase connection |
| TTS not working | Verify ElevenLabs API key |
| Voice transcription fails | Check ffmpeg path |

### Log Commands
```bash
pm2 logs claude-relay --lines 50
journalctl -u pm2-radxa -f
tail -f ~/.pm2/logs/claude-relay-error.log
```

---

## Version History

| Version | Changes |
|---------|---------|
| v1.0 | Basic relay functionality |
| v2.0 | Supabase integration, typed memory |
| v2.1 | Heartbeat, cron scheduling |
| v2.2 | File-based cron definitions |
| v2.3 | Vector embeddings, semantic search |
| v3.0 | Autonomous agent system |
| v3.1 | Google OAuth integration |
| v3.2 | Email provider abstraction |
| v3.3 | Self-improvement systems |

---

*Last Updated: February 2026*
*System: Claude Telegram Relay v3.3*
