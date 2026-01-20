# Tech Stack

## Overview

I built Git-Archiver Web as a fully serverless application using only free-tier services. The stack prioritizes simplicity, zero operational cost, and minimal dependencies.

## Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| HTML5 | - | Semantic markup |
| CSS3 | - | Custom styling with CSS variables |
| JavaScript | ES2020+ | Application logic |

### Frontend Details

**No Framework**: I intentionally avoided React, Vue, or other frameworks. The entire frontend is ~40KB uncompressed, with no build step required.

**Styling Approach**:
- Custom CSS with CSS variables for theming
- Dark theme by default (GitHub-inspired color palette)
- Fully responsive design with mobile-first breakpoints
- No CSS frameworks (no Tailwind, Bootstrap)

**JavaScript Architecture**:
- **app.js** (24KB): Main application with state management, event handling, and rendering
- **api.js** (8KB): API client with all HTTP requests abstracted
- **utils.js** (6KB): Pure utility functions (formatting, validation, DOM helpers)

### Why Vanilla JS?

1. **No build step**: Just edit and deploy
2. **Fast load times**: ~40KB total vs 100KB+ for React alone
3. **Simplicity**: Easy to understand and modify
4. **Browser support**: Works in all modern browsers without transpilation

## Backend (Cloudflare Worker)

| Technology | Version | Purpose |
|------------|---------|---------|
| Cloudflare Workers | V8 Runtime | Serverless API |
| Wrangler | ^3.0.0 | CLI for deployment |

### Worker Details

**Runtime**: Cloudflare Workers run on the V8 engine (same as Chrome/Node.js), providing excellent performance with a cold start under 5ms.

**Code Size**: ~700 lines of JavaScript handling:
- URL validation and routing
- GitHub API integration
- CORS handling
- Rate limiting (prepared for KV)

**Endpoints**:
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/submit` | POST | Submit single repo URL |
| `/bulk-submit` | POST | Submit up to 20 URLs |
| `/index` | GET | Fetch master index (proxied) |
| `/readme` | GET | Fetch archived README |
| `/status` | GET | Check if original repo exists |
| `/health` | GET | Health check |

### Why Cloudflare Workers?

1. **Free tier**: 100,000 requests/day
2. **Global edge**: Low latency worldwide
3. **No cold starts**: Instant response times
4. **Built-in secrets**: Secure token storage

## Processing (GitHub Actions)

| Component | Purpose |
|-----------|---------|
| archive.yml | Main archive workflow |
| update-archives.yml | Daily re-archive job |
| pages.yml | Frontend deployment |

### Workflow Details

**archive.yml** (~470 lines):
- Triggers on issue creation with `archive-request` label
- Validates repository existence and size
- Clones with depth 100 (balances speed vs history)
- Creates tar.gz archive
- Calculates SHA256 for deduplication
- Uploads to GitHub Releases
- Updates master index
- Comments on and closes issue

**update-archives.yml** (~100 lines):
- Runs daily at 3 AM UTC
- Selects oldest archives for re-checking
- Triggers archive workflow via dispatch
- Smart deduplication prevents duplicate releases

### Why GitHub Actions?

1. **Unlimited minutes**: Free for public repositories
2. **Native GitHub integration**: Built-in GITHUB_TOKEN
3. **Event-driven**: Triggers on issues without polling
4. **Powerful runners**: 2-core machines with 7GB RAM

## Storage

| Service | Purpose | Limits |
|---------|---------|--------|
| GitHub Releases | Archive storage | 2GB per asset |
| GitHub Pages | Frontend hosting | Unlimited bandwidth |

### Storage Structure

```
Releases/
  index (tag)
    index.json          # Master index of all repos

  owner__repo__date (tag)
    owner_repo.tar.gz   # Archive file
    metadata.json       # Size, hash, stars, etc.
    README.md           # Extracted README
```

### Why GitHub Releases?

1. **Free unlimited storage**: No explicit limits for public repos
2. **CDN-backed**: Fast global downloads
3. **Versioning**: Natural support for multiple versions
4. **API accessible**: Easy to query and download

## Infrastructure

| Service | Tier | Cost |
|---------|------|------|
| GitHub | Free | $0 |
| Cloudflare Workers | Free | $0 |
| Domain (optional) | - | $0 (using github.io) |

### Deployment

**Frontend**:
- Automatic deployment via GitHub Actions on push to main
- GitHub Pages serves from `frontend/` directory
- No build step required

**Worker**:
```bash
cd worker
npx wrangler deploy
```

**Secrets**:
- `GITHUB_TOKEN`: Personal Access Token (repo scope)
- `GITHUB_OWNER`: Repository owner
- `GITHUB_REPO`: Repository name

## Key Dependencies

### Worker Dependencies

| Package | Version | Reason |
|---------|---------|--------|
| wrangler | ^3.0.0 | Cloudflare CLI for development and deployment |

I kept dependencies minimal. The worker itself uses no external packages - just vanilla JavaScript with the Workers API.

### GitHub Actions

| Action | Version | Reason |
|--------|---------|--------|
| actions/checkout | v4 | Clone repository |
| softprops/action-gh-release | v1 | Create releases |
| actions/github-script | v7 | Issue management |
| actions/configure-pages | v4 | Pages deployment |
| actions/upload-pages-artifact | v3 | Upload static files |
| actions/deploy-pages | v4 | Deploy to Pages |

## Development Setup

### Prerequisites

- Node.js 18+
- Cloudflare account (free)
- GitHub account with PAT

### Local Development

```bash
# Frontend (any static server)
cd frontend
npx serve .
# Opens at http://localhost:3000

# Worker
cd worker
npm install
npx wrangler dev
# Opens at http://localhost:8787
```

### Environment Variables

| Variable | Location | Description |
|----------|----------|-------------|
| GITHUB_TOKEN | Cloudflare Secrets | PAT with repo scope |
| GITHUB_OWNER | Cloudflare Secrets | Your GitHub username |
| GITHUB_REPO | Cloudflare Secrets | Repository name |

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Frontend load time | <1s (40KB total) |
| Worker cold start | <5ms |
| Archive creation | 2-10 minutes |
| Index fetch | <100ms |

## Scalability

| Component | Limit | Notes |
|-----------|-------|-------|
| Worker requests | 100K/day | Free tier |
| Actions minutes | Unlimited | Public repos |
| Storage | Unlimited | GitHub may contact at scale |
| Concurrent archives | 20 | GitHub Actions limit |

## Future Stack Considerations

If I needed to scale beyond free tiers:

1. **Workers Paid ($5/mo)**: 10M requests, KV storage
2. **GitHub Pro ($4/mo)**: Private repos, more Actions minutes
3. **Custom domain**: More professional appearance
4. **Algolia (free tier)**: Full-text search
5. **IPFS/Pinata**: Redundant storage
