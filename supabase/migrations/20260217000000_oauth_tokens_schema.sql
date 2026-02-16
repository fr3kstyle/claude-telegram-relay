-- ============================================================
-- Schema v2.6: OAuth Token Storage
-- ============================================================
-- Encrypted OAuth token storage for multiple providers.
-- Replaces file-based token storage with database-backed encrypted storage.
--
-- Tables:
-- - oauth_tokens: Encrypted OAuth tokens per account/provider
--
-- Security:
-- - Tokens are encrypted at rest using AES-256-GCM
-- - Encryption key comes from ENCRYPTION_KEY env var
-- - RLS policies restrict access to service_role only

-- ============================================================
-- 1. OAUTH TOKENS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL
    CHECK (provider IN ('google', 'microsoft', 'github', 'custom')),
  email TEXT NOT NULL,  -- Account email/identifier
  access_token_encrypted TEXT NOT NULL,  -- Encrypted access token
  refresh_token_encrypted TEXT,  -- Encrypted refresh token (may be null for some providers)
  token_expiry TIMESTAMPTZ,  -- When access token expires
  scopes JSONB DEFAULT '[]',  -- Granted OAuth scopes
  token_metadata JSONB DEFAULT '{}',  -- Provider-specific metadata
  is_valid BOOLEAN DEFAULT true,  -- Token validity flag
  last_used_at TIMESTAMPTZ,  -- Last time token was used
  error_count INTEGER DEFAULT 0,  -- Consecutive errors
  last_error TEXT,  -- Last error message
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, email)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider_email ON oauth_tokens(provider, email);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_valid ON oauth_tokens(is_valid) WHERE is_valid = true;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(token_expiry) WHERE token_expiry IS NOT NULL;

-- ============================================================
-- 2. HELPER RPCs
-- ============================================================

-- Get token by provider and email
CREATE OR REPLACE FUNCTION get_oauth_token(
  p_provider TEXT,
  p_email TEXT
)
RETURNS oauth_tokens AS $$
DECLARE
  tok oauth_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM oauth_tokens
  WHERE provider = p_provider AND email = p_email
  LIMIT 1;
  RETURN tok;
END;
$$ LANGUAGE plpgsql;

-- Get all valid tokens for a provider
CREATE OR REPLACE FUNCTION get_valid_oauth_tokens(
  p_provider TEXT
)
RETURNS SETOF oauth_tokens AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM oauth_tokens
  WHERE provider = p_provider
    AND is_valid = true
    AND (token_expiry IS NULL OR token_expiry > NOW())
  ORDER BY email;
END;
$$ LANGUAGE plpgsql;

-- Get all tokens expiring soon (for refresh)
CREATE OR REPLACE FUNCTION get_tokens_expiring_soon(
  p_within_hours INT DEFAULT 1
)
RETURNS SETOF oauth_tokens AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM oauth_tokens
  WHERE is_valid = true
    AND token_expiry IS NOT NULL
    AND token_expiry <= NOW() + (p_within_hours || ' hours')::interval
    AND token_expiry > NOW()
  ORDER BY token_expiry ASC;
END;
$$ LANGUAGE plpgsql;

-- Update token after refresh
CREATE OR REPLACE FUNCTION update_oauth_token(
  p_provider TEXT,
  p_email TEXT,
  p_access_token_encrypted TEXT,
  p_refresh_token_encrypted TEXT DEFAULT NULL,
  p_token_expiry TIMESTAMPTZ DEFAULT NULL,
  p_scopes JSONB DEFAULT NULL
)
RETURNS oauth_tokens AS $$
DECLARE
  tok oauth_tokens%ROWTYPE;
BEGIN
  UPDATE oauth_tokens SET
    access_token_encrypted = p_access_token_encrypted,
    refresh_token_encrypted = COALESCE(p_refresh_token_encrypted, refresh_token_encrypted),
    token_expiry = p_token_expiry,
    scopes = COALESCE(p_scopes, scopes),
    is_valid = true,
    error_count = 0,
    last_error = NULL,
    updated_at = NOW()
  WHERE provider = p_provider AND email = p_email
  RETURNING * INTO tok;

  RETURN tok;
END;
$$ LANGUAGE plpgsql;

-- Record token usage
CREATE OR REPLACE FUNCTION record_token_usage(
  p_provider TEXT,
  p_email TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE oauth_tokens SET
    last_used_at = NOW(),
    updated_at = NOW()
  WHERE provider = p_provider AND email = p_email;
END;
$$ LANGUAGE plpgsql;

-- Record token error
CREATE OR REPLACE FUNCTION record_token_error(
  p_provider TEXT,
  p_email TEXT,
  p_error TEXT,
  p_invalidate BOOLEAN DEFAULT false
)
RETURNS VOID AS $$
BEGIN
  UPDATE oauth_tokens SET
    error_count = error_count + 1,
    last_error = p_error,
    is_valid = CASE WHEN p_invalidate THEN false ELSE is_valid END,
    updated_at = NOW()
  WHERE provider = p_provider AND email = p_email;
END;
$$ LANGUAGE plpgsql;

-- Upsert token (create or update)
CREATE OR REPLACE FUNCTION upsert_oauth_token(
  p_provider TEXT,
  p_email TEXT,
  p_access_token_encrypted TEXT,
  p_refresh_token_encrypted TEXT DEFAULT NULL,
  p_token_expiry TIMESTAMPTZ DEFAULT NULL,
  p_scopes JSONB DEFAULT '[]'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS oauth_tokens AS $$
DECLARE
  tok oauth_tokens%ROWTYPE;
BEGIN
  INSERT INTO oauth_tokens (
    provider, email, access_token_encrypted, refresh_token_encrypted,
    token_expiry, scopes, token_metadata
  )
  VALUES (
    p_provider, p_email, p_access_token_encrypted, p_refresh_token_encrypted,
    p_token_expiry, p_scopes, p_metadata
  )
  ON CONFLICT (provider, email) DO UPDATE SET
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, oauth_tokens.refresh_token_encrypted),
    token_expiry = EXCLUDED.token_expiry,
    scopes = EXCLUDED.scopes,
    token_metadata = EXCLUDED.token_metadata,
    is_valid = true,
    error_count = 0,
    last_error = NULL,
    updated_at = NOW()
  RETURNING * INTO tok;

  RETURN tok;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Only service_role can access tokens (they're encrypted, but still sensitive)
CREATE POLICY "service_role_only_oauth_tokens" ON oauth_tokens FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 4. LOG MIGRATION
-- ============================================================
INSERT INTO logs_v2 (event, message, metadata)
VALUES (
  'schema_migration',
  'OAuth tokens schema v2.6 applied',
  '{"version": "20260217000000", "features": ["oauth_tokens", "encrypted_storage", "token_lifecycle_rpcs"]}'::jsonb
);
