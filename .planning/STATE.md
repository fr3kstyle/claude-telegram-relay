# STATE.md

## Current Position

Phase: 6 - Schema & Infrastructure
Plan: .planning/phases/6/PLAN.md
Status: Complete
Last activity: 2026-02-12 -- Phase 6 executed (all 5 prompts)

**Progress:** [███░░░░░░░░░░░░░░░░░] 1/6 phases

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-12)

**Core value:** Proactive agent that checks in and schedules tasks without waiting for user input
**Current focus:** Milestone v1.1 -- Heartbeat & Proactive Agent

## Performance Metrics

**Milestone v1.1:**
- Phases: 6 total (Phase 6-11)
- Requirements: 24 total
- Coverage: 24/24 (100%)
- Completed: 1/6 phases
- Started: 2026-02-12

**Milestone 1 (archived):**
- Phases: 5 total (Phase 1-5)
- Status: Complete (2026-02-10)
- Delivered: Conversational threading, three-layer memory, voice I/O

## Accumulated Context

### From Milestone 1
- Relay architecture: single-file relay.ts (~730 lines), Bun runtime
- Threading: per-thread Claude sessions via --resume, stored in Supabase
- Memory: soul + global_memory + thread summary + recent messages
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY] parsed in processIntents()
- Voice: Groq Whisper transcription + ElevenLabs TTS
- Schema: threads, thread_messages, global_memory, bot_soul, logs_v2 tables

### From OpenClaw Research
- Heartbeat: periodic agent turns with HEARTBEAT.md checklist, HEARTBEAT_OK suppression
- Cron: croner library for 5-field expressions, isolated sessions per job
- Active hours: timezone-aware gating, configurable start/end
- Deduplication: identical heartbeat messages suppressed within 24h window
- Agent scheduling: [CRON: ...] intent allows Claude to create its own jobs

### Key Decisions for v1.1
- Dedicated heartbeat thread in Telegram group (keeps proactive messages separate)
- 1h default heartbeat interval (balance responsiveness vs API cost)
- croner library for cron expressions (same as OpenClaw, 5-field + timezone support)
- Both Telegram commands + HEARTBEAT.md file for cron management (phone + power user access)
- Agent can self-schedule via [CRON: ...] intent (true proactivity)

## Session Continuity

**Next action:** Run `/gsd:plan-phase 7` to plan Heartbeat Core (or Phase 9 Cron Engine in parallel)

**Context for next session:**
- Phase 6 complete: cron_jobs + heartbeat_config tables created, migration applied to Supabase
- Supabase helpers added to relay.ts (getHeartbeatConfig, getEnabledCronJobs, updateCronJobLastRun, disableCronJob)
- Heartbeat timer skeleton wired into relay lifecycle (starts on boot, stops on shutdown)
- Heartbeat & cron event logging via logEventV2()
- Next phases: 7 (Heartbeat Core) and 9 (Cron Engine) can be planned/executed in parallel

---

*Created: 2026-02-12*
*Last updated: 2026-02-12 after Phase 6 execution*
