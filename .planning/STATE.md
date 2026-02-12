# STATE.md

## Current Position

Phase: Not started (defining requirements)
Plan: --
Status: Defining requirements
Last activity: 2026-02-12 -- Milestone v1.1 started

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-12)

**Core value:** Proactive agent that checks in and schedules tasks without waiting for user input
**Current focus:** Milestone v1.1 -- Heartbeat & Proactive Agent

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
