#!/bin/bash
# Fix Semantic Search Setup
# Run this script to diagnose and fix semantic search issues

echo "=== Semantic Search Diagnostics ==="
echo ""

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI not installed"
    echo "   Install with: npm install -g supabase"
    exit 1
fi
echo "✅ Supabase CLI installed"

# Check if we're in a Supabase project
if [ ! -f "supabase/config.toml" ]; then
    echo "⚠️  No supabase/config.toml found"
    echo "   Make sure you're in the project root and have linked the project:"
    echo "   supabase link --project-ref YOUR_PROJECT_REF"
fi

# Check if Edge Functions exist
echo ""
echo "=== Edge Functions ==="
if [ -d "supabase/functions/search" ]; then
    echo "✅ search function exists"
else
    echo "❌ search function missing"
fi

if [ -d "supabase/functions/embed" ]; then
    echo "✅ embed function exists"
else
    echo "❌ embed function missing"
fi

# Check for secrets
echo ""
echo "=== Required Secrets ==="
echo "Checking if OPENAI_API_KEY is set..."
echo "Run this command to set it:"
echo "  supabase secrets set OPENAI_API_KEY=sk-your-key-here"
echo ""

# Deployment instructions
echo "=== Deployment Commands ==="
echo "To deploy Edge Functions:"
echo "  supabase functions deploy embed"
echo "  supabase functions deploy search"
echo ""
echo "To set the OpenAI API key:"
echo "  supabase secrets set OPENAI_API_KEY=sk-your-key-here"
echo ""
echo "To verify deployment:"
echo "  supabase functions list"
echo ""

# Test the search function
echo "=== Test Search Function ==="
echo "After deployment, test with:"
echo '  curl -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/search" \\'
echo '    -H "Authorization: Bearer YOUR_ANON_KEY" \\'
echo '    -H "Content-Type: application/json" \\'
echo '    -d '\''{"query": "test search"}'\'''
echo ""

echo "=== Database Webhook ==="
echo "Remember to configure the webhook for auto-embedding:"
echo "1. Go to Database > Webhooks in Supabase Dashboard"
echo "2. Create webhook for INSERT on global_memory table"
echo "3. Point to 'embed' Edge Function"
