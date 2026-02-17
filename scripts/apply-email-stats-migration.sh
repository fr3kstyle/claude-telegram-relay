#!/bin/bash
# Apply email_stats_rpc.sql migration to Supabase
# 
# Requirements (one of):
#   1. SUPABASE_ACCESS_TOKEN env var set (from https://supabase.com/dashboard/account/tokens)
#   2. Run manually via: https://supabase.com/dashboard/project/nlkgqooefwbupwubloae/sql/new
#   3. DB password via: supabase link --project-ref nlkgqooefwbupwubloae

set -e

PROJECT_REF="nlkgqooefwbupwubloae"
MIGRATION_FILE="supabase/migrations/20260217020000_email_stats_rpc.sql"

echo "=== Email Stats RPC Migration ==="
echo ""

# Check for access token
if [ -n "$SUPABASE_ACCESS_TOKEN" ]; then
    echo "Found SUPABASE_ACCESS_TOKEN, attempting CLI deployment..."
    
    # Login with token
    echo "$SUPABASE_ACCESS_TOKEN" | supabase login --token
    
    # Link project (will prompt for DB password if not cached)
    supabase link --project-ref "$PROJECT_REF"
    
    # Push the specific migration
    supabase db push --linked
    
    echo "Migration applied successfully!"
    exit 0
fi

# No access token - provide manual instructions
echo "No SUPABASE_ACCESS_TOKEN found."
echo ""
echo "To apply this migration manually:"
echo ""
echo "1. Open: https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
echo ""
echo "2. Paste the contents of: $MIGRATION_FILE"
echo ""
echo "3. Click 'Run' to execute"
echo ""
echo "Functions that will be created:"
echo "  - get_email_stats(p_account_id, p_since_days)"
echo "  - get_email_volume_by_period(p_account_id, p_period, p_since_days)"
echo "  - get_top_senders(p_account_id, p_limit, p_since_days)"
echo "  - get_email_account_health()"
echo "  - get_recent_email_summary(p_account_id, p_hours)"
echo "  - get_label_distribution(p_account_id, p_limit)"
echo ""
echo "Alternative: Set SUPABASE_ACCESS_TOKEN and re-run this script."
