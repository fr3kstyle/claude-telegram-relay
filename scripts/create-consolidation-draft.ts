import { getValidAccessToken } from '../src/google-oauth.js';

const ACCOUNT = 'fr3k@mcpintelligence.com.au';

async function copyToDraft() {
  const accessToken = await getValidAccessToken(ACCOUNT);

  // Find the consolidation file in Drive
  console.log('Finding consolidation file...');
  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=name+contains+'Draft+Consolidation'&orderBy=createdTime+desc&pageSize=5",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const driveData = await driveRes.json();
  const files = driveData.files || [];

  if (!files.length) {
    console.log('No consolidation file found');
    return;
  }

  console.log('Found files:', files.map((f: any) => f.name).join(', '));
  const file = files[0];
  console.log('Using:', file.name);

  // Download content
  const contentRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  let fileContent = await contentRes.text();
  console.log('Content length:', fileContent.length);

  // Reorganize - extract all items with their categories
  const lines = fileContent.split('\n');
  const items: Array<{ category: string; subject: string; snippet: string }> = [];

  let currentCategory = '';
  let currentItem: any = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentCategory = line.replace('## ', '').split(' (')[0];
    } else if (line.startsWith('### ')) {
      if (currentItem) items.push(currentItem);
      currentItem = {
        category: currentCategory,
        subject: line.replace('### ', ''),
        snippet: ''
      };
    } else if (currentItem && line.trim() && !line.startsWith('---') && !line.startsWith('#')) {
      currentItem.snippet += line + '\n';
    }
  }
  if (currentItem) items.push(currentItem);

  console.log('Extracted', items.length, 'items');

  // Group by category - most important first
  const categoryOrder = ['API Keys & Credentials', 'SSH Servers', 'Bot Tokens', 'URLs & Links', 'Prompts & AI', 'Meeting Links', 'Trading & Finance', 'Other'];
  items.sort((a, b) => {
    const catA = categoryOrder.indexOf(a.category);
    const catB = categoryOrder.indexOf(b.category);
    if (catA !== catB) return catA - catB;
    return b.subject.localeCompare(a.subject);
  });

  // Rebuild content
  let newContent = `📋 CONSOLIDATED NOTES & CREDENTIALS\n`;
  newContent += `Generated: ${new Date().toISOString().split('T')[0]}\n`;
  newContent += `${items.length} items from drafts\n`;
  newContent += '═'.repeat(50) + '\n\n';

  let lastCategory = '';
  for (const item of items) {
    if (item.category !== lastCategory) {
      newContent += `\n${'─'.repeat(50)}\n`;
      newContent += `📁 ${item.category.toUpperCase()}\n`;
      newContent += `${'─'.repeat(50)}\n\n`;
      lastCategory = item.category;
    }
    newContent += `📌 ${item.subject}\n`;
    if (item.snippet.trim()) {
      newContent += `${item.snippet.trim()}\n`;
    }
    newContent += '\n';
  }

  console.log('New content length:', newContent.length);

  // Create draft
  console.log('Creating draft...');
  const email = [
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    'Subject: 📋 Consolidated Notes & Credentials',
    '',
    newContent
  ].join('\r\n');

  const encoded = Buffer.from(email).toString('base64url');

  const draftRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: { raw: encoded }
      })
    }
  );

  if (!draftRes.ok) {
    console.log('Draft creation failed:', await draftRes.text());
    return;
  }

  const draft = await draftRes.json();
  console.log('✅ Draft created!');
  console.log('   ID:', draft.id);
  console.log('   Check your drafts folder in Gmail');
}

copyToDraft().catch(console.error);
