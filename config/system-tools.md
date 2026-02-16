# System Tools Configuration

## Available Tools

### Core Tools
- **Bash** - Execute shell commands
- **Read** - Read files
- **Write** - Write files
- **Edit** - Edit files in place
- **Glob** - Find files by pattern
- **Grep** - Search file contents

### Web Tools
- **WebSearch** - Search the web
- **WebFetch** - Fetch URL content
- **mcp__web-reader__webReader** - Extract content from URLs

### Browser Automation (Playwright)
- **browser.start** - Start browser session
- **browser.close** - Close browser
- **browser.go** - Navigate to URL
- **browser.screenshot** - Capture screenshot
- **browser.click** - Click element
- **browser.type** - Type into input
- **browser.content** - Get page HTML
- **browser.text** - Get text from selector
- **browser.wait** - Wait for selector
- **browser.eval** - Execute JavaScript
- **browser.form** - Fill form with data
- **browser.scrape** - Scrape data from page

### Vision Tools
- **mcp__zai-mcp-server__analyze_image** - General image analysis
- **mcp__zai-mcp-server__analyze_data_visualization** - Charts/graphs
- **mcp__zai-mcp-server__diagnose_error_screenshot** - Error screenshots
- **mcp__zai-mcp-server__extract_text_from_screenshot** - OCR
- **mcp__zai-mcp-server__ui_to_artifact** - UI to code
- **mcp__zai-mcp-server__analyze_video** - Video analysis

### GitHub Tools
- **mcp__zread__get_repo_structure** - Repo structure
- **mcp__zread__read_file** - Read GitHub files
- **mcp__zread__search_doc** - Search repo docs

### Task Management
- **Task** - Spawn sub-agents
- **TaskCreate** - Create tasks
- **TaskUpdate** - Update tasks
- **TaskList** - List tasks
- **TaskGet** - Get task details

## Tool Selection Rules

1. Use specialized tools over general ones
2. Batch independent operations
3. Prefer Read over `cat`, Edit over `sed`
4. Use Glob for file finding, not `find`
5. Use Grep for content search, not `grep`

## Dangerous Operations

These require confirmation:
- `rm -rf`
- `git push --force`
- `systemctl stop/restart`
- Database drops
- File overwrites
