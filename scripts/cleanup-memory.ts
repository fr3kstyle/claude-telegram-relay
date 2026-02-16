#!/usr/bin/env bun
/**
 * Clean up stale goals and actions from the memory table
 *
 * Criteria for cleanup:
 * - Goals older than 7 days with no progress -> archive
 * - Actions older than 3 days with status 'pending' -> archive
 * - Completed items older than 14 days -> delete
 * - Duplicate/low-value items -> consolidate
 *
 * Run: bun run scripts/cleanup-memory.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const DRY_RUN = process.argv.includes('--dry-run');

async function cleanup() {
  console.log(`=== MEMORY CLEANUP ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will make changes)'}\n`);

  // Get current state
  const { data: beforeStats } = await supabase.rpc('get_agent_state');
  console.log('BEFORE:');
  console.log(`  Active goals: ${beforeStats?.active_goals || 0}`);
  console.log(`  Pending actions: ${beforeStats?.pending_actions || 0}`);

  // 1. Find stale goals (older than 7 days, no updates)
  console.log('\n1. STALE GOALS (>7 days old):');
  const { data: staleGoals } = await supabase
    .from('memory')
    .select('id, content, created_at, status')
    .eq('type', 'goal')
    .eq('status', 'active')
    .lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true });

  if (staleGoals && staleGoals.length > 0) {
    console.log(`   Found ${staleGoals.length} stale goals to archive`);
    if (staleGoals.length <= 10) {
      staleGoals.forEach(g => console.log(`   - ${g.content.substring(0, 60)}...`));
    }

    if (!DRY_RUN) {
      const { error } = await supabase
        .from('memory')
        .update({ status: 'archived' })
        .in('id', staleGoals.map(g => g.id));
      console.log(`   ${error ? '❌ ' + error.message : '✅ Archived'}`);
    }
  } else {
    console.log('   None found');
  }

  // 2. Find stale pending actions (older than 3 days)
  console.log('\n2. STALE PENDING ACTIONS (>3 days old):');
  const { data: staleActions } = await supabase
    .from('memory')
    .select('id, content, created_at, status')
    .eq('type', 'action')
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(100);

  if (staleActions && staleActions.length > 0) {
    console.log(`   Found ${staleActions.length} stale actions (showing first 100)`);
    console.log('   Examples:');
    staleActions.slice(0, 5).forEach(a => console.log(`   - ${a.content.substring(0, 50)}...`));

    if (!DRY_RUN) {
      // Archive in batches of 50
      const ids = staleActions.map(a => a.id);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        await supabase
          .from('memory')
          .update({ status: 'archived' })
          .in('id', batch);
      }
      console.log(`   ✅ Archived ${ids.length} actions`);
    }
  } else {
    console.log('   None found');
  }

  // 3. Delete old completed items (older than 14 days)
  console.log('\n3. OLD COMPLETED ITEMS (>14 days):');
  const { data: oldCompleted, count: completedCount } = await supabase
    .from('memory')
    .select('id', { count: 'exact' })
    .eq('type', 'completed_goal')
    .lt('completed_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

  if (completedCount && completedCount > 0) {
    console.log(`   Found ${completedCount} old completed items to delete`);

    if (!DRY_RUN && oldCompleted) {
      const ids = oldCompleted.map(c => c.id);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        await supabase.from('memory').delete().in('id', batch);
      }
      console.log(`   ✅ Deleted ${ids.length} completed items`);
    }
  } else {
    console.log('   None found');
  }

  // 4. Find duplicate actions (same content)
  console.log('\n4. DUPLICATE ACTIONS:');
  const { data: allActions } = await supabase
    .from('memory')
    .select('id, content')
    .eq('type', 'action')
    .in('status', ['active', 'pending']);

  if (allActions) {
    const contentMap = new Map<string, string[]>();
    for (const a of allActions) {
      const key = a.content.toLowerCase().trim().substring(0, 50);
      if (!contentMap.has(key)) contentMap.set(key, []);
      contentMap.get(key)!.push(a.id);
    }

    const duplicates = Array.from(contentMap.entries())
      .filter(([_, ids]) => ids.length > 1);

    if (duplicates.length > 0) {
      console.log(`   Found ${duplicates.length} duplicate groups`);
      let archived = 0;

      for (const [content, ids] of duplicates) {
        // Keep the first one, archive the rest
        const toArchive = ids.slice(1);
        if (!DRY_RUN && toArchive.length > 0) {
          await supabase
            .from('memory')
            .update({ status: 'archived' })
            .in('id', toArchive);
          archived += toArchive.length;
        }
      }

      console.log(`   ${DRY_RUN ? 'Would archive' : '✅ Archived'} ${archived} duplicates`);
    } else {
      console.log('   None found');
    }
  }

  // Get final state
  const { data: afterStats } = await supabase.rpc('get_agent_state');
  console.log('\nAFTER:');
  console.log(`  Active goals: ${afterStats?.active_goals || 0}`);
  console.log(`  Pending actions: ${afterStats?.pending_actions || 0}`);
  console.log(`  Blocked items: ${afterStats?.blocked_items || 0}`);

  console.log('\n=== CLEANUP COMPLETE ===');
}

cleanup().catch(console.error);
