#!/bin/bash
#
# restore-index.sh - Restore index.json from a backup release
#
# Usage:
#   ./scripts/restore-index.sh                    # List available backups
#   ./scripts/restore-index.sh <backup-tag>       # Restore specific backup
#
# Examples:
#   ./scripts/restore-index.sh
#   ./scripts/restore-index.sh index-backup-20240115-143022
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check GitHub CLI authentication
if ! gh auth status >/dev/null 2>&1; then
    echo -e "${RED}Error: Not authenticated with GitHub CLI.${NC}"
    echo "Please run 'gh auth login' first."
    exit 1
fi

# Get repository info
REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null)
if [ -z "$REPO" ]; then
    echo -e "${RED}Error: Could not determine repository. Make sure you're in a git repository with GitHub remote.${NC}"
    exit 1
fi

echo -e "${BLUE}Repository: ${REPO}${NC}"
echo ""

# Function to list available backups
list_backups() {
    echo -e "${YELLOW}Available index backups:${NC}"
    echo ""

    BACKUPS=$(gh release list --limit 50 --json tagName,createdAt,name \
        --jq '.[] | select(.tagName | startswith("index-backup-")) | "\(.tagName)\t\(.createdAt)\t\(.name)"' 2>/dev/null | sort -r)

    if [ -z "$BACKUPS" ]; then
        echo -e "${YELLOW}No backup releases found.${NC}"
        echo ""
        echo "Backups are created automatically when the index is updated."
        return 1
    fi

    echo -e "TAG\t\t\t\t\tCREATED\t\t\t\tNAME"
    echo "--------------------------------------------------------------------------------"
    echo "$BACKUPS" | while IFS=$'\t' read -r tag created name; do
        # Format the date for display
        formatted_date=$(echo "$created" | cut -c1-19 | tr 'T' ' ')
        echo -e "${GREEN}${tag}${NC}\t${formatted_date}\t${name}"
    done
    echo ""
    echo "To restore a backup, run:"
    echo -e "  ${BLUE}./scripts/restore-index.sh <backup-tag>${NC}"
    return 0
}

# Function to download and validate backup
download_backup() {
    local backup_tag="$1"
    local output_file="$2"

    echo -e "${BLUE}Downloading backup: ${backup_tag}${NC}"

    # Try to download index_backup.json from the backup release
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${backup_tag}/index_backup.json"

    if ! curl -sL -f -o "$output_file" "$DOWNLOAD_URL" 2>/dev/null; then
        echo -e "${RED}Error: Failed to download backup from ${backup_tag}${NC}"
        echo "The backup release may not exist or may not contain index_backup.json"
        return 1
    fi

    # Validate JSON
    if ! jq -e '.' "$output_file" >/dev/null 2>&1; then
        echo -e "${RED}Error: Downloaded file is not valid JSON${NC}"
        rm -f "$output_file"
        return 1
    fi

    echo -e "${GREEN}Backup downloaded and validated successfully${NC}"
    return 0
}

# Function to show backup details
show_backup_details() {
    local backup_file="$1"

    echo ""
    echo -e "${YELLOW}Backup Details:${NC}"
    echo "--------------------------------------------------------------------------------"

    # Show backup metadata if present
    if jq -e '.backup_metadata' "$backup_file" >/dev/null 2>&1; then
        BACKUP_TAG=$(jq -r '.backup_metadata.backup_tag // "N/A"' "$backup_file")
        BACKUP_TIME=$(jq -r '.backup_metadata.backup_time // "N/A"' "$backup_file")
        ORIGINAL_UPDATED=$(jq -r '.backup_metadata.original_last_updated // "N/A"' "$backup_file")

        echo -e "  Backup Tag:           ${BACKUP_TAG}"
        echo -e "  Backup Time:          ${BACKUP_TIME}"
        echo -e "  Original Last Updated: ${ORIGINAL_UPDATED}"
    fi

    # Show index stats
    TOTAL_REPOS=$(jq -r '.total_repos // 0' "$backup_file")
    TOTAL_SIZE=$(jq -r '.total_size_mb // 0' "$backup_file")
    LAST_UPDATED=$(jq -r '.last_updated // "N/A"' "$backup_file")

    echo -e "  Total Repositories:   ${TOTAL_REPOS}"
    echo -e "  Total Size (MB):      ${TOTAL_SIZE}"
    echo -e "  Index Last Updated:   ${LAST_UPDATED}"
    echo "--------------------------------------------------------------------------------"
    echo ""
}

# Function to restore the backup
restore_backup() {
    local backup_file="$1"

    echo -e "${BLUE}Preparing to restore index...${NC}"

    # Remove backup metadata before restoring
    jq 'del(.backup_metadata)' "$backup_file" > restored_index.json

    # Upload to index release
    echo -e "${BLUE}Uploading restored index to 'index' release...${NC}"

    # Check if index release exists
    if gh release view index >/dev/null 2>&1; then
        # Update existing release
        gh release upload index restored_index.json --clobber
        echo -e "${GREEN}Index restored successfully!${NC}"
    else
        # Create new index release
        gh release create index restored_index.json \
            --title "Repository Index" \
            --notes "Master index of all archived repositories. Restored from backup."
        echo -e "${GREEN}Index release created and restored successfully!${NC}"
    fi

    # Cleanup
    rm -f restored_index.json

    return 0
}

# Main logic
BACKUP_TAG="${1:-}"

if [ -z "$BACKUP_TAG" ]; then
    # No argument - list available backups
    list_backups
    exit 0
fi

# Validate backup tag format
if [[ ! "$BACKUP_TAG" =~ ^index-backup-[0-9]{8}-[0-9]{6}$ ]]; then
    echo -e "${RED}Error: Invalid backup tag format${NC}"
    echo "Expected format: index-backup-YYYYMMDD-HHMMSS"
    echo "Example: index-backup-20240115-143022"
    exit 1
fi

# Check if the backup release exists
if ! gh release view "$BACKUP_TAG" >/dev/null 2>&1; then
    echo -e "${RED}Error: Backup release '${BACKUP_TAG}' not found${NC}"
    echo ""
    echo "Available backups:"
    list_backups
    exit 1
fi

# Create temp file for backup
TEMP_BACKUP=$(mktemp)
trap "rm -f $TEMP_BACKUP" EXIT

# Download and validate the backup
if ! download_backup "$BACKUP_TAG" "$TEMP_BACKUP"; then
    exit 1
fi

# Show backup details
show_backup_details "$TEMP_BACKUP"

# Ask for confirmation
echo -e "${YELLOW}WARNING: This will overwrite the current index.json with the backup.${NC}"
echo ""
read -p "Are you sure you want to restore this backup? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo -e "${YELLOW}Restore cancelled.${NC}"
    exit 0
fi

echo ""

# Restore the backup
if restore_backup "$TEMP_BACKUP"; then
    echo ""
    echo -e "${GREEN}Restore complete!${NC}"
    echo ""
    echo "The index has been restored from backup: ${BACKUP_TAG}"
    echo "You can verify by visiting:"
    echo "  https://github.com/${REPO}/releases/tag/index"
else
    echo -e "${RED}Restore failed!${NC}"
    exit 1
fi
