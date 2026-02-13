---
phase: 15-intent-system-upgrade
plan: 01
subsystem: intent-system
tags: [intents, memory, goals, relay]
dependency_graph:
  requires: ["14-01"]
  provides: ["REMEMBER intent", "GOAL intent", "DONE intent", "renamed memory functions", "goals in prompt context"]
  affects: ["src/relay.ts"]
tech_stack:
  patterns: ["RPC-based memory queries", "typed memory insertion", "goal lifecycle management"]
key_files:
  modified:
    - src/relay.ts
decisions:
  - "Used Supabase RPC functions (get_facts, get_active_goals) instead of direct table queries for type filtering"
  - "GOAL deadline parsing uses Date constructor with validation — invalid dates are warned but not rejected"
  - "Processing order: REMEMBER > GOAL > DONE > FORGET > CRON (goals created before they can be completed in same response)"
metrics:
  duration: "~3 minutes"
  completed: "2026-02-13"
  tasks: 4
  files: 1
---

# Phase 15 Plan 01: Intent System Upgrade Summary

**One-liner:** Replaced [LEARN:] with [REMEMBER:], added [GOAL:]/[DONE:] intent lifecycle, renamed all memory helper functions to use RPC-based typed queries.

## What Was Done

### Task 1: Rename and update Supabase memory helper functions
- Renamed `getGlobalMemory()` to `getMemoryContext()` — now calls `get_facts()` RPC instead of direct table query
- Renamed `insertGlobalMemory()` to `insertMemory()` — added `type`, `deadline`, and `priority` parameters
- Renamed `deleteGlobalMemory()` to `deleteMemory()` — same logic, cleaner name
- Added `getActiveGoals()` — calls `get_active_goals()` RPC, returns content/deadline/priority
- Added `completeGoal()` — finds matching goal by search text, updates type to `completed_goal` with `completed_at` timestamp
- Updated all 6 call sites across cron prompt builder, heartbeat prompt builder, /memory command, and main buildPrompt

### Task 2: Update processIntents() with new intent tags
- Replaced `[LEARN:]` regex with `[REMEMBER:]` — calls `insertMemory(fact, "fact", threadDbId)`
- Added `[GOAL:]` intent parsing — supports both `[GOAL: text]` and `[GOAL: text | DEADLINE: date]` variants
- Added `[DONE:]` intent parsing — calls `completeGoal()` with search text matching
- Processing order: REMEMBER > GOAL > DONE > FORGET > CRON
- All intents have 200-char security caps and are stripped from response before delivery

### Task 3: Update prompt builders with new intent instructions and goals context
- Main `buildPrompt()`: new MEMORY INSTRUCTIONS with REMEMBER/GOAL/DONE tags, ACTIVE GOALS section
- Heartbeat `buildHeartbeatPrompt()`: updated tag list, added goals context section
- Cron `executeCronJob()`: added goals context section alongside facts
- Summary prompt: updated to reference `[REMEMBER:]` instead of `[LEARN:]`

### Task 4: Update /memory command
- Now shows "Facts (N):" and "Active Goals (N):" as separate sections
- Goals display deadline when present (formatted as "Mon DD, YYYY")
- Footer updated: "To remove a memory, ask me to forget it. To complete a goal, tell me it's done."

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

1. Zero references to `getGlobalMemory` in relay.ts -- PASS
2. Zero references to `insertGlobalMemory` in relay.ts -- PASS
3. Zero references to `deleteGlobalMemory` in relay.ts -- PASS
4. Zero references to `[LEARN:]` in relay.ts -- PASS
5. `getMemoryContext` exists and calls `supabase.rpc("get_facts")` -- PASS
6. `insertMemory` exists and accepts `type` parameter -- PASS
7. `deleteMemory` exists -- PASS
8. `getActiveGoals` exists and calls `supabase.rpc("get_active_goals")` -- PASS
9. `completeGoal` exists and updates type to `completed_goal` -- PASS
10. All prompt builders fetch both facts and goals -- PASS
11. `/memory` command shows facts and goals separately -- PASS
12. `bun build src/relay.ts --no-bundle` succeeds with no errors -- PASS

## Commits

| Hash | Message |
|------|---------|
| 724a9de | feat(15): upgrade intent system -- REMEMBER/GOAL/DONE tags, renamed memory functions |

## Self-Check: PASSED

All files verified, all commits confirmed.
