# Project Q&A

## Overview

Git-Archiver Web is a free, serverless service for taking permanent snapshots of public GitHub repositories. A visitor pastes a repo URL, a Cloudflare Worker validates it and opens a labelled issue on the archive repo, and a GitHub Actions workflow clones the repo, compresses it to `.tar.gz`, and publishes it as a GitHub Release. The interesting bit is that the entire stack — frontend, API, compute, and storage — runs inside GitHub and Cloudflare free tiers.

## Problem Solved

GitHub repos disappear: owners delete accounts, projects go private, DMCA notices remove code, and forks vanish along with their upstream. Once a repo is gone, downstream users have no clean way to recover it. Git-Archiver Web gives anyone a one-click way to mint a permanent, downloadable snapshot before that happens — and to share that snapshot with others without setting up infrastructure of their own.

## Target Users

- **Open-source maintainers** preserving deprecated or pre-acquisition versions of a project
- **Researchers and educators** archiving codebases referenced in papers or course material
- **Developers depending on small libraries** who want a fallback if the upstream disappears
- **Anyone curious** who wants a downloadable `.tar.gz` of a public repo without cloning locally

## Key Features

### One-click archiving
Paste a `github.com/owner/repo` URL and the worker handles validation, size-checking, and queueing. No login, no API key.

### Bulk submit
The bulk modal accepts up to 20 URLs at once — useful for archiving a whole org or a list of dependencies in a single sitting.

### Content-addressed deduplication
Every archive's `.tar.gz` is hashed with SHA-256, and the hash is written into a sibling `metadata.json`. Before publishing a new release the workflow downloads the previous metadata and compares hashes; matching hashes mean no new release is created. This keeps the releases list clean even when re-archiving an unchanged repo.

### Live source-status indicator
Each card shows whether the original repo is still public, has been made private, or has been deleted — which is exactly the information a user needs when deciding whether to download the archive now.

### README preview
Archived READMEs are uploaded as a separate release asset and served back through the worker, so the detail modal can render the README without hitting CORS issues from GitHub's redirected asset URLs.

### Daily refresh job
`update-archives.yml` runs on a cron, picks the oldest archives, and dispatches the archive workflow against them. Combined with the SHA-256 dedupe, this means only repos that actually changed produce new releases.

## Technical Highlights

### GitHub Issues as a job queue
Submissions don't go through Redis, SQS, or a hosted queue — the worker creates a GitHub issue with an `archive-request` label, and `archive.yml` is triggered on `issues.opened` filtered to that label. The issue body carries the request payload, the issue thread becomes the user-visible status log (the workflow comments back), and closing the issue marks the job done. The whole queue is free, durable, and auditable by anyone with the repo URL.

### Token-isolating proxy
The frontend never sees the GitHub PAT. The Cloudflare Worker holds the token in its secrets store, validates incoming submissions against GitHub's API (repo exists, size under 2 GB, not a duplicate of today's archive), and only then opens the issue. This means the frontend can stay as static HTML on GitHub Pages — no auth, no session, no leaked tokens in browser DevTools.

### Index as a release asset
There is no database. The master list of archived repos lives in a single `index.json` published as an asset on a release tagged `index`. The worker proxies fetches of this file so the frontend can grab it with a normal CORS-safe request. Updates happen as part of the archive workflow: download the current index, append/update the entry, upload the new asset. It's a homegrown read-mostly key-value store backed by GitHub's CDN.

### Per-archive metadata triplet
Each archived release contains three assets: the `.tar.gz` itself, a `metadata.json` (size, hash, star count, default branch, archive date), and the extracted `README.md`. Splitting these out lets the frontend show rich repo cards and previews without ever downloading the full archive.

## Engineering Decisions

### Static frontend with no framework
- **Constraint**: Needed zero hosting cost and zero build complexity.
- **Options**: React/Vite, SvelteKit, Astro, or plain HTML+JS.
- **Choice**: Plain HTML, CSS, and a few vanilla-JS modules (`app.js`, `api.js`, `utils.js`).
- **Why**: The UI is a list view, a detail modal, and a submission form — nothing that warrants a framework. Skipping the build step means GitHub Pages serves the source files directly, edits go live with a push, and total payload stays around 40 KB.

### GitHub Issues over a real queue
- **Constraint**: Needed a durable, observable, free job queue.
- **Options**: Redis on a hobby VM, AWS SQS, Cloudflare Queues, or a homegrown queue.
- **Choice**: GitHub Issues filtered by label, triggering `archive.yml` on `issues.opened`.
- **Why**: Issues are already a queue with comments, labels, assignees, and a UI. They're free for public repos, integrate natively with Actions, and give users a public URL where they can see their request's status. The cost is being coupled to GitHub's webhook latency, which is acceptable for a job that takes minutes anyway.

### Cloudflare Workers in front of GitHub
- **Constraint**: Token had to stay off the client, and the frontend needed CORS-friendly endpoints.
- **Options**: A hosted backend (Fly, Render), AWS Lambda + API Gateway, or Cloudflare Workers.
- **Choice**: Cloudflare Workers, deployed with Wrangler.
- **Why**: Free tier covers 100K requests/day, cold starts are sub-5ms, and secrets management is built in. No container to maintain and no separate API-gateway config to keep in sync.

### SHA-256 dedupe instead of "always create a release"
- **Constraint**: Re-archiving an unchanged repo shouldn't pile up identical releases.
- **Options**: Skip re-archiving entirely, compare git SHAs, or hash the tarball contents.
- **Choice**: Hash the produced `.tar.gz` and compare against the previous archive's metadata.
- **Why**: Comparing git SHAs misses changes from clone-time variability (timestamps, line endings); comparing tarball hashes is exact. Skipping re-archives entirely would mean stale data for active repos. Hashing the output gives the right behavior: new release if and only if the content actually differs.

## Frequently Asked Questions

### Why use this instead of just forking the repo?
A fork is a live reference to the upstream. If the upstream is taken down for DMCA reasons, your fork can be taken down too. A Git-Archiver release is an independent `.tar.gz` file on a different repo's releases page — it persists regardless of what happens to the source.

### How long do archives stick around?
Indefinitely, in principle. GitHub doesn't publish a hard cap on release-asset storage for public repos. If the archive repo ever gets contacted about excessive storage, the answer would be to shard across multiple repos.

### Can I archive a private repo?
No — public only. The worker checks `private: false` on the repo metadata before queueing. This is a deliberate decision: archiving private repos without the owner's consent isn't something this service is willing to do.

### What's the maximum repo size?
2 GB, which is GitHub's per-asset limit for releases. The worker checks the repo's size via the API before queueing and rejects oversized submissions up front with a clear error.

### Why does my submission say "no changes"?
Because the SHA-256 of the newly built `.tar.gz` matches the previous archive's hash exactly — meaning nothing about the cloned contents has changed since last time. Rather than create a duplicate release, the workflow comments on the issue and closes it.

### Can I trigger a re-archive of a repo someone else already archived?
Yes — submitting the same URL again is fine. The workflow will run, hash the output, and either publish a new release (if content changed) or comment "no changes" (if it didn't).

### Is there an API I can call directly?
Yes. The Cloudflare Worker exposes:
- `POST /submit` — submit a single URL
- `POST /bulk-submit` — submit up to 20 URLs
- `GET /index` — fetch the full index of archived repos
- `GET /readme?owner=…&repo=…` — fetch an archived README
- `GET /status?owner=…&repo=…` — check whether the original is still public

### Can I run my own instance?
Yes, the whole stack is open source. You'll need a GitHub account, a Cloudflare account, and a PAT with `repo` scope. The `scripts/setup.sh` helper walks through the secrets and the initial `index` release.
