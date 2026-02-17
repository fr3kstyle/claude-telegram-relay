import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function analyze() {
  const { data } = await supabase
    .from('global_memory')
    .select('id, content, priority, created_at')
    .eq('type', 'action');

  // Find duplicates by prefix
  const byPrefix: Record<string, typeof data> = {};
  data?.forEach(a => {
    const prefix = a.content.substring(0, 40).toLowerCase();
    if (!byPrefix[prefix]) byPrefix[prefix] = [];
    byPrefix[prefix].push(a);
  });

  console.log('=== POTENTIAL DUPLICATES ===\n');
  let dupCount = 0;
  const dupIds: string[] = [];

  for (const [prefix, items] of Object.entries(byPrefix)) {
    if (items.length > 1) {
      dupCount += items.length - 1;
      console.log(`[${items.length} similar] ${prefix}...`);
      items.forEach((i, idx) => {
        console.log(`  ${idx === 0 ? 'KEEP' : 'REMOVE'}: ${i.content.substring(0, 55)}...`);
        if (idx > 0) dupIds.push(i.id);
      });
      console.log('');
    }
  }
  console.log(`Total duplicates to remove: ${dupCount}`);

  // Find stale (mention already/done/completed)
  const stale = data?.filter(a => /already|done|completed|implemented/i.test(a.content)) || [];
  console.log('\n=== STALE (mention already/done/completed) ===\n');
  const staleIds: string[] = [];
  stale.forEach(a => {
    console.log(`  - ${a.content.substring(0, 60)}...`);
    staleIds.push(a.id);
  });

  console.log(`\nTotal stale: ${stale.length}`);

  // Summary
  console.log('\n=== CLEANUP SUMMARY ===');
  console.log(`Total actions: ${data?.length}`);
  console.log(`Duplicates to remove: ${dupCount}`);
  console.log(`Stale to remove: ${stale.length}`);
  console.log(`After cleanup: ${(data?.length || 0) - dupCount - stale.length}`);
}

analyze().catch(console.error);
