import { backfillEmbeddings } from '../src/embed-local.ts';

async function fix() {
  console.log('=== FIXING MEMORY EMBEDDINGS ===\n');
  const count = await backfillEmbeddings();
  console.log('\nBackfilled', count, 'embeddings');
}
fix().catch(e => console.error('Error:', e));
