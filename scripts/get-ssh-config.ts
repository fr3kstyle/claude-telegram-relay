import { getValidAccessToken } from '../src/google-oauth.js';

const ACCOUNT = 'fr3k@mcpintelligence.com.au';

async function getDraftContent() {
  const accessToken = await getValidAccessToken(ACCOUNT);

  // Get the consolidated draft
  const draftRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const drafts = await draftRes.json();

  // Find the consolidated draft
  for (const d of drafts.drafts || []) {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const detail = await detailRes.json();

    const subject = detail.message?.payload?.headers?.find((h: any) => h.name === 'Subject')?.value;
    if (subject?.includes('Consolidated')) {
      // Get full message body
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${detail.message.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msg = await msgRes.json();

      // Decode body
      const bodyData = msg.payload?.body?.data || msg.payload?.parts?.[0]?.body?.data;
      if (bodyData) {
        const body = Buffer.from(bodyData, 'base64').toString('utf-8');
        console.log('=== DRAFT CONTENT ===\n');
        console.log(body);
        return;
      }
    }
  }

  console.log('Consolidated draft not found');
}

getDraftContent().catch(console.error);
