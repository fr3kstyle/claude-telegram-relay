import { listEmails, listDrafts, deleteDraft, archiveMessage, createFile, getAuthorizedAccounts } from '../src/google-apis.js';

const ACCOUNT = 'fr3k@mcpintelligence.com.au';

async function cleanup() {
  console.log('=== CLEANING UP EMAIL FOR', ACCOUNT, '===\n');

  // 1. Get all drafts
  console.log('Fetching drafts...');
  const drafts = await listDrafts(ACCOUNT, 100);
  console.log(`Found ${drafts.length} drafts\n`);

  if (drafts.length === 0) {
    console.log('No drafts to clean up!');
  } else {
    // 2. Categorize and consolidate
    const categories: Record<string, Array<{ subject: string; snippet: string }>> = {};

    for (const draft of drafts) {
      // Detect category
      let category = 'Other';
      const lowerContent = ((draft.message.subject || '') + ' ' + (draft.message.snippet || '')).toLowerCase();

      if (lowerContent.includes('api') || lowerContent.includes('key') || lowerContent.includes('secret') || lowerContent.includes('token')) {
        category = 'API Keys & Credentials';
      } else if (lowerContent.includes('ssh') || (lowerContent.includes('@') && lowerContent.includes(':'))) {
        category = 'SSH Servers';
      } else if (lowerContent.includes('http') || lowerContent.includes('://') || lowerContent.includes('url')) {
        category = 'URLs & Links';
      } else if (lowerContent.includes('bot') || lowerContent.includes('telegram') || lowerContent.includes('discord')) {
        category = 'Bot Tokens';
      } else if (lowerContent.includes('zoom') || lowerContent.includes('meet') || lowerContent.includes('teams')) {
        category = 'Meeting Links';
      } else if (lowerContent.includes('prompt') || lowerContent.includes('ai') || lowerContent.includes('claude')) {
        category = 'Prompts & AI';
      } else if (lowerContent.includes('trading') || lowerContent.includes('crypto') || lowerContent.includes('stock')) {
        category = 'Trading & Finance';
      }

      if (!categories[category]) categories[category] = [];
      categories[category].push({
        subject: draft.message.subject || 'No Subject',
        snippet: draft.message.snippet || ''
      });
    }

    // 3. Create consolidated document
    let docContent = `# Draft Consolidation - ${new Date().toISOString().split('T')[0]}\n\n`;
    docContent += `Consolidated ${drafts.length} drafts from ${ACCOUNT}\n\n---\n\n`;

    for (const [category, items] of Object.entries(categories)) {
      docContent += `## ${category} (${items.length} items)\n\n`;
      for (const item of items) {
        docContent += `### ${item.subject}\n${item.snippet}\n\n`;
      }
      docContent += '---\n\n';
    }

    console.log('Categories found:');
    for (const [cat, items] of Object.entries(categories)) {
      console.log(`  ${cat}: ${items.length}`);
    }

    // 4. Upload to Drive
    console.log('\nUploading consolidated document to Google Drive...');
    const fileName = `Draft Consolidation ${new Date().toISOString().split('T')[0]}.txt`;
    const file = await createFile(ACCOUNT, { name: fileName, content: docContent });
    console.log(`✅ Created: ${file.name} (ID: ${file.id})`);

    // 5. Delete all drafts
    console.log('\nDeleting drafts...');
    let deleted = 0;
    for (const draft of drafts) {
      try {
        await deleteDraft(ACCOUNT, draft.id);
        deleted++;
        if (deleted % 10 === 0) console.log(`  Deleted ${deleted}/${drafts.length}...`);
      } catch (e: any) {
        console.log(`  Failed to delete ${draft.id}: ${e.message}`);
      }
    }
    console.log(`✅ Deleted ${deleted} drafts`);
  }

  // 6. Archive promotional emails
  console.log('\n=== ARCHIVING PROMOTIONAL EMAILS ===');
  const inbox = await listEmails(ACCOUNT, { maxResults: 50, labelIds: ['INBOX'] });
  console.log(`Inbox has ${inbox.length} messages`);

  // Archive LinkedIn and promotional-looking emails
  const toArchive = inbox.filter(m =>
    m.from?.toLowerCase().includes('linkedin') ||
    m.from?.toLowerCase().includes('newsletter') ||
    m.from?.toLowerCase().includes('promo') ||
    m.subject?.toLowerCase().includes('unsubscribe')
  );

  console.log(`Found ${toArchive.length} promotional emails to archive`);

  let archived = 0;
  for (const msg of toArchive.slice(0, 30)) {
    try {
      await archiveMessage(ACCOUNT, msg.id);
      archived++;
    } catch (e) {}
  }
  console.log(`✅ Archived ${archived} promotional emails`);

  console.log('\n=== CLEANUP COMPLETE ===');
}

cleanup().catch(console.error);
