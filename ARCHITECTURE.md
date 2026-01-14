# Git-Archiver Web - Architecture & Implementation Plan

A free, serverless GitHub repository archiving service. When anyone submits a repo URL, it gets cloned, archived, and stored - benefiting all users as a shared cache.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   User visits site  ──▶  Enters GitHub URL  ──▶  Clicks "Archive"           │
│                                                                              │
│         │                                              │                     │
│         ▼                                              ▼                     │
│   Sees existing                              Cloudflare Worker               │
│   archives list                              creates GitHub Issue            │
│                                                                              │
│                                                        │                     │
│                                                        ▼                     │
│                                              GitHub Actions triggers         │
│                                              (clones repo, creates archive)  │
│                                                                              │
│                                                        │                     │
│                                                        ▼                     │
│                                              Archive stored in               │
│                                              GitHub Releases                 │
│                                                                              │
│         │                                              │                     │
│         └──────────────────┬───────────────────────────┘                     │
│                            ▼                                                 │
│                    User can download                                         │
│                    any archived repo                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Architecture Components

### 1. Frontend (GitHub Pages - FREE)

Static site hosted on GitHub Pages.

**Features:**
- Search/browse archived repositories
- Submit new repository URLs for archiving
- View archive history and download links
- Real-time status of pending archives
- No login required

**Tech Stack:**
- Vanilla JS or lightweight framework (Preact/Svelte)
- Tailwind CSS for styling
- Fetches data from GitHub API (releases, issues)

### 2. Submission Proxy (Cloudflare Workers - FREE)

Tiny serverless function that handles URL submissions.

**Why needed:**
- GitHub API requires authentication to create issues
- We don't want to expose tokens in the frontend
- Cloudflare Workers free tier: 100,000 requests/day

**Flow:**
```
Frontend POST /submit {url: "https://github.com/user/repo"}
    │
    ▼
Cloudflare Worker
    │
    ├── Validates URL format
    ├── Checks if already archived (optional)
    ├── Creates GitHub Issue with label "archive-request"
    │
    ▼
Returns {success: true, issue_number: 123}
```

### 3. Archive Engine (GitHub Actions - FREE)

Automated workflows that process archive requests.

**Triggers:**
- On issue creation with label `archive-request`
- Scheduled daily run to update existing archives
- Manual dispatch for maintenance

**Process:**
```
1. Parse repo URL from issue body
2. Validate repository exists (GitHub API)
3. Check size (skip if > 2GB)
4. Clone repository
5. Create .tar.gz archive
6. Upload to GitHub Releases
7. Update index.json
8. Close issue with success/failure comment
```

### 4. Storage (GitHub Releases - FREE)

All archives stored as release assets.

**Structure:**
```
Releases:
├── repo-index (tag: index)
│   └── index.json (master list of all archived repos)
│
├── user__repo__2024-01-15 (tag: user__repo__2024-01-15)
│   ├── repo.tar.gz (the archive)
│   └── metadata.json (size, commit hash, description)
│
├── user__repo__2024-02-20 (tag: user__repo__2024-02-20)
│   ├── repo.tar.gz
│   └── metadata.json
...
```

**Naming Convention:**
- Tag: `{owner}__{repo}__{date}` (double underscore as separator)
- Example: `facebook__react__2024-01-15`

## Data Structures

### index.json (Master Index)

```json
{
  "last_updated": "2024-01-15T12:00:00Z",
  "total_repos": 150,
  "total_size_mb": 4500,
  "repositories": {
    "https://github.com/facebook/react": {
      "owner": "facebook",
      "repo": "react",
      "description": "A declarative, efficient, and flexible JavaScript library...",
      "status": "active",
      "first_archived": "2024-01-10T08:00:00Z",
      "last_archived": "2024-01-15T08:00:00Z",
      "archive_count": 3,
      "latest_release_tag": "facebook__react__2024-01-15",
      "latest_size_mb": 45.2,
      "latest_commit": "abc123def"
    }
  }
}
```

### metadata.json (Per-Archive Metadata)

```json
{
  "url": "https://github.com/facebook/react",
  "owner": "facebook",
  "repo": "react",
  "archived_at": "2024-01-15T08:00:00Z",
  "commit_hash": "abc123def456",
  "commit_date": "2024-01-14T15:30:00Z",
  "description": "A declarative, efficient, and flexible JavaScript library...",
  "size_bytes": 47433728,
  "file_count": 1250,
  "is_fork": false,
  "stars": 220000,
  "original_status": "active"
}
```

### Issue Format (Archive Requests)

```markdown
Title: Archive Request: facebook/react

---
url: https://github.com/facebook/react
requested_at: 2024-01-15T12:00:00Z
requester_ip_hash: a1b2c3 (optional, for rate limiting)
---
```

## File Structure

```
git-archiver-web/
├── README.md
├── ARCHITECTURE.md          # This file
│
├── frontend/
│   ├── index.html           # Main page
│   ├── css/
│   │   └── styles.css       # Tailwind or custom CSS
│   ├── js/
│   │   ├── app.js           # Main application logic
│   │   ├── api.js           # API calls (GitHub, Worker)
│   │   └── utils.js         # Helper functions
│   └── assets/
│       └── logo.svg
│
├── worker/
│   ├── wrangler.toml        # Cloudflare config
│   └── src/
│       └── index.js         # Worker code
│
├── .github/
│   └── workflows/
│       ├── archive.yml      # Main archive workflow
│       ├── update-index.yml # Daily index update
│       └── cleanup.yml      # Remove old archives (optional)
│
└── scripts/
    └── setup.sh             # Initial setup script
```

## Implementation Details

### Frontend (index.html + app.js)

**Pages/Views:**

1. **Home/Search View**
   - Search bar to find archived repos
   - Grid/list of recently archived repos
   - Stats (total repos, total size, etc.)

2. **Submit View**
   - URL input field
   - Validation feedback
   - Submit button
   - Queue position indicator

3. **Repository Detail View**
   - All archive versions
   - Download links
   - Metadata (size, date, commit)
   - Original GitHub link

**API Calls:**

```javascript
// Fetch index (cached via GitHub CDN)
GET https://github.com/{owner}/{repo}/releases/download/index/index.json

// Submit new URL
POST https://your-worker.workers.dev/submit
Body: { url: "https://github.com/user/repo" }

// Check pending requests
GET https://api.github.com/repos/{owner}/{repo}/issues?labels=archive-request&state=open
```

### Cloudflare Worker (index.js)

```javascript
// Pseudocode structure
export default {
  async fetch(request, env) {
    // CORS headers
    if (request.method === "OPTIONS") {
      return handleCORS();
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      const { url } = await request.json();

      // Validate GitHub URL
      if (!isValidGitHubUrl(url)) {
        return error(400, "Invalid GitHub URL");
      }

      // Rate limiting (by IP)
      const ip = request.headers.get("CF-Connecting-IP");
      if (await isRateLimited(ip, env)) {
        return error(429, "Too many requests");
      }

      // Check if already archived recently
      if (await isRecentlyArchived(url, env)) {
        return json({ status: "already_archived", message: "..." });
      }

      // Create GitHub issue
      const issue = await createGitHubIssue(url, env.GITHUB_TOKEN);

      return json({ success: true, issue_number: issue.number });
    }

    return error(404, "Not found");
  }
}
```

**Environment Variables (Cloudflare Secrets):**
- `GITHUB_TOKEN`: Personal Access Token with `repo` scope
- `REPO_OWNER`: Your GitHub username
- `REPO_NAME`: Repository name (e.g., "git-archiver-web")

### GitHub Actions Workflow (archive.yml)

```yaml
name: Archive Repository

on:
  issues:
    types: [opened, labeled]
  workflow_dispatch:
    inputs:
      url:
        description: 'Repository URL to archive'
        required: true

jobs:
  archive:
    runs-on: ubuntu-latest
    if: contains(github.event.issue.labels.*.name, 'archive-request') || github.event_name == 'workflow_dispatch'

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Parse URL
        id: parse
        run: |
          # Extract URL from issue body or input
          # Set outputs: owner, repo, url

      - name: Validate Repository
        id: validate
        run: |
          # Check repo exists
          # Check size < 2GB
          # Get metadata

      - name: Clone Repository
        if: steps.validate.outputs.valid == 'true'
        run: |
          git clone --depth 100 ${{ steps.parse.outputs.url }} repo

      - name: Create Archive
        run: |
          tar -czf archive.tar.gz -C repo .

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: ${{ steps.parse.outputs.owner }}__${{ steps.parse.outputs.repo }}__${{ steps.parse.outputs.date }}
          files: |
            archive.tar.gz
            metadata.json

      - name: Update Index
        run: |
          # Download current index
          # Add/update entry
          # Upload new index

      - name: Close Issue
        if: github.event_name == 'issues'
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '✅ Archive created successfully!\n\nDownload: [link]'
            });
            github.rest.issues.update({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              state: 'closed'
            });
```

## Rate Limiting & Abuse Prevention

### Cloudflare Worker Rate Limits

```javascript
// KV-based rate limiting
const RATE_LIMIT = {
  requests_per_hour: 10,      // Per IP
  requests_per_day: 30,       // Per IP
  global_per_hour: 100,       // Total
};
```

### Repository Validation

Before archiving, check:
1. Repository exists (not 404)
2. Repository size < 2GB
3. Not already archived in last 24 hours
4. Not on blocklist (optional)

### Size Limits

| Check | Limit | Action |
|-------|-------|--------|
| Repo size (via API) | > 2GB | Reject with message |
| Clone timeout | 30 minutes | Fail job |
| Archive size | > 2GB | Split or reject |

## Limitations & Considerations

### GitHub API Rate Limits

| Auth Type | Limit |
|-----------|-------|
| Unauthenticated | 60/hour |
| Personal Access Token | 5,000/hour |
| GitHub Actions (GITHUB_TOKEN) | 1,000/hour |

**Mitigation:**
- Cache index.json (users fetch from Releases, not API)
- Frontend fetches open issues directly (unauthenticated)
- Worker uses PAT for issue creation only

### Storage Limits

| Resource | Limit |
|----------|-------|
| Single release asset | 2 GB |
| Total releases | Unlimited* |
| Repository size | 5 GB (soft) |

*GitHub may contact you if storing excessive data

### GitHub Actions Limits

| Resource | Limit |
|----------|-------|
| Job execution time | 6 hours |
| Workflow run time | 72 hours |
| Concurrent jobs (free) | 20 |
| Monthly minutes (free, public) | Unlimited |
| Monthly minutes (free, private) | 2,000 |

**Recommendation:** Keep repository PUBLIC for unlimited Actions minutes.

## Security Considerations

1. **GitHub Token Scope**
   - Use minimal scope: `public_repo` only
   - Store in Cloudflare Workers secrets
   - Rotate periodically

2. **Input Validation**
   - Strict URL regex validation
   - Sanitize all user input
   - Prevent path traversal in archive names

3. **Rate Limiting**
   - IP-based rate limiting in Worker
   - Global rate limiting
   - Blocklist for abuse

4. **No User Data**
   - No accounts, no personal data
   - Only store: IP hashes (for rate limiting), repo URLs

## Deployment Checklist

### Initial Setup

1. [ ] Create new GitHub repository `git-archiver-web`
2. [ ] Enable GitHub Pages (Settings > Pages > Source: main/docs or gh-pages)
3. [ ] Create Personal Access Token (Settings > Developer > PAT)
   - Scope: `public_repo`
4. [ ] Create Cloudflare account (free)
5. [ ] Deploy Worker with `wrangler`
6. [ ] Add secrets to Worker: `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`
7. [ ] Create initial `index` release with empty index.json
8. [ ] Test end-to-end flow

### Domain Setup (Optional)

1. [ ] Register domain or use `username.github.io`
2. [ ] Configure Cloudflare DNS (if using custom domain)
3. [ ] Update CORS in Worker

## Cost Analysis

| Service | Free Tier | Our Usage | Cost |
|---------|-----------|-----------|------|
| GitHub Pages | Unlimited | Static site | $0 |
| GitHub Actions | Unlimited (public) | ~100 jobs/day | $0 |
| GitHub Releases | Unlimited* | ~10GB/month | $0 |
| Cloudflare Workers | 100k req/day | ~1k req/day | $0 |
| Cloudflare KV | 100k reads/day | ~5k reads/day | $0 |

**Total: $0/month** (within free tiers)

## Future Enhancements

1. **Search Improvements**
   - Full-text search via Algolia (free tier)
   - Filter by language, size, date

2. **Archive Formats**
   - Option for .tar.xz (smaller) vs .tar.gz (faster)
   - Include only specific branches

3. **Notifications**
   - RSS feed of new archives
   - Webhook when specific repo archived

4. **Redundancy**
   - Mirror to Internet Archive
   - IPFS pinning (via Pinata free tier)

5. **Statistics Dashboard**
   - Most requested repos
   - Archive success rate
   - Storage trends
