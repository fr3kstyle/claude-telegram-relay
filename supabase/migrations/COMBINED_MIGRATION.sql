-- ============================================================
-- COMBINED MIGRATION - Run in Supabase Dashboard SQL Editor
-- ============================================================
-- Paste this entire file into: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new
-- ============================================================

-- ============================================================
-- PART 1: GLOBAL_MEMORY EXTENSIONS & AGENT_LOOP_STATE
-- ============================================================

-- 1. Add missing columns to global_memory
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE global_memory ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- 2. Create agent_loop_state table if missing
CREATE TABLE IF NOT EXISTS agent_loop_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_type TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'paused', 'error')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_cycle_summary TEXT,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_state_main
  ON agent_loop_state(loop_type) WHERE loop_type = 'main';

INSERT INTO agent_loop_state (loop_type, status)
VALUES ('main', 'idle')
ON CONFLICT DO NOTHING;

ALTER TABLE agent_loop_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service_role_all" ON agent_loop_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- 3. Create goal_hygiene RPC
CREATE OR REPLACE FUNCTION goal_hygiene(
  p_days_stale INT DEFAULT 7,
  p_similarity_threshold FLOAT DEFAULT 0.8
)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  duplicates JSONB;
  stale_items JSONB;
  malformed JSONB;
  orphan_actions JSONB;
  blocked_overdue JSONB;
BEGIN
  -- Find potential duplicates
  SELECT jsonb_agg(DISTINCT jsonb_build_object(
    'content_preview', duplicate_key,
    'count', cnt,
    'ids', ids
  )) INTO duplicates
  FROM (
    SELECT
      SUBSTRING(LOWER(content), 1, 50) as duplicate_key,
      COUNT(*) as cnt,
      jsonb_agg(id) as ids
    FROM global_memory
    WHERE status IN ('active', 'pending')
    GROUP BY SUBSTRING(LOWER(content), 1, 50)
    HAVING COUNT(*) > 1
  ) dupes;

  -- Find stale items
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', SUBSTRING(content, 1, 80),
    'created_at', created_at,
    'days_old', EXTRACT(DAY FROM NOW() - created_at)::int
  )) INTO stale_items
  FROM global_memory
  WHERE status IN ('active', 'pending')
    AND created_at < NOW() - (p_days_stale || ' days')::interval
  ORDER BY created_at ASC
  LIMIT 50;

  -- Find malformed entries
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', content,
    'issue', CASE
      WHEN content IS NULL OR content = '' THEN 'empty_content'
      WHEN content LIKE ']`%' THEN 'malformed_prefix'
      WHEN content LIKE '%`[%' THEN 'malformed_injection'
      WHEN type IS NULL THEN 'missing_type'
      ELSE 'unknown'
    END
  )) INTO malformed
  FROM global_memory
  WHERE content IS NULL
     OR content = ''
     OR content LIKE ']`%'
     OR content LIKE '%`[%'
     OR type IS NULL
  LIMIT 20;

  -- Find orphan actions
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'content', SUBSTRING(content, 1, 60),
    'priority', priority,
    'created_at', created_at
  )) INTO orphan_actions
  FROM global_memory
  WHERE type = 'action'
    AND status = 'pending'
    AND parent_id IS NULL
  ORDER BY priority ASC, created_at ASC
  LIMIT 50;

  -- Find blocked items overdue
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'type', type,
    'content', SUBSTRING(content, 1, 60),
    'status', status,
    'days_blocked', EXTRACT(DAY FROM NOW() - created_at)::int
  )) INTO blocked_overdue
  FROM global_memory
  WHERE status = 'blocked'
    AND created_at < NOW() - INTERVAL '7 days'
  ORDER BY created_at ASC
  LIMIT 30;

  -- Build result
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'total_active_goals', (SELECT COUNT(*) FROM global_memory WHERE type = 'goal' AND status = 'active'),
      'total_pending_actions', (SELECT COUNT(*) FROM global_memory WHERE type = 'action' AND status = 'pending'),
      'total_blocked', (SELECT COUNT(*) FROM global_memory WHERE status = 'blocked'),
      'total_archived', (SELECT COUNT(*) FROM global_memory WHERE status = 'archived')
    ),
    'duplicates', COALESCE(duplicates, '[]'::jsonb),
    'stale_items', COALESCE(stale_items, '[]'::jsonb),
    'malformed', COALESCE(malformed, '[]'::jsonb),
    'orphan_actions', COALESCE(orphan_actions, '[]'::jsonb),
    'blocked_overdue', COALESCE(blocked_overdue, '[]'::jsonb),
    'recommendations', jsonb_build_array(
      'Archive stale items older than ' || p_days_stale || ' days',
      'Merge or delete duplicate entries',
      'Delete malformed entries',
      'Link orphan actions to parent goals or delete',
      'Review blocked items: resolve or archive with notes'
    ),
    'generated_at', NOW()
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 4. Create get_pending_actions RPC
CREATE OR REPLACE FUNCTION get_pending_actions(limit_count INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  content TEXT,
  priority INTEGER,
  parent_id UUID,
  retry_count INTEGER,
  status TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    gm.id,
    gm.content,
    gm.priority,
    gm.parent_id,
    gm.retry_count,
    gm.status,
    gm.created_at
  FROM global_memory gm
  WHERE gm.type = 'action'
    AND gm.status IN ('active', 'pending')
  ORDER BY gm.priority DESC NULLS LAST, gm.created_at ASC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- PART 2: EMAIL SYNC SYSTEM
-- ============================================================

-- 1. EMAIL ACCOUNTS TABLE
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

-- 2. EMAIL SYNC STATE TABLE
CREATE TABLE IF NOT EXISTS email_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  history_id TEXT,
  last_message_id TEXT,
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

-- 3. EMAIL MESSAGES TABLE
CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  to_recipients JSONB DEFAULT '[]',
  cc_recipients JSONB DEFAULT '[]',
  date TIMESTAMPTZ,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  labels JSONB DEFAULT '[]',
  is_read BOOLEAN DEFAULT true,
  is_starred BOOLEAN DEFAULT false,
  is_draft BOOLEAN DEFAULT false,
  is_important BOOLEAN DEFAULT false,
  attachments JSONB DEFAULT '[]',
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, gmail_id)
);

CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_from ON email_messages(from_email);
CREATE INDEX IF NOT EXISTS idx_email_messages_unread ON email_messages(account_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_email_messages_starred ON email_messages(account_id, is_starred) WHERE is_starred = true;
CREATE INDEX IF NOT EXISTS idx_email_messages_embedding ON email_messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_email_messages_search ON email_messages USING gin(to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body_text, '')));

-- 4. HELPER RPCs
CREATE OR REPLACE FUNCTION get_email_account(p_email TEXT)
RETURNS email_accounts AS $$
DECLARE
  acc email_accounts%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM email_accounts WHERE email = p_email LIMIT 1;
  RETURN acc;
END;
$$ LANGUAGE plpgsql;

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

    INSERT INTO email_sync_state (account_id) VALUES (acc.id);
  END IF;

  RETURN acc;
END;
$$ LANGUAGE plpgsql;

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

-- 5. ROW LEVEL SECURITY
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_accounts" ON email_accounts FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_sync" ON email_sync_state FOR ALL
  TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_messages" ON email_messages FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- 6. LOG MIGRATION
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'Combined migration applied - full schema v2.5',
  '{"version": "combined_20260216", "features": ["agent_loop_state", "global_memory_columns", "goal_hygiene", "email_sync_system"]}'::jsonb
);

-- Done!
SELECT 'MIGRATION COMPLETE! All tables and functions created.' as status;
