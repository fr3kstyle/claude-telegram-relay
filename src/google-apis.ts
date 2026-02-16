/**
 * Google APIs Client
 *
 * Provides easy access to Gmail, Calendar, and Drive APIs.
 * Handles authentication automatically using stored OAuth tokens.
 */

import { getValidAccessToken, loadToken, TOKENS_DIR } from "./google-oauth.ts";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

// ============================================================
// GMAIL API
// ============================================================

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  body?: string;
  unread?: boolean;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

/**
 * List recent emails
 */
export async function listEmails(
  email: string,
  options: {
    maxResults?: number;
    query?: string;
    labelIds?: string[];
  } = {}
): Promise<GmailMessage[]> {
  const accessToken = await getValidAccessToken(email);
  const { maxResults = 10, query = "", labelIds = [] } = options;

  const params = new URLSearchParams({
    maxResults: String(maxResults),
  });

  if (query) params.set("q", query);
  if (labelIds.length > 0) params.set("labelIds", labelIds.join(","));

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail list failed: ${await response.text()}`);
  }

  const data = await response.json();
  const messages = data.messages || [];

  // Fetch details for each message
  const detailed = await Promise.all(
    messages.slice(0, maxResults).map((m: any) => getEmail(email, m.id))
  );

  return detailed.filter(Boolean);
}

/**
 * Get a single email by ID
 */
export async function getEmail(
  email: string,
  messageId: string
): Promise<GmailMessage | null> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) return null;

  const data = await response.json();
  return parseGmailMessage(data);
}

/**
 * Send an email
 */
export async function sendEmail(
  email: string,
  options: {
    to: string;
    subject: string;
    body: string;
    html?: boolean;
  }
): Promise<{ id: string; threadId: string }> {
  const accessToken = await getValidAccessToken(email);
  const { to, subject, body, html = false } = options;

  // Build RFC 2822 message
  const message = [
    `To: ${to}`,
    `From: ${email}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    html
      ? "Content-Type: text/html; charset=utf-8"
      : "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  // Base64URL encode
  const encodedMessage = btoa(message)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedMessage }),
    }
  );

  if (!response.ok) {
    throw new Error(`Send email failed: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Search emails
 */
export async function searchEmails(
  email: string,
  query: string,
  maxResults = 10
): Promise<GmailMessage[]> {
  return listEmails(email, { query, maxResults });
}

/**
 * List drafts
 */
export async function listDrafts(
  email: string,
  maxResults = 20
): Promise<Array<{ id: string; message: GmailMessage }>> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=${maxResults}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`List drafts failed: ${await response.text()}`);
  }

  const data = await response.json();
  const drafts = data.drafts || [];

  // Get message details for each draft
  const detailed = await Promise.all(
    drafts.map(async (d: any) => {
      const msg = await getEmail(email, d.message.id);
      return { id: d.id, message: msg! };
    })
  );

  return detailed.filter(d => d.message);
}

/**
 * Delete a draft
 */
export async function deleteDraft(
  email: string,
  draftId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete draft failed: ${await response.text()}`);
  }
}

/**
 * Archive a message (remove from inbox)
 */
export async function archiveMessage(
  email: string,
  messageId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removeLabelIds: ["INBOX"],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Archive failed: ${await response.text()}`);
  }
}

/**
 * Parse Gmail API message into friendly format
 */
function parseGmailMessage(data: any): GmailMessage {
  const headers = data.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value;

  // Extract body text
  let body = "";
  if (data.payload?.body?.data) {
    body = atob(data.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
  } else if (data.payload?.parts) {
    const textPart = data.payload.parts.find(
      (p: any) => p.mimeType === "text/plain"
    );
    if (textPart?.body?.data) {
      body = atob(textPart.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }
  }

  const labels = data.labelIds || [];

  return {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    subject: getHeader("subject"),
    from: getHeader("from"),
    to: getHeader("to"),
    date: getHeader("date"),
    body: body.substring(0, 10000), // Limit body size
    unread: labels.includes("UNREAD"),
  };
}

// ============================================================
// CALENDAR API
// ============================================================

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  attendees?: { email: string; displayName?: string }[];
  htmlLink?: string;
}

/**
 * List upcoming events
 */
export async function listEvents(
  email: string,
  options: {
    maxResults?: number;
    timeMin?: string;
    timeMax?: string;
    calendarId?: string;
  } = {}
): Promise<CalendarEvent[]> {
  const accessToken = await getValidAccessToken(email);
  const {
    maxResults = 10,
    timeMin = new Date().toISOString(),
    timeMax,
    calendarId = "primary",
  } = options;

  const params = new URLSearchParams({
    maxResults: String(maxResults),
    timeMin,
    singleEvents: "true",
    orderBy: "startTime",
  });

  if (timeMax) params.set("timeMax", timeMax);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar list failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.items || [];
}

/**
 * Create a calendar event
 */
export async function createEvent(
  email: string,
  event: {
    summary: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
    description?: string;
    location?: string;
    attendees?: string[];
    calendarId?: string;
  }
): Promise<CalendarEvent> {
  const accessToken = await getValidAccessToken(email);
  const { calendarId = "primary", ...eventData } = event;

  const body: any = {
    summary: event.summary,
    start: event.start,
    end: event.end,
  };

  if (event.description) body.description = event.description;
  if (event.location) body.location = event.location;
  if (event.attendees) {
    body.attendees = event.attendees.map((email) => ({ email }));
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    throw new Error(`Create event failed: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Delete a calendar event
 */
export async function deleteEvent(
  email: string,
  eventId: string,
  calendarId = "primary"
): Promise<void> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${eventId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok && response.status !== 410) {
    throw new Error(`Delete event failed: ${await response.text()}`);
  }
}

/**
 * Search events by text
 */
export async function searchEvents(
  email: string,
  query: string,
  maxResults = 10
): Promise<CalendarEvent[]> {
  const accessToken = await getValidAccessToken(email);

  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    timeMin: new Date().toISOString(),
    singleEvents: "true",
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar search failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.items || [];
}

// ============================================================
// DRIVE API
// ============================================================

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

/**
 * List files in Drive
 */
export async function listFiles(
  email: string,
  options: {
    maxResults?: number;
    query?: string;
    orderBy?: string;
  } = {}
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
  options: {
    name: string;
    content: string | Buffer;
    mimeType?: string;
    parentId?: string;
  }
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

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Get list of authorized Google accounts
 */
export async function getAuthorizedAccounts(): Promise<string[]> {
  if (!existsSync(TOKENS_DIR)) return [];

  const files = await readdir(TOKENS_DIR);
  const accounts: string[] = [];

  for (const file of files) {
    if (file.endsWith(".json")) {
      const content = await readFile(join(TOKENS_DIR, file), "utf-8");
      const data = JSON.parse(content);
      if (data.email) {
        accounts.push(data.email);
      }
    }
  }

  return accounts;
}

/**
 * Check if an account is authorized
 */
export async function isAccountAuthorized(email: string): Promise<boolean> {
  const token = await loadToken(email);
  return token !== null;
}

/**
 * Get profile info for an account
 */
export async function getProfile(email: string): Promise<any> {
  const accessToken = await getValidAccessToken(email);

  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Get profile failed: ${await response.text()}`);
  }

  return response.json();
}
