# PROJECT.md

## Project: Claude Telegram Relay

**Description:** A relay that bridges Telegram to the Claude Code CLI with persistent memory, voice I/O, proactive agent capabilities, and unrestricted permissions.

**Tech Stack:** Bun runtime, TypeScript, Grammy (Telegram Bot), Supabase (PostgreSQL), Claude CLI, Groq Whisper, ElevenLabs TTS, croner (cron scheduling)

**Architecture:** Single-file relay (`src/relay.ts` ~730 lines). Message flow: Telegram -> Grammy handler -> buildPrompt() -> callClaude() via Bun.spawn -> processIntents() -> response back to Telegram.

## Requirements

### Validated

<!-- Shipped and confirmed valuable (Milestone 1). -->

- Telegram group threads as parallel conversation channels
- True Claude CLI conversation continuity via --resume per thread
- Three-layer memory: recent messages, thread summary, global memory
- Bot "soul" (personality) loaded in every interaction
- Supabase v2 schema (threads, global_memory, bot_soul, logs_v2)
- Voice transcription (Groq Whisper) and TTS (ElevenLabs)
- DM + supergroup Topics support
- Intent system: [LEARN:], [FORGET:], [VOICE_REPLY]

### Active

<!-- Current scope: Milestone v1.1 -->

- Heartbeat system: periodic agent loop with HEARTBEAT.md checklist
- Active hours: timezone-aware window for heartbeat (no night pings)
- Dedicated heartbeat thread in Telegram group
- Smart suppression: HEARTBEAT_OK silencing + deduplication
- Cron system: scheduled jobs stored in Supabase
- Cron management via Telegram commands (/cron add, list, remove)
- Cron management via HEARTBEAT.md file
- Agent self-scheduling via [CRON: ...] intent tag
- Cron job delivery to appropriate threads

### Out of Scope

- Multi-user support (still single authorized user) -- complexity, not needed
- Web dashboard -- overkill for single-user
- Semantic/vector search on messages -- premature optimization
- Multi-channel support (WhatsApp, Slack, etc.) -- Telegram-only by design
- Webhook-triggered heartbeats -- no inbound webhook infrastructure

## Context

- Inspired by OpenClaw (github.com/openclaw/openclaw) heartbeat and cron systems
- OpenClaw uses a gateway architecture with 13+ channels; we stay lightweight single-file
- Key adaptations: HEARTBEAT.md checklist, HEARTBEAT_OK suppression, active hours, croner library
- Our relay spawns Claude CLI processes; OpenClaw uses embedded Pi agent RPC

## Constraints

- **Runtime**: Bun -- all scheduling must work with Bun's timer APIs
- **Architecture**: Single-file relay -- heartbeat and cron integrate into relay.ts
- **State**: Supabase -- cron jobs and heartbeat config stored in cloud DB
- **Cost**: Claude API calls per heartbeat -- default 1h interval to manage cost

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dedicated heartbeat thread | Keeps proactive messages separate from conversations | -- Pending |
| 1h default heartbeat interval | Balance responsiveness vs API cost | -- Pending |
| Agent can self-schedule cron | Makes the assistant truly proactive (reminders, follow-ups) | -- Pending |
| croner for cron expressions | Same library OpenClaw uses, 5-field cron + timezone support | -- Pending |
| Both Telegram commands + file config for cron | Accessibility from phone + power user file editing | -- Pending |

---

## Milestone 1: Conversational Threading & Memory System

**Goal:** Transform the bot from one-off request/response into a full conversation system.
**Status:** Complete (5 phases, shipped 2026-02-10)

---

## Current Milestone: v1.1 Heartbeat & Proactive Agent

**Goal:** Make the bot proactive -- periodic check-ins via heartbeat and precise scheduled tasks via cron, inspired by OpenClaw's dual proactive system.

**Target features:**
- Heartbeat loop: periodic Claude calls with HEARTBEAT.md checklist, smart suppression, active hours
- Cron scheduler: 5-field cron expressions, one-shot timers, interval-based jobs
- Telegram cron commands: /cron add, /cron list, /cron remove
- Agent self-scheduling: [CRON: ...] intent tag for Claude to create its own reminders
- Dedicated heartbeat thread in Telegram group

**Started:** 2026-02-12

---
*Last updated: 2026-02-12 after Milestone v1.1 started*
