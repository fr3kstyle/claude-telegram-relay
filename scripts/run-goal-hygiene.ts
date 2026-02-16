import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function runGoalHygiene() {
  console.log('=== GOAL HYGIENE CHECK ===\n');

  // Get stats before
  const { count: totalGoals } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal');

  const { count: activeGoals } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal')
    .eq('status', 'active');

  console.log(`Current state:`);
  console.log(`  Total goals: ${totalGoals}`);
  console.log(`  Active goals: ${activeGoals}`);

  // Find goals older than 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: staleGoals, count: staleCount } = await supabase
    .from('memory')
    .select('id, content, created_at, priority, status', { count: 'exact' })
    .eq('type', 'goal')
    .eq('status', 'active')
    .lt('created_at', sevenDaysAgo.toISOString())
    .order('created_at', { ascending: true })
    .limit(100);

  if (staleGoals && staleGoals.length > 0) {
    console.log(`\nStale active goals (>7 days old): ${staleCount}`);
    console.log('\nSample stale goals:');
    staleGoals.slice(0, 15).forEach((g, i) => {
      const created = new Date(g.created_at).toLocaleDateString();
      console.log(`  ${i+1}. [P${g.priority || '?'}] ${g.content.substring(0, 70)}... (${created})`);
    });

    // Archive stale goals
    console.log(`\n\nArchiving ${staleCount} stale goals...`);
    const { error: archiveErr, count: archivedCount } = await supabase
      .from('memory')
      .update({ status: 'archived' })
      .eq('type', 'goal')
      .eq('status', 'active')
      .lt('created_at', sevenDaysAgo.toISOString());

    if (archiveErr) {
      console.error('Archive error:', archiveErr);
    } else {
      console.log(`✅ Archived stale goals`);

      // Show new stats
      const { count: newActive } = await supabase
        .from('memory')
        .select('*', { count: 'exact', head: true })
        .eq('type', 'goal')
        .eq('status', 'active');

      console.log(`\nNew active goal count: ${newActive}`);
    }
  } else {
    console.log('\nNo stale goals found.');
  }

  // Clean up old completed goals too
  console.log('\n=== CLEANING OLD COMPLETED GOALS ===');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { count: oldCompleted } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'completed_goal')
    .lt('created_at', thirtyDaysAgo.toISOString());

  if (oldCompleted && oldCompleted > 100) {
    console.log(`Found ${oldCompleted} completed goals older than 30 days, archiving...`);
    const { error: delErr } = await supabase
      .from('memory')
      .delete()
      .eq('type', 'completed_goal')
      .lt('created_at', thirtyDaysAgo.toISOString());

    if (delErr) {
      console.error('Delete error:', delErr);
    } else {
      console.log('✅ Cleaned up old completed goals');
    }
  }

  // Final stats
  const { count: finalMem } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true });

  console.log(`\n=== FINAL STATS ===`);
  console.log(`Total memory records: ${finalMem}`);
}

runGoalHygiene().catch(console.error);
