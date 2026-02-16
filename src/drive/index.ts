/**
 * Google Drive API Client
 *
 * Provides access to Google Drive for file management.
 * Handles authentication automatically using stored OAuth tokens.
 */

import { getValidAccessToken } from "../google-oauth.ts";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

export interface ListFilesOptions {
  maxResults?: number;
  query?: string;
  orderBy?: string;
}

export interface CreateFileOptions {
  name: string;
  content: string | Buffer;
  mimeType?: string;
  parentId?: string;
}

/**
 * List files in Drive
 */
export async function listFiles(
  email: string,
  options: ListFilesOptions = {}
): Promise<DriveFile[]> {
  const accessToken = await getValidAccessToken(email);
  const { maxResults = 20, query, orderBy = "modifiedTime desc" } = options;

  const params = new URLSearchParams({
    pageSize: String(maxResults),
    fields: "files(id, name, mimeType, webViewLink, createdTime, modifiedTime, size, parents)",
    orderBy,
  });

  if (query) params.set("q", query);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Drive list failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.files || [];
}

/**
 * Search files by name or content
 */
export async function searchFiles(
  email: string,
  searchTerm: string,
  maxResults = 20
): Promise<DriveFile[]> {
  const query = `name contains '${searchTerm}' or fullText contains '${searchTerm}'`;
  return listFiles(email, { query, maxResults });
}

/**
 * Get file metadata
 */
export async function getFile(
  email: string,
  fileId: string
): Promise<DriveFile> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink,createdTime,modifiedTime,size,parents`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Get file failed: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Download file content
 */
export async function downloadFile(
  email: string,
  fileId: string
): Promise<{ content: Buffer; mimeType: string; name: string }> {
  const accessToken = await getValidAccessToken(email);

  // Get metadata first
  const meta = await getFile(email, fileId);

  // Download content
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Download failed: ${await response.text()}`);
  }

  const content = Buffer.from(await response.arrayBuffer());

  return {
    content,
    mimeType: meta.mimeType,
    name: meta.name,
  };
}

/**
 * Create a new file
 */
export async function createFile(
  email: string,
  options: CreateFileOptions
): Promise<DriveFile> {
  const accessToken = await getValidAccessToken(email);
  const { name, content, mimeType = "text/plain", parentId } = options;

  const metadata: any = { name, mimeType };
  if (parentId) metadata.parents = [parentId];

  // Use multipart upload
  const boundary = "foo_bar_baz";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    typeof content === "string" ? content : content.toString(),
    `--${boundary}--`,
  ].join("\r\n");

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!response.ok) {
    throw new Error(`Create file failed: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Delete a file
 */
export async function deleteFile(
  email: string,
  fileId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete file failed: ${await response.text()}`);
  }
}
