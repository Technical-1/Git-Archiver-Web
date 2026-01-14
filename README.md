# Git-Archiver Web

A free, serverless GitHub repository archiving service. Submit any public GitHub repo URL and it gets cloned, compressed, and stored forever - available for anyone to download.

**No sign-up required. No backend costs. Completely free.**

## How It Works

```
You submit URL  →  Cloudflare Worker  →  GitHub Actions  →  Stored in Releases
                   (creates issue)       (clones + zips)    (free hosting)
```

1. **Submit**: Paste a GitHub URL on the website
2. **Queue**: Your request is added to the processing queue
3. **Archive**: GitHub Actions clones the repo and creates a .tar.gz
4. **Store**: Archive is uploaded to GitHub Releases (free, unlimited)
5. **Share**: Anyone can download the archive anytime

## Why?

- **Preserve** repositories before they get deleted
- **Cache** popular repos for faster access
- **Backup** important projects you depend on
- **Share** archived repos with others instantly

## Architecture

| Component | Service | Cost |
|-----------|---------|------|
| Frontend | GitHub Pages | Free |
| Submission API | Cloudflare Workers | Free |
| Processing | GitHub Actions | Free |
| Storage | GitHub Releases | Free |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full technical details.

## Project Structure

```
git-archiver-web/
├── frontend/           # Static website (GitHub Pages)
│   ├── index.html
│   ├── css/
│   └── js/
├── worker/             # Cloudflare Worker (submission proxy)
│   └── src/index.js
├── .github/workflows/  # GitHub Actions (archive engine)
│   └── archive.yml
└── scripts/            # Setup and maintenance scripts
```

## Development

### Prerequisites

- Node.js 18+
- Cloudflare account (free)
- GitHub account with PAT

### Local Development

```bash
# Frontend (any static server)
cd frontend
npx serve .

# Worker (Cloudflare Wrangler)
cd worker
npm install
npx wrangler dev
```

### Deployment

```bash
# Deploy worker
cd worker
npx wrangler deploy

# Frontend deploys automatically via GitHub Pages
```

## Limits

| Limit | Value |
|-------|-------|
| Max repo size | 2 GB |
| Submissions per IP/hour | 10 |
| Archive retention | Forever* |

*GitHub may contact us if storage becomes excessive

## Contributing

Contributions welcome! Please read [ARCHITECTURE.md](./ARCHITECTURE.md) first to understand the system design.

## License

MIT

## Related

- [Git-Archiver (Desktop)](../README.md) - Local PyQt5 version with full features
