# Tech Stack

## Core Technologies

| Category | Technology | Version | Why this choice |
|----------|------------|---------|-----------------|
| Frontend language | JavaScript (ES2020+) | — | No build step, no transpile pipeline, works in every modern browser |
| Frontend markup/style | HTML5 + CSS3 (custom, no framework) | — | The UI is small; a framework would be heavier than the app |
| Edge runtime | Cloudflare Workers (V8) | — | Free tier covers traffic, sub-5ms cold starts, built-in secrets |
| Worker tooling | Wrangler | ^3.0.0 | Cloudflare's official CLI; only worker dev dependency |
| CI/CD + compute | GitHub Actions | — | Unlimited minutes on public repos; native triggers from Issues |
| Storage | GitHub Releases | — | Free, CDN-backed, supports per-archive versioning |

## Frontend

- **Framework**: none — plain HTML + a few vanilla-JS modules
- **State management**: a single in-memory store inside `app.js`
- **Styling**: handwritten CSS with custom properties for theming; dark theme by default; mobile-first breakpoints
- **Build tool**: none — files are served as-is from `frontend/` by GitHub Pages

### Frontend modules

| File | Lines | Role |
|------|-------|------|
| `frontend/js/app.js` | ~860 | App state, event handlers, rendering of the repo grid and detail modal |
| `frontend/js/api.js` | ~430 | Fetch wrappers around the Worker's endpoints |
| `frontend/js/utils.js` | ~440 | Formatters, URL parsers, DOM helpers, validation |

## Backend (Cloudflare Worker)

- **Runtime**: Cloudflare Workers V8 isolates
- **Entry point**: `worker/src/index.js` (~1,200 lines)
- **Dependencies at runtime**: none — only the Workers API and `fetch`
- **Auth model**: Worker holds the GitHub PAT in Wrangler secrets; the frontend is unauthenticated

### Worker endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/submit` | POST | Submit a single repo URL |
| `/bulk-submit` | POST | Submit up to 20 URLs at once |
| `/index` | GET | Proxy fetch of the master `index.json` |
| `/readme` | GET | Proxy fetch of an archived README |
| `/status` | GET | Check whether the original repo is still public |
| `/health` | GET | Health check |

## Processing (GitHub Actions)

| Workflow | Trigger | Role |
|----------|---------|------|
| `archive.yml` | `issues.opened` with label `archive-request` | Clone, hash, dedupe, publish release, update index |
| `update-archives.yml` | Scheduled cron | Dispatch `archive.yml` against the oldest entries |
| `pages.yml` | Push to `main` | Build and publish `frontend/` to GitHub Pages |

Key external Actions used:

| Action | Version | Why |
|--------|---------|-----|
| `actions/checkout` | v4 | Clone the archive repo for workflow context |
| `softprops/action-gh-release` | v1 | Create releases and upload assets in one step |
| `actions/github-script` | v7 | Issue parsing, commenting, closing |
| `actions/configure-pages` | v4 | Pages build config |
| `actions/upload-pages-artifact` | v3 | Stage `frontend/` for deploy |
| `actions/deploy-pages` | v4 | Publish the Pages artifact |

## Storage layout

```
Releases/
  index (tag)
    index.json            # master index of all archived repos
  owner__repo__YYYY-MM-DD (tag)
    owner_repo.tar.gz     # archive file
    metadata.json         # size, sha256, stars, default branch, archive date
    README.md             # extracted README
```

## Infrastructure

- **Hosting (frontend)**: GitHub Pages
- **Hosting (API)**: Cloudflare Workers
- **Compute**: GitHub Actions (`ubuntu-latest`, 2-core, 7 GB RAM)
- **CI/CD**: GitHub Actions (`pages.yml`, plus Wrangler for the Worker)
- **Monitoring**: none — `wrangler tail` for live Worker logs; Actions run logs for the archive workflow

## Development tools

- **Package manager**: npm (only used inside `worker/`)
- **Linting / formatting**: none configured — the codebase is small enough to review by hand
- **Testing**: none — primary verification is running an archive end-to-end through the workflow

## Key dependencies

| Package | Purpose |
|---------|---------|
| `wrangler` (^3.0.0) | Cloudflare Worker CLI — local dev, deploy, tail logs, secrets management |

The Worker itself has zero runtime dependencies; it only uses the Workers runtime APIs.

## Secrets

| Variable | Stored in | Description |
|----------|-----------|-------------|
| `GITHUB_TOKEN` | Cloudflare Worker secret | PAT with `repo` scope used by the Worker |
| `GITHUB_OWNER` | Cloudflare Worker secret | Owner of the archive repo |
| `GITHUB_REPO` | Cloudflare Worker secret | Name of the archive repo |

## Performance and limits

| Metric | Value |
|--------|-------|
| Frontend total payload | ~40 KB |
| Worker cold start | <5 ms |
| Archive build time | 2–10 minutes typical |
| `index.json` fetch | <100 ms (CDN-cached) |
| Worker free tier | 100K requests/day |
| Concurrent archives | Bounded by GitHub Actions concurrency (~20) |
| Archive asset size | 2 GB hard cap (GitHub Releases) |
