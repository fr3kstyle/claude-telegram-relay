#!/usr/bin/env bun
/**
 * Apply autonomous agent schema migration via Supabase RPC
 * This creates the necessary RPCs and columns for the agent system
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// SQL to apply - split into individual statements
const migrations = [
  // Part 1: Add columns
  `ALTER TABLE global_memory DROP CONSTRAINT IF EXISTS global_memory_type_check`,

  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES global_memory(id) ON DELETE CASCADE`,

  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'blocked', 'completed', 'archived'))`,

  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS weight FLOAT DEFAULT 1.0`,
  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`,
  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT`,
  `ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`,

  `ALTER TABLE global_memory ADD CONSTRAINT global_memory_type_check
    CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'reminder', 'note', 'action', 'strategy', 'reflection', 'system_event'))`,

  // Part 2: Indexes
  `CREATE INDEX IF NOT EXISTS idx_global_memory_status ON global_memory(status)`,
  `CREATE INDEX IF NOT EXISTS idx_global_memory_parent ON global_memory(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_global_memory_pending_actions ON global_memory(priority DESC, created_at ASC) WHERE type = 'action' AND status IN ('active', 'pending')`,
  `CREATE INDEX IF NOT EXISTS idx_global_memory_blocked ON global_memory(updated_at DESC) WHERE status = 'blocked'`,
  `CREATE INDEX IF NOT EXISTS idx_global_memory_active_goals_hierarchy ON global_memory(priority DESC, created_at ASC) WHERE type = 'goal' AND status = 'active' AND parent_id IS NULL`,

  // Part 3: View (simplified - just the view, skip rules for now)
  `CREATE OR REPLACE VIEW memory AS SELECT * FROM global_memory`,

  // Part 4: RPC functions
  `CREATE OR REPLACE FUNCTION get_pending_actions(limit_count INT DEFAULT 10)
   RETURNS TABLE (id UUID, content TEXT, priority INTEGER, parent_id UUID, retry_count INTEGER, status TEXT, created_at TIMESTAMPTZ) AS $$
   BEGIN RETURN QUERY SELECT gm.id, gm.content, gm.priority, gm.parent_id, gm.retry_count, gm.status, gm.created_at FROM global_memory gm WHERE gm.type = 'action' AND gm.status IN ('active', 'pending') ORDER BY gm.priority DESC NULLS LAST, gm.created_at ASC LIMIT limit_count; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION get_strategies()
   RETURNS TABLE (id UUID, content TEXT, created_at TIMESTAMPTZ, weight FLOAT) AS $$
   BEGIN RETURN QUERY SELECT gm.id, gm.content, gm.created_at, gm.weight FROM global_memory gm WHERE gm.type = 'strategy' AND gm.status = 'active' ORDER BY gm.weight DESC NULLS LAST, gm.created_at DESC LIMIT 10; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION get_reflections(limit_count INTEGER DEFAULT 5)
   RETURNS TABLE (id UUID, content TEXT, created_at TIMESTAMPTZ) AS $$
   BEGIN RETURN QUERY SELECT gm.id, gm.content, gm.created_at FROM global_memory gm WHERE gm.type = 'reflection' AND gm.status = 'active' ORDER BY gm.created_at DESC LIMIT limit_count; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION get_active_goals_with_children()
   RETURNS TABLE (id UUID, content TEXT, deadline TIMESTAMPTZ, priority INTEGER, status TEXT, parent_id UUID, child_count BIGINT) AS $$
   BEGIN RETURN QUERY SELECT gm.id, gm.content, gm.deadline, gm.priority, gm.status, gm.parent_id, (SELECT COUNT(*) FROM global_memory sub WHERE sub.parent_id = gm.id) as child_count FROM global_memory gm WHERE gm.type = 'goal' AND gm.status != 'completed' AND gm.status != 'archived' ORDER BY CASE WHEN gm.parent_id IS NULL THEN 0 ELSE 1 END, gm.priority DESC NULLS LAST, gm.deadline ASC NULLS LAST, gm.created_at DESC; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION get_agent_state()
   RETURNS TABLE (active_goals BIGINT, pending_actions BIGINT, blocked_items BIGINT, recent_errors BIGINT) AS $$
   BEGIN RETURN QUERY SELECT (SELECT COUNT(*) FROM global_memory WHERE type = 'goal' AND status IN ('active', 'pending')) as active_goals, (SELECT COUNT(*) FROM global_memory WHERE type = 'action' AND status IN ('pending', 'active')) as pending_actions, (SELECT COUNT(*) FROM global_memory WHERE status = 'blocked') as blocked_items, (SELECT COUNT(*) FROM logs_v2 WHERE level = 'error' AND created_at > NOW() - INTERVAL '24 hours') as recent_errors; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION mark_action_blocked(p_id UUID, p_error TEXT) RETURNS VOID AS $$
   BEGIN UPDATE global_memory SET status = 'blocked', last_error = p_error, retry_count = retry_count + 1, metadata = jsonb_set(COALESCE(metadata, '{}'), '{blocked_at}', to_jsonb(NOW())) WHERE id = p_id; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION mark_action_completed(p_id UUID) RETURNS VOID AS $$
   BEGIN UPDATE global_memory SET status = 'completed', completed_at = NOW() WHERE id = p_id; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION complete_goal_cascade(goal_id UUID) RETURNS VOID AS $$
   BEGIN UPDATE global_memory SET type = 'completed_goal', status = 'completed', completed_at = NOW() WHERE id = goal_id; UPDATE global_memory SET status = 'completed', completed_at = NOW() WHERE parent_id = goal_id; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION block_goal(goal_id UUID, reason TEXT) RETURNS VOID AS $$
   BEGIN UPDATE global_memory SET status = 'blocked', metadata = jsonb_set(COALESCE(metadata, '{}'), '{blocked_reason}', to_jsonb(reason)) WHERE id = goal_id; END;
   $$ LANGUAGE plpgsql`,

  `CREATE OR REPLACE FUNCTION decompose_goal(parent_goal_id UUID, item_type TEXT, item_content TEXT, item_priority INTEGER DEFAULT 3) RETURNS UUID AS $$
   DECLARE new_id UUID; BEGIN INSERT INTO global_memory (type, content, priority, parent_id, status) VALUES (item_type, item_content, item_priority, parent_goal_id, 'active') RETURNING id INTO new_id; RETURN new_id; END;
   $$ LANGUAGE plpgsql`,
];

async function applyMigration() {
  console.log("Applying autonomous agent schema migration...\n");

  // Apply each statement via RPC
  for (let i = 0; i < migrations.length; i++) {
    const sql = migrations[i];
    process.stdout.write(`[${i + 1}/${migrations.length}] Applying: ${sql.substring(0, 60)}... `);

    try {
      // Use the exec_sql RPC if available, otherwise we need direct DB access
      const { error } = await supabase.rpc('exec_sql', { query: sql });

      if (error) {
        // If exec_sql doesn't exist, we need to tell user to apply manually
        if (error.message.includes('Could not find') || error.code === 'PGRST202') {
          console.log("NEEDS MANUAL APPLICATION");
          console.log("\n  The exec_sql RPC is not available. Please apply this migration manually:");
          console.log("  1. Go to Supabase Dashboard > SQL Editor");
          console.log("  2. Copy the contents of: setup/apply-migration.ts");
          console.log("  3. Paste and run\n");
          console.log("\nAlternatively, run with direct DB URL:");
          console.log("  SUPABASE_DB_URL=postgresql://... bun run setup/apply-schema-migration-direct.ts\n");
          process.exit(1);
        }
        throw error;
      }
      console.log("OK");
    } catch (err) {
      console.log("ERROR");
      console.error(`  ${err}`);
    }
  }

  console.log("\nMigration complete!");
}

applyMigration();
