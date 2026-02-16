import { getValidAccessToken } from '../src/google-oauth.js';

const ACCOUNT = 'fr3k@mcpintelligence.com.au';

async function getDriveBackup() {
  const accessToken = await getValidAccessToken(ACCOUNT);

  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=name+contains+'Draft+Consolidation'&orderBy=createdTime+desc&pageSize=5",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const driveData = await driveRes.json();

  console.log('Found files:', driveData.files?.map((f: any) => f.name).join(', '));

  for (const file of driveData.files || []) {
    const contentRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const content = await contentRes.text();

    console.log(`\n=== ${file.name} ===\n`);
    console.log(content);
  }
}

getDriveBackup().catch(console.error);
