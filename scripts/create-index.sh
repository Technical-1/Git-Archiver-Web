#!/bin/bash
#
# Create initial index release
#
# Run this script after setting up the repository to create
# the initial empty index.
#

set -e

echo "Creating initial index..."

# Create empty index
cat > /tmp/index.json << 'EOF'
{
  "last_updated": "",
  "total_repos": 0,
  "total_size_mb": 0,
  "repositories": {}
}
EOF

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg now "$NOW" '.last_updated = $now' /tmp/index.json > /tmp/index_updated.json
mv /tmp/index_updated.json /tmp/index.json

echo "Index created:"
cat /tmp/index.json

echo ""
echo "To upload this index, create a release manually:"
echo "1. Go to your repository on GitHub"
echo "2. Click 'Releases' > 'Create a new release'"
echo "3. Tag: 'index'"
echo "4. Title: 'Repository Index'"
echo "5. Upload: /tmp/index.json"
echo "6. Click 'Publish release'"
echo ""
echo "Or use GitHub CLI:"
echo "  gh release create index /tmp/index.json --title 'Repository Index' --notes 'Master index of all archived repositories'"
