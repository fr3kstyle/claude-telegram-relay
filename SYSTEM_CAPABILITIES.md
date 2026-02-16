# Claude Telegram Relay v2.0 - Complete System Capabilities

## 🤖 CORE IDENTITY

Autonomous AI operator running on Linux with dual-loop architecture:
- **Loop A (Reactive)**: Telegram-triggered responses
- **Loop B (Autonomous)**: Background agent running continuously

---

## 📁 SOURCE MODULES (src/)

| File | Purpose | Key Features |
|------|---------|--------------|
| `relay.ts` | Main Telegram relay | Threading, voice, streaming, memory |
| `agent-loop.ts` | Autonomous agent | 3-min cycles, sub-agents, self-healing |
| `deep-think.ts` | High-token reasoning | 4 passes: Strategic, Optimization, Memory, Risk |
| `goal-engine.ts` | Goal decomposition | Hierarchical sub-goals, auto-actions |
| `memory.ts` | Memory management | 9 memory types, weighted recall |
| `execution.ts` | Command execution | Security guards, retry logic |
| `embed-local.ts` | Local embeddings | OpenAI API, bypasses Edge Functions |
| `features.ts` | Advanced features | Focus mode, business automation, nightly consolidation |
| `metrics.ts` | Telemetry | Token usage, success rates, weekly reports |
| `scheduler.ts` | Adaptive scheduling | Work-pattern aware intervals |
| `cli.ts` | Multi-channel CLI | Unified brain interface |

---

## 🏷️ MEMORY TAGS

### Available Tags
```
[REMEMBER: fact]                    Store a fact
[FORGET: search]                    Delete matching memory
[GOAL: objective | DEADLINE: date]  Set a goal
[DONE: search]                      Mark goal complete
[ACTION: task | PRIORITY: 1-5]      Create action
[STRATEGY: direction]               Record strategy
[REFLECTION: insight]               Store reflection
[BLOCKED: reason]                   Flag obstacle
[CRON: schedule | prompt]           Schedule task
[VOICE_REPLY]                       Trigger TTS response
```

### Memory Types
- `fact` - Learned information
- `goal` - Active objectives
- `completed_goal` - Achieved goals
- `preference` - User preferences
- `action` - Executable tasks
- `strategy` - Strategic directions
- `reflection` - Insights and lessons
- `system_event` - System logs
- `reminder` - Scheduled reminders

### Status Values
- `active` - Currently relevant
- `pending` - Queued for action
- `blocked` - Waiting on dependency
- `completed` - Finished
- `archived` - Historical

---

## 🔄 AUTONOMOUS AGENT LOOP

### Cycle Frequency
- Default: Every 3 minutes
- Adaptive: Based on work patterns and action count

### Cycle Tasks
1. Fetch active goals and pending actions
2. Execute priority actions (max 3 per cycle)
3. Decompose complex goals without sub-tasks
4. Generate reflections on activity
5. Retry blocked items ready for healing

### Sub-Agent Types
- **Research Agent**: Information gathering
- **Implementation Agent**: Code execution
- **Refactor Agent**: Code improvement
- **Audit Agent**: Security and quality review

---

## 🧠 DEEP THINK ENGINE

### Triggers
- Active goals > 2
- Idle time > 5 minutes
- Token budget available

### 4-Pass Analysis
1. **Strategic Planning** (3-5k tokens)
   - Structural improvements
   - Automation opportunities
   - Risk mitigation
   - Revenue opportunities

2. **System Optimization** (2-3k tokens)
   - Memory efficiency
   - Action pipeline
   - Process improvements

3. **Memory Consolidation** (2k tokens)
   - Pattern synthesis
   - Insight extraction
   - Theme detection

4. **Risk Analysis** (2k tokens)
   - Goal risks
   - Dependencies
   - External factors

---

## 📊 WEIGHTED MEMORY RECALL

### Type Weights
| Type | Weight |
|------|--------|
| strategy | 2.5 |
| goal | 2.0 |
| action | 1.8 |
| preference | 1.5 |
| fact | 1.0 |
| reflection | 0.8 |
| completed_goal | 0.3 |

### Recency Decay
- Exponential half-life: 30 days

### Final Score Formula
```
final_score = semantic_similarity × type_weight × recency_weight × priority_weight
```

---

## ⏰ SCHEDULING

### CRON Formats
- **Cron expression**: `0 9 * * *` (daily at 9am)
- **Interval**: `every 2h` or `every 30m`
- **One-shot**: `in 20m` or `in 1h`

### Adaptive Scheduling
- **High Focus Mode** (8am-12pm): Aggressive, 2-5 min intervals
- **Execution Mode** (1pm-6pm): Normal, 15-30 min intervals
- **Low Cognitive** (after 9pm): Minimal, 1-2 hour intervals

### Nightly Consolidation (2am)
- Summarize day's activity
- Archive completed goals
- Detect recurring themes
- Suggest system upgrades

---

## 🔒 SECURITY

### Dangerous Commands (Require Confirmation)
- `rm -rf`
- `git push --force`
- `systemctl stop`
- Database drops

### Execution Guards
- Command validation
- Retry limit (3 attempts)
- Self-healing on failure
- Error logging and reflection

---

## 📈 METRICS & TELEMETRY

### Tracked Metrics
- Token usage
- Cost estimates
- Action success rate
- Retry counts
- Execution time

### Reports
- Daily summary in logs
- Weekly performance report (auto-generated)

---

## 🎯 GOAL ENGINE

### Auto-Decomposition Triggers
Keywords: build, create, develop, implement, design, set up, configure, integrate, migrate, refactor, launch, deploy, automate, optimize, establish

### Hierarchy
```
Goal
├── Sub-Goal 1
│   ├── Action 1.1
│   └── Action 1.2
├── Sub-Goal 2
│   └── Action 2.1
└── Action (direct)
```

---

## 🔍 SEARCH ARCHITECTURE

### 3-Tier Fallback
1. **Semantic Search** (via embed-local.ts)
   - OpenAI embeddings
   - match_memory RPC
   - Cosine similarity

2. **Text Search RPC**
   - search_memory_text function
   - PostgreSQL full-text search

3. **ILIKE Fallback**
   - Simple pattern matching
   - Works without any index

---

## 🚀 COMMANDS

```bash
# Main relay
bun start              # Start Telegram relay
bun dev                # Development mode with watch

# Autonomous agents
bun agent              # Start autonomous agent loop
bun deep-think         # Run deep reasoning pass
bun goal-engine        # Decompose complex goals

# Utilities
bun cli                # Multi-channel CLI interface
bun test:supabase      # Test database connection
bun test:semantic      # Test semantic search
bun migrate            # Copy migrations for deployment

# Embedding management
bun src/embed-local.ts backfill    # Backfill embeddings
bun src/embed-local.ts test "query"  # Test search
```

---

## 📁 CONFIGURATION FILES (config/)

| File | Purpose |
|------|---------|
| `profile.md` | User profile, timezone, work patterns |
| `system-core.md` | Core identity and responsibilities |
| `system-style.md` | Communication style preferences |
| `system-projects.md` | Project context |
| `system-tools.md` | Available tools and capabilities |

---

## 🗄️ DATABASE SCHEMA

### Tables
- `memory` - Agent memory (new)
- `global_memory` - Legacy memory with embeddings
- `threads` - Conversation threads
- `thread_messages` - Per-thread history
- `cron_jobs` - Scheduled tasks
- `heartbeat_config` - Heartbeat settings
- `agent_loop_state` - Agent state tracking
- `logs_v2` - System event logs
- `bot_soul` - Personality definitions

### Key RPCs
- `get_facts()` - All fact-type memories
- `get_active_goals()` - Active goals
- `get_active_goals_with_children()` - Hierarchical goals
- `get_pending_actions()` - Actions queue
- `get_strategies()` - Strategic directions
- `match_memory()` - Vector similarity search
- `match_memory_unified()` - Cross-table search
- `complete_goal_cascade()` - Complete goal + children
- `block_goal()` - Mark goal blocked

---

## ✅ VERIFICATION CHECKLIST

- [x] Database connection working
- [x] 21 memories in memory table
- [x] 14 memories in global_memory
- [x] 11 embeddings generated
- [x] All RPC functions working
- [x] Semantic search functional
- [x] OpenAI API key configured
- [x] Groq API key configured
- [ ] Edge Functions deployed (optional)
- [ ] Agent loop running in background
- [ ] Deep-think scheduled

