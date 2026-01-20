# Project Q&A

## Project Overview

Git-Archiver Web is a free, serverless GitHub repository archiving service that I built to solve a common problem: preserving public repositories before they disappear. Users can submit any public GitHub repository URL, and the system automatically clones it, compresses it into a tar.gz archive, and stores it permanently in GitHub Releases - all at zero cost.

**Problem Solved**: GitHub repositories get deleted, go private, or become unavailable due to DMCA takedowns. Once a repository disappears, its code is often lost forever. Git-Archiver Web provides a permanent backup service that anyone can use without signing up or paying.

**Target Users**: Developers who want to preserve important open-source projects, researchers archiving codebases for study, organizations backing up dependencies, and anyone who wants to ensure a repository remains accessible.

## Key Features

### 1. One-Click Archiving
Users paste a GitHub URL and click "Archive" - no account needed. The system validates the repository, queues it for processing, and provides real-time status updates.

### 2. Bulk Upload
Submit up to 20 repositories at once through the bulk upload modal. I implemented this after realizing users often want to archive multiple related projects simultaneously.

### 3. Archive Versioning
Each repository can have multiple archive versions. When a repo is re-archived, the system calculates a SHA256 hash and only creates a new release if content has changed.

### 4. Live Status Indicators
Repository cards show whether the original source is still online. A green dot means the repo exists; red means it's been deleted - exactly when you need the archive most.

### 5. README Preview
Users can view the archived README directly in the modal without downloading the full archive. I proxy this through the worker to avoid CORS issues.

### 6. Processing Queue
A live queue shows pending archive requests with auto-refresh every 30 seconds. Users can see their position and estimated wait time.

### 7. Search and Browse
Search across all archived repositories by name, owner, or description. Results update as you type with debounced API calls.

## Technical Highlights

### Challenge: Zero-Cost Architecture
**Solution**: I designed the entire system to run within free tiers. GitHub Pages hosts the frontend, Cloudflare Workers handle the API (100K requests/day free), GitHub Actions process archives (unlimited for public repos), and GitHub Releases store everything. Total monthly cost: $0.

### Challenge: CORS and Token Security
**Solution**: The Cloudflare Worker acts as a proxy, keeping the GitHub PAT secure while handling CORS. The frontend never sees the token, and all authenticated requests go through the worker.

### Challenge: Preventing Duplicate Archives
**Solution**: I implemented content-based deduplication using SHA256 hashes. Before creating a release, the workflow downloads the previous metadata and compares hashes. If unchanged, no new release is created - saving storage and API calls.

### Challenge: Using GitHub Issues as a Queue
**Solution**: This was an unconventional choice that worked surprisingly well. Issues provide visibility (users can track their request), auditability (complete history), and native GitHub Actions triggers. No external queue service needed.

### Challenge: Rate Limiting Without a Database
**Solution**: I prepared the worker for KV-based rate limiting but ship with a permissive default. The architecture supports IP-based throttling via Cloudflare KV when needed.

### Challenge: Handling Large Repositories
**Solution**: I set a 2GB limit (GitHub Releases maximum) and validate size before cloning. The workflow uses shallow clones (depth 100) to balance speed with history preservation.

## Frequently Asked Questions

### Q: Why would I use this instead of just forking the repository?
**A**: Forking keeps a live link to the original - if the original is deleted due to DMCA or owner action, your fork may also be affected. Git-Archiver creates an independent, downloadable archive that persists regardless of what happens to the original repository.

### Q: How long are archives stored?
**A**: Archives are stored in GitHub Releases indefinitely. GitHub has no stated limits on release storage for public repositories. However, if storage becomes excessive, GitHub may contact us about the account.

### Q: Can I archive private repositories?
**A**: No, only public repositories can be archived. I made this a deliberate design decision to respect repository owners' privacy choices. The worker validates this before creating archive requests.

### Q: What's the maximum repository size I can archive?
**A**: 2GB, which is GitHub's limit for individual release assets. Repositories larger than this are rejected at submission time with a clear error message explaining the limit.

### Q: How do I download an archive?
**A**: Click any repository card to open the detail modal, then click "Download" next to the version you want. Archives are standard tar.gz files that can be extracted with any archive tool.

### Q: Why does my archive request say "no changes"?
**A**: I implemented smart deduplication. If a repository hasn't changed since the last archive (same SHA256 hash), no new release is created. This saves storage and prevents cluttering the releases page with identical archives.

### Q: How often are repositories re-archived?
**A**: The daily update job checks the oldest archives and re-archives them if content has changed. You can also manually request a re-archive of any repository at any time.

### Q: Is there an API I can use programmatically?
**A**: Yes! The Cloudflare Worker exposes several endpoints:
- `POST /submit` - Submit a single URL
- `POST /bulk-submit` - Submit up to 20 URLs
- `GET /index` - Fetch the master index
- `GET /status?owner=X&repo=Y` - Check if original repo exists

### Q: What happens if GitHub changes their API or policies?
**A**: This is a real risk. The architecture depends heavily on GitHub's free services. If they change policies, I'd need to migrate to alternatives (GitLab, self-hosted Gitea, S3 for storage). The modular design makes this possible but would require significant work.

### Q: Can I run my own instance?
**A**: Absolutely! The entire codebase is open source. See SETUP.md for step-by-step deployment instructions. You'll need a GitHub account, Cloudflare account (free), and about 30 minutes for initial setup.
