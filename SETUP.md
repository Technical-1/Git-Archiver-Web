# Git-Archiver Web - Setup Guide

Complete step-by-step instructions to deploy your own Git-Archiver Web instance.

## Prerequisites

- GitHub account
- Cloudflare account (free tier)
- Node.js 18+ installed locally
- Git installed locally

## Step 1: Create GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Name: `git-archiver-web`
3. **Make it PUBLIC** (required for free GitHub Actions minutes)
4. Don't initialize with README (we'll push our code)
5. Click "Create repository"

## Step 2: Create GitHub Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click "Generate new token" → "Generate new token (classic)"
3. Name: `git-archiver-web`
4. Expiration: Choose based on your preference (or no expiration)
5. Select scopes:
   - `public_repo` (only this one needed)
6. Click "Generate token"
7. **Copy the token immediately** - you won't see it again!

## Step 3: Create Cloudflare Account

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
2. Create a free account
3. No domain needed - we'll use Workers subdomain

## Step 4: Configure the Project

### Update API Configuration

Edit `frontend/js/api.js` and update these values:

```javascript
config: {
    GITHUB_OWNER: 'YOUR_GITHUB_USERNAME',    // Change this
    GITHUB_REPO: 'git-archiver-web',
    WORKER_URL: 'https://git-archiver.YOUR_SUBDOMAIN.workers.dev',  // Update after deploying worker
    GITHUB_API: 'https://api.github.com'
}
```

### Update Footer Link

Edit `frontend/index.html` and update the GitHub link:

```html
<a href="https://github.com/YOUR_USERNAME/git-archiver-web" target="_blank">GitHub</a>
```

## Step 5: Deploy Cloudflare Worker

```bash
cd worker

# Install dependencies
npm install

# Login to Cloudflare (opens browser)
npx wrangler login

# Add secrets (paste when prompted)
npx wrangler secret put GITHUB_TOKEN
# Paste your GitHub PAT and press Enter

npx wrangler secret put GITHUB_OWNER
# Enter your GitHub username and press Enter

npx wrangler secret put GITHUB_REPO
# Enter: git-archiver-web

# Deploy the worker
npx wrangler deploy
```

After deployment, you'll see output like:
```
Published git-archiver (1.0.0)
  https://git-archiver.YOUR_SUBDOMAIN.workers.dev
```

**Copy this URL** and update `WORKER_URL` in `frontend/js/api.js`.

## Step 6: Create Initial Index

The index stores metadata about all archived repositories. Create the initial release:

**Option A: Using GitHub CLI**
```bash
# Create empty index
echo '{"last_updated":"","total_repos":0,"total_size_mb":0,"repositories":{}}' > /tmp/index.json

# Create release
gh release create index /tmp/index.json --title "Repository Index" --notes "Master index"
```

**Option B: Manual**
1. Go to your repository on GitHub
2. Click "Releases" → "Create a new release"
3. Tag: `index`
4. Title: `Repository Index`
5. Create a file named `index.json` with this content:
   ```json
   {"last_updated":"","total_repos":0,"total_size_mb":0,"repositories":{}}
   ```
6. Upload the file
7. Click "Publish release"

## Step 7: Push Code to GitHub

```bash
# Initialize git (if not already)
git init

# Add remote
git remote add origin https://github.com/YOUR_USERNAME/git-archiver-web.git

# Commit and push
git add .
git commit -m "Initial commit"
git push -u origin main
```

## Step 8: Enable GitHub Pages

1. Go to your repository on GitHub
2. Click "Settings" → "Pages"
3. Source: **GitHub Actions**
4. Save

The Pages workflow will run automatically and deploy your site.

## Step 9: Create Archive-Request Label

1. Go to your repository → "Issues" → "Labels"
2. Click "New label"
3. Name: `archive-request`
4. Color: Choose any (e.g., `#0366d6`)
5. Description: `Automated archive requests`
6. Click "Create label"

## Step 10: Test Your Deployment

1. Visit your site: `https://YOUR_USERNAME.github.io/git-archiver-web`
2. Enter a repository URL (e.g., `https://github.com/sindresorhus/awesome`)
3. Click "Archive"
4. Check the "Issues" tab on GitHub - a new issue should appear
5. Wait for the GitHub Action to complete (~2-5 minutes)
6. The archive should appear in "Releases"

## Troubleshooting

### Worker returns 500 error
- Check that secrets are set: `npx wrangler secret list`
- View logs: `npx wrangler tail`

### Archive workflow fails
- Check Actions tab for error logs
- Ensure the `archive-request` label exists
- Verify GITHUB_TOKEN has correct permissions

### Index not loading
- Ensure the `index` release exists
- Check browser console for CORS errors
- Verify `GITHUB_OWNER` and `GITHUB_REPO` are correct in api.js

### Pages not deploying
- Check that Pages source is set to "GitHub Actions"
- Verify the workflow runs on push to main
- Check Actions tab for deployment errors

## Customization

### Change Rate Limits

Edit `worker/src/index.js`:
```javascript
const RATE_LIMITS = {
    requests_per_hour: 10,    // Increase/decrease as needed
    requests_per_day: 50
};
```

### Add Custom Domain

1. In Cloudflare dashboard, add your domain
2. Update DNS to point to GitHub Pages
3. In repository Settings → Pages, add custom domain
4. Update `WORKER_URL` if using custom domain for worker

### Change Archive Schedule

Edit `.github/workflows/update-archives.yml`:
```yaml
schedule:
  - cron: '0 3 * * *'  # Change this cron expression
```

## Costs

Everything runs on free tiers:
- **GitHub Pages**: Free for public repos
- **GitHub Actions**: Unlimited minutes for public repos
- **GitHub Releases**: Unlimited storage (within reason)
- **Cloudflare Workers**: 100,000 requests/day free

## Security Notes

1. **Never commit your GitHub token** - always use secrets
2. **Keep repository public** for free Actions minutes
3. **Rotate your PAT periodically** for security
4. **Monitor usage** via Cloudflare and GitHub dashboards
