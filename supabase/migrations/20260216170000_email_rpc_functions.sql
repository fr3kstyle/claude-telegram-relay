-- ============================================================
-- Email RPC Functions - Apply via Supabase Dashboard SQL Editor
-- ============================================================
-- These functions were missing from the initial email schema migration.
-- Run this file in: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new

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

-- Log migration
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Email RPC functions applied',
  '{"version": "20260216170000", "functions": ["search_emails_semantic", "search_emails_text", "get_unread_emails", "get_email_thread", "update_sync_state"]}'::jsonb
);
