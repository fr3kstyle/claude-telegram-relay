import { getValidAccessToken } from '../src/google-oauth.js';

const ACCOUNT = 'fr3k@mcpintelligence.com.au';

async function restoreDrafts() {
  const accessToken = await getValidAccessToken(ACCOUNT);

  console.log('=== CHECKING FOR DELETED DRAFTS ===\n');

  // Check if drafts are in trash
  const trashRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:trash+draft",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const trashData = await trashRes.json();
  console.log('Messages in trash with "draft":', trashData.messages?.length || 0);

  // List all drafts to see current state
  const draftsRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=100",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const draftsData = await draftsRes.json();
  console.log('Current drafts:', draftsData.drafts?.length || 0);

  // Check the consolidated draft we created
  if (draftsData.drafts?.length > 0) {
    console.log('\nCurrent draft IDs:');
    for (const d of draftsData.drafts) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msg = await msgRes.json();
      const subject = msg.message?.payload?.headers?.find((h: any) => h.name === 'Subject')?.value;
      console.log(`  - ${subject || 'No subject'} (${d.id})`);
    }
  }

  // Check Drive for the backup
  console.log('\n=== CHECKING DRIVE BACKUP ===');
  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=name+contains+'Draft+Consolidation'&orderBy=createdTime+desc&pageSize=10",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const driveData = await driveRes.json();

  if (driveData.files?.length > 0) {
    console.log('Found Drive backups:');
    for (const f of driveData.files) {
      console.log(`  - ${f.name} (${f.id})`);
    }

    // Get content from the first one
    const file = driveData.files[0];
    const contentRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const content = await contentRes.text();
    console.log(`\nBackup content (${content.length} chars):`);
    console.log(content.substring(0, 2000));
    console.log('\n... [truncated]');
  }

  console.log('\n=== GMAIL API LIMITATION ===');
  console.log('Drafts deleted via API cannot be restored from trash.');
  console.log('Drafts are not messages - they are separate entities.');
  console.log('The Drive backup has all the content though.');
}

restoreDrafts().catch(console.error);
