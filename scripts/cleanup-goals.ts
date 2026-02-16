import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function cleanup() {
  console.log('=== GOAL CLEANUP ===\n');

  // Get current state
  const { count: totalGoals } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal');

  const { count: activeGoals } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal')
    .eq('status', 'active');

  const { count: completedGoals } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal')
    .eq('status', 'completed');

  console.log(`Total goals: ${totalGoals}`);
  console.log(`Active: ${activeGoals}`);
  console.log(`Completed: ${completedGoals}\n`);

  // Run goal hygiene
  const { data: hygiene, error } = await supabase.rpc('goal_hygiene', { p_days_stale: 7 });

  if (error) {
    console.log('Goal hygiene error:', error.message);
    return;
  }

  console.log('Hygiene Summary:');
  console.log(JSON.stringify(hygiene.summary, null, 2));

  // Archive stale goals older than 14 days
  if (hygiene.stale_items?.length > 0) {
    console.log(`\nFound ${hygiene.stale_items.length} stale items`);

    const staleIds = hygiene.stale_items
      .filter((item: any) => item.days_old > 14)
      .map((item: any) => item.id);

    if (staleIds.length > 0) {
      const { error: updateError } = await supabase
        .from('memory')
        .update({ status: 'archived' })
        .in('id', staleIds);

      if (updateError) {
        console.log('Archive error:', updateError.message);
      } else {
        console.log(`Archived ${staleIds.length} stale goals`);
      }
    }
  }

  // Delete malformed entries
  if (hygiene.malformed?.length > 0) {
    console.log(`\nDeleting ${hygiene.malformed.length} malformed entries`);
    const malformedIds = hygiene.malformed.map((m: any) => m.id);

    const { error: deleteError } = await supabase
      .from('memory')
      .delete()
      .in('id', malformedIds);

    if (deleteError) {
      console.log('Delete error:', deleteError.message);
    } else {
      console.log('Deleted malformed entries');
    }
  }

  // Final count
  const { count: finalActive } = await supabase
    .from('memory')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'goal')
    .eq('status', 'active');

  console.log(`\nFinal active goals: ${finalActive}`);
}

cleanup().catch(console.error);
