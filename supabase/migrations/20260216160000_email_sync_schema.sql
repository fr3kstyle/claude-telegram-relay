-- ============================================================
-- Schema v2.5: Email Sync System
-- ============================================================
-- Email sync infrastructure for Gmail integration.
-- Uses existing Google OAuth tokens from ~/.claude-relay/google-tokens/
--
-- Tables:
-- - email_accounts: Links Google OAuth accounts to sync config
-- - email_sync_state: Tracks incremental sync progress per account
-- - email_messages: Stores email content with embeddings for search

-- ============================================================
-- 1. EMAIL ACCOUNTS TABLE
-- ============================================================
-- Links to Google OAuth accounts, stores sync preferences
CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  provider TEXT NOT NULL DEFAULT 'gmail'
    CHECK (provider IN ('gmail', 'outlook', 'imap')),
  is_active BOOLEAN DEFAULT true,
  sync_enabled BOOLEAN DEFAULT true,
  sync_interval_minutes INTEGER DEFAULT 15,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  total_messages INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email);
CREATE INDEX IF NOT EXISTS idx_email_accounts_active ON email_accounts(is_active, sync_enabled);

-- ============================================================
-- 2. EMAIL SYNC STATE TABLE
-- ============================================================
-- Tracks sync progress for incremental updates
CREATE TABLE IF NOT EXISTS email_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  history_id TEXT,  -- Gmail history ID for incremental sync
  last_message_id TEXT,  -- Last synced message ID
  last_sync_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'syncing', 'error', 'disabled')),
  messages_synced INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);

CREATE INDEX IF NOT EXISTS idx_email_sync_account ON email_sync_state(account_id);

-- ============================================================
-- 3. EMAIL MESSAGES TABLE
-- ============================================================
-- Stores email content with vector embeddings for semantic search
CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  to_recipients JSONB DEFAULT '[]',  -- [{email, name}]
  cc_recipients JSONB DEFAULT '[]',
  date TIMESTAMPTZ,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  labels JSONB DEFAULT '[]',  -- Gmail labels
  is_read BOOLEAN DEFAULT true,
  is_starred BOOLEAN DEFAULT false,
  is_draft BOOLEAN DEFAULT false,
  is_important BOOLEAN DEFAULT false,
  attachments JSONB DEFAULT '[]',  -- [{filename, mimeType, size}]
  embedding VECTOR(1536),  -- OpenAI text-embedding-3-small
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, gmail_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_from ON email_messages(from_email);
CREATE INDEX IF NOT EXISTS idx_email_messages_unread ON email_messages(account_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_email_messages_starred ON email_messages(account_id, is_starred) WHERE is_starred = true;
CREATE INDEX IF NOT EXISTS idx_email_messages_embedding ON email_messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_email_messages_search ON email_messages USING gin(to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body_text, '')));

-- ============================================================
-- 4. HELPER RPCs
-- ============================================================

-- Get account by email
CREATE OR REPLACE FUNCTION get_email_account(p_email TEXT)
RETURNS email_accounts AS $$
DECLARE
  acc email_accounts%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM email_accounts WHERE email = p_email LIMIT 1;
  RETURN acc;
END;
$$ LANGUAGE plpgsql;

-- Get or create email account
CREATE OR REPLACE FUNCTION get_or_create_email_account(
  p_email TEXT,
  p_display_name TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT 'gmail'
)
RETURNS email_accounts AS $$
DECLARE
  acc email_accounts%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM email_accounts WHERE email = p_email LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO email_accounts (email, display_name, provider)
    VALUES (p_email, p_display_name, p_provider)
    RETURNING * INTO acc;

    -- Create sync state
    INSERT INTO email_sync_state (account_id) VALUES (acc.id);
  END IF;

  RETURN acc;
END;
$$ LANGUAGE plpgsql;

-- Search emails semantically
CREATE OR REPLACE FUNCTION search_emails_semantic(
  p_query_embedding VECTOR(1536),
  p_account_id UUID DEFAULT NULL,
  p_match_threshold FLOAT DEFAULT 0.7,
  p_match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  date TIMESTAMPTZ,
  snippet TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id,
    em.subject,
    em.from_email,
    em.from_name,
    em.date,
    em.snippet,
    (1 - (em.embedding <=> p_query_embedding)) AS similarity
  FROM email_messages em
  WHERE em.embedding IS NOT NULL
    AND (p_account_id IS NULL OR em.account_id = p_account_id)
    AND (1 - (em.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY (em.embedding <=> p_query_embedding) ASC
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql;

-- Full-text search emails
CREATE OR REPLACE FUNCTION search_emails_text(
  p_query TEXT,
  p_account_id UUID DEFAULT NULL,
  p_match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  date TIMESTAMPTZ,
  snippet TEXT,
  rank FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id,
    em.subject,
    em.from_email,
    em.from_name,
    em.date,
    em.snippet,
    ts_rank(to_tsvector('english', coalesce(em.subject, '') || ' ' || coalesce(em.body_text, '')), plainto_tsquery('english', p_query)) AS rank
  FROM email_messages em
  WHERE
    (p_account_id IS NULL OR em.account_id = p_account_id)
    AND to_tsvector('english', coalesce(em.subject, '') || ' ' || coalesce(em.body_text, '')) @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql;

-- Get unread emails
CREATE OR REPLACE FUNCTION get_unread_emails(
  p_account_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  date TIMESTAMPTZ,
  snippet TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id,
    em.subject,
    em.from_email,
    em.from_name,
    em.date,
    em.snippet
  FROM email_messages em
  WHERE em.is_read = false
    AND (p_account_id IS NULL OR em.account_id = p_account_id)
  ORDER BY em.date DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Get email thread
CREATE OR REPLACE FUNCTION get_email_thread(
  p_thread_id TEXT
)
RETURNS TABLE (
  id UUID,
  gmail_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  date TIMESTAMPTZ,
  body_text TEXT,
  snippet TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id,
    em.gmail_id,
    em.subject,
    em.from_email,
    em.from_name,
    em.date,
    em.body_text,
    em.snippet
  FROM email_messages em
  WHERE em.thread_id = p_thread_id
  ORDER BY em.date ASC;
END;
$$ LANGUAGE plpgsql;

-- Update sync state
CREATE OR REPLACE FUNCTION update_sync_state(
  p_account_id UUID,
  p_history_id TEXT DEFAULT NULL,
  p_last_message_id TEXT DEFAULT NULL,
  p_messages_synced INT DEFAULT 0,
  p_status TEXT DEFAULT 'idle',
  p_error TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE email_sync_state SET
    history_id = COALESCE(p_history_id, history_id),
    last_message_id = COALESCE(p_last_message_id, last_message_id),
    last_sync_at = NOW(),
    sync_status = p_status,
    messages_synced = messages_synced + p_messages_synced,
    error_count = CASE WHEN p_error IS NOT NULL THEN error_count + 1 ELSE 0 END,
    last_error = p_error,
    updated_at = NOW()
  WHERE account_id = p_account_id;

  UPDATE email_accounts SET
    last_sync_at = NOW(),
    last_error = p_error,
    updated_at = NOW()
  WHERE id = p_account_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_accounts" ON email_accounts FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_sync" ON email_sync_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_messages" ON email_messages FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 6. LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Email sync schema v2.5 applied',
  '{"version": "20260216160000", "features": ["email_accounts", "email_sync_state", "email_messages", "semantic_search", "full_text_search"]}'::jsonb
);
