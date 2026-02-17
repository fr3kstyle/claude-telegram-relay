#!/usr/bin/env bun
/**
 * RSS Feed Monitor for OAuth Provider Changelogs
 *
 * Checks Google Workspace and Microsoft 365 developer blogs for OAuth-related changes.
 * Designed to run via cron (e.g., weekly) and send alerts to Telegram.
 *
 * Usage:
 *   bun run scripts/check-oauth-feeds.ts
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN - Bot token for sending alerts
 *   TELEGRAM_USER_ID - User ID to send alerts to
 *   FEED_CHECK_HOURS - Hours to look back for new items (default: 168 = 7 days)
 */

// Bun auto-loads .env from current directory and parent directories

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";
const FEED_CHECK_HOURS = parseInt(process.env.FEED_CHECK_HOURS || "168", 10);

// OAuth-relevant RSS feeds
const FEEDS = [
  {
    name: "Google Workspace Updates",
    url: "https://workspaceupdates.googleblog.com/feeds/posts/default",
    keywords: ["oauth", "authentication", "api", "security", "deprecat", "scope", "token", "gmail api", "calendar api"],
    priority: "high" as const,
  },
  {
    name: "Google Developers Blog",
    url: "https://developers.googleblog.com/feed/",
    keywords: ["oauth", "identity", "authentication", "api change", "deprecat"],
    priority: "medium" as const,
  },
  {
    name: "Microsoft 365 Developer Blog",
    url: "https://devblogs.microsoft.com/microsoft365dev/feed/",
    keywords: ["oauth", "graph api", "authentication", "microsoft identity", "deprecat", "outlook api", "token"],
    priority: "high" as const,
  },
  {
    name: "Microsoft Identity Blog",
    url: "https://devblogs.microsoft.com/identity/feed/",
    keywords: ["oauth", "authentication", "token", "scope", "permission", "deprecat", "azure ad"],
    priority: "high" as const,
  },
];

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  priority: "high" | "medium" | "low";
}

async function fetchFeed(feedUrl: string): Promise<string> {
  const response = await fetch(feedUrl, {
    headers: {
      "User-Agent": "claude-telegram-relay/1.0 (RSS monitor)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status}`);
  }

  return response.text();
}

function parseRSS(xml: string, feed: typeof FEEDS[0]): FeedItem[] {
  const items: FeedItem[] = [];
  const cutoff = Date.now() - FEED_CHECK_HOURS * 60 * 60 * 1000;

  // Simple XML parsing - extract <item> elements
  const itemMatches = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/gi) || [];

  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
    const linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);

    if (!titleMatch || !linkMatch) continue;

    const title = titleMatch[1].trim();
    const link = linkMatch[1].trim();
    const pubDateStr = pubDateMatch ? pubDateMatch[1].trim() : "";
    const pubDate = new Date(pubDateStr).getTime();

    // Skip old items
    if (pubDate < cutoff) continue;

    // Check if item matches keywords
    const titleLower = title.toLowerCase();
    const matches = feed.keywords.some(kw => titleLower.includes(kw));

    if (matches) {
      items.push({
        title,
        link,
        pubDate: pubDateStr,
        source: feed.name,
        priority: feed.priority,
      });
    }
  }

  return items;
}

async function sendTelegramAlert(items: FeedItem[]): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.log("[OAuth Feeds] No Telegram credentials, printing to console:");
    items.forEach(item => console.log(`  - [${item.source}] ${item.title}`));
    return;
  }

  if (items.length === 0) {
    console.log("[OAuth Feeds] No relevant updates found");
    return;
  }

  // Group by priority
  const highPriority = items.filter(i => i.priority === "high");
  const mediumPriority = items.filter(i => i.priority === "medium");

  let message = "🔔 **OAuth Provider Updates**\n\n";

  if (highPriority.length > 0) {
    message += "**High Priority:**\n";
    for (const item of highPriority.slice(0, 5)) {
      message += `• [${item.source}] ${item.title}\n  ${item.link}\n`;
    }
    message += "\n";
  }

  if (mediumPriority.length > 0) {
    message += "**Other Updates:**\n";
    for (const item of mediumPriority.slice(0, 3)) {
      message += `• [${item.source}] ${item.title}\n`;
    }
  }

  message += `\n_${items.length} relevant items in last ${FEED_CHECK_HOURS / 24} days_`;

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }

  console.log(`[OAuth Feeds] Alert sent: ${items.length} items`);
}

async function main(): Promise<void> {
  console.log(`[OAuth Feeds] Checking ${FEEDS.length} feeds for updates...`);

  const allItems: FeedItem[] = [];

  for (const feed of FEEDS) {
    try {
      console.log(`[OAuth Feeds] Fetching ${feed.name}...`);
      const xml = await fetchFeed(feed.url);
      const items = parseRSS(xml, feed);
      console.log(`[OAuth Feeds] Found ${items.length} relevant items from ${feed.name}`);
      allItems.push(...items);
    } catch (error) {
      console.error(`[OAuth Feeds] Error fetching ${feed.name}:`, error);
    }
  }

  // Sort by date, newest first
  allItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  await sendTelegramAlert(allItems);
}

main().catch(console.error);
