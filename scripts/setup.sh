#!/bin/bash
#
# Git-Archiver Web - Setup Script
#
# This script helps you set up the Git-Archiver Web service.
# Run it after creating your GitHub repository.
#

set -e

echo "========================================"
echo "Git-Archiver Web - Setup"
echo "========================================"
echo ""

# Check for required tools
command -v git >/dev/null 2>&1 || { echo "Error: git is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required"; exit 1; }

# Get configuration
read -p "GitHub username: " GITHUB_USERNAME
read -p "Repository name [git-archiver-web]: " REPO_NAME
REPO_NAME=${REPO_NAME:-git-archiver-web}

echo ""
echo "Configuration:"
echo "  Username: $GITHUB_USERNAME"
echo "  Repository: $REPO_NAME"
echo ""

# Update frontend API configuration
echo "Updating frontend configuration..."
sed -i.bak "s/YOUR_GITHUB_USERNAME/$GITHUB_USERNAME/g" frontend/js/api.js
rm -f frontend/js/api.js.bak

# Update README
sed -i.bak "s/YOUR_USERNAME/$GITHUB_USERNAME/g" frontend/index.html
rm -f frontend/index.html.bak

echo ""
echo "========================================"
echo "Next Steps:"
echo "========================================"
echo ""
echo "1. Create a GitHub Personal Access Token:"
echo "   - Go to: https://github.com/settings/tokens"
echo "   - Click 'Generate new token (classic)'"
echo "   - Select scope: 'public_repo'"
echo "   - Copy the token"
echo ""
echo "2. Create a Cloudflare account (free):"
echo "   - Go to: https://dash.cloudflare.com/sign-up"
echo ""
echo "3. Deploy the Worker:"
echo "   cd worker"
echo "   npm install"
echo "   npx wrangler login"
echo "   npx wrangler secret put GITHUB_TOKEN"
echo "   npx wrangler secret put GITHUB_OWNER  # Enter: $GITHUB_USERNAME"
echo "   npx wrangler secret put GITHUB_REPO   # Enter: $REPO_NAME"
echo "   npx wrangler deploy"
echo ""
echo "4. Update the Worker URL in frontend/js/api.js"
echo "   Replace YOUR_SUBDOMAIN with your Cloudflare subdomain"
echo ""
echo "5. Create the initial index release:"
echo "   ./scripts/create-index.sh"
echo ""
echo "6. Push to GitHub to deploy:"
echo "   git add ."
echo "   git commit -m 'Initial setup'"
echo "   git push origin main"
echo ""
echo "7. Enable GitHub Pages:"
echo "   - Go to repository Settings > Pages"
echo "   - Source: GitHub Actions"
echo ""
echo "Done! Your site will be live at:"
echo "https://$GITHUB_USERNAME.github.io/$REPO_NAME"
echo ""
