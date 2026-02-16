# Scripts Directory

Operational scripts for maintenance and utilities.

## Operational Scripts

| Script | Purpose |
|--------|---------|
| `test-integration.ts` | Unified integration tests (Telegram, Supabase, Email) |
| `hygiene-cleanup.ts` | Clean up stale goals and actions from memory |
| `show-active-goals.ts` | Display current active goals from database |
| `backfill-embeddings.ts` | Generate embeddings for memory entries without them |
| `apply-migrations.ts` | Apply pending Supabase migrations |
| `analyze-memory-table.ts` | Analyze memory table statistics |

## Archive Directory

`scripts/archive/` contains historical scripts that are no longer run but preserved for reference:

- `adhoc/` - One-time analysis and fix scripts
- `migrations-2026-02/` - February 2026 migration helpers (token migration, API tests)

## Running Scripts

```bash
bun run scripts/<script-name>.ts
```
