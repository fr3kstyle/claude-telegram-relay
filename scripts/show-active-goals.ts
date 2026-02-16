import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function showActiveGoals() {
  console.log('=== ACTIVE GOALS ===\n');

  const { data: goals, error } = await supabase
    .from('memory')
    .select('id, content, priority, deadline, created_at, status')
    .eq('type', 'goal')
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`Found ${goals?.length || 0} active goals:\n`);

  // Group by priority
  const byPriority: Record<number, typeof goals> = {};
  goals?.forEach(g => {
    const p = g.priority || 5;
    if (!byPriority[p]) byPriority[p] = [];
    byPriority[p].push(g);
  });

  Object.keys(byPriority).sort().forEach(p => {
    console.log(`\n--- Priority ${p} (${byPriority[Number(p)].length} goals) ---`);
    byPriority[Number(p)].forEach((g, i) => {
      const deadline = g.deadline ? ` [due: ${new Date(g.deadline).toLocaleDateString()}]` : '';
      const created = new Date(g.created_at).toLocaleDateString();
      console.log(`  ${i+1}. ${g.content.substring(0, 80)}${g.content.length > 80 ? '...' : ''}${deadline} (${created})`);
    });
  });

  // Also check pending actions
  console.log('\n\n=== PENDING ACTIONS ===\n');

  const { data: actions, count } = await supabase
    .from('memory')
    .select('id, content, priority, created_at', { count: 'exact' })
    .eq('type', 'action')
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .limit(30);

  console.log(`Total pending actions: ${count}`);
  actions?.forEach((a, i) => {
    console.log(`  ${i+1}. [P${a.priority || 5}] ${a.content.substring(0, 70)}...`);
  });
}

showActiveGoals().catch(console.error);
