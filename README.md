# Git-Archiver Web

A free, serverless web service for archiving public GitHub repositories. Paste a repo URL, get a permanent `.tar.gz` snapshot hosted on GitHub Releases.

The whole stack runs on free tiers: a vanilla-JS frontend on GitHub Pages, a Cloudflare Worker proxy that keeps the GitHub token off the client, and a GitHub Actions workflow that clones, compresses, and publishes the archive. No accounts, no servers, no database.

## Features

- **One-click archiving** — paste a `github.com/owner/repo` URL and the worker queues a job by opening a labelled issue on the archive repo
- **Bulk submit** — submit up to 20 repos at once
- **Content-addressed dedupe** — each archive's SHA-256 is stored in metadata; a re-archive that matches the previous hash is skipped instead of creating a duplicate release
- **Live source-status badges** — repo cards show whether the original GitHub repo is still public, deleted, or private
- **README preview** — the worker proxies the archived README so it renders in the detail modal without CORS pain
- **Daily refresh job** — `update-archives.yml` re-checks the oldest entries and re-archives only those that changed
- **Searchable index** — `index.json` is a single release asset listing every archived repo, fetched once and filtered client-side

## Tech Stack

- **Frontend**: HTML/CSS + vanilla JavaScript (no framework, no build step), deployed to GitHub Pages
- **API proxy**: Cloudflare Workers (V8 runtime), managed with Wrangler 3
- **Archive engine**: GitHub Actions (`archive.yml`, ~800 lines of workflow)
- **Storage**: GitHub Releases — `.tar.gz` + `metadata.json` + extracted `README.md` per archive, plus a single `index` release holding the master `index.json`

## Getting Started

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is enough)
- A GitHub account and a Personal Access Token with `repo` scope

### Local development

```bash
# Frontend — any static server works
cd frontend
npx serve .

# Worker
cd worker
npm install
npx wrangler dev
```

### Deployment

```bash
# Deploy the worker
cd worker
npx wrangler deploy

# Frontend deploys automatically via pages.yml on push to main
```

The worker needs three secrets set via `wrangler secret put`: `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPO`.

## Project Structure

```
git-archiver-web/
├── frontend/           # Static site served by GitHub Pages
│   ├── index.html
│   ├── about.html
│   ├── css/
│   └── js/             # app.js, api.js, utils.js
├── worker/             # Cloudflare Worker (submission proxy)
│   └── src/index.js
├── .github/workflows/
│   ├── archive.yml         # archive engine, triggered by issue label
│   ├── update-archives.yml # daily re-archive job
│   └── pages.yml           # frontend deploy
└── scripts/            # setup and index-recovery scripts
```

## Limits

| Limit | Value |
|-------|-------|
| Max repo size | 2 GB (GitHub Release asset cap) |
| Submissions per IP/hour | 10 (configurable via Cloudflare KV) |
| Clone depth | 100 commits (speed vs. history trade-off) |
| Private repos | Not supported — public only |

## License

MIT

## Author

Jacob Kanfer — [GitHub](https://github.com/Technical-1)
