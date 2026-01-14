/**
 * Utility functions for Git-Archiver Web
 */

const Utils = {
    /**
     * Validate a GitHub repository URL
     * @param {string} url - URL to validate
     * @returns {boolean}
     */
    isValidGitHubUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const pattern = /^https?:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/;
        return pattern.test(url.trim());
    },

    /**
     * Extract owner and repo from GitHub URL
     * @param {string} url - GitHub URL
     * @returns {{owner: string, repo: string} | null}
     */
    parseGitHubUrl(url) {
        if (!url) return null;
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) return null;
        return {
            owner: match[1],
            repo: match[2].replace(/\.git$/, '').replace(/\/$/, '')
        };
    },

    /**
     * Format bytes to human readable string
     * @param {number} bytes
     * @returns {string}
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    },

    /**
     * Format date to readable string
     * @param {string} dateStr - ISO date string
     * @returns {string}
     */
    formatDate(dateStr) {
        if (!dateStr) return 'Unknown';
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    },

    /**
     * Format relative time (e.g., "2 hours ago")
     * @param {string} dateStr - ISO date string
     * @returns {string}
     */
    formatRelativeTime(dateStr) {
        if (!dateStr) return 'Unknown';
        const date = new Date(dateStr);
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);

        const intervals = [
            { label: 'year', seconds: 31536000 },
            { label: 'month', seconds: 2592000 },
            { label: 'day', seconds: 86400 },
            { label: 'hour', seconds: 3600 },
            { label: 'minute', seconds: 60 }
        ];

        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
            }
        }
        return 'Just now';
    },

    /**
     * Debounce function calls
     * @param {Function} func
     * @param {number} wait
     * @returns {Function}
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    /**
     * Truncate string with ellipsis
     * @param {string} str
     * @param {number} maxLength
     * @returns {string}
     */
    truncate(str, maxLength) {
        if (!str || str.length <= maxLength) return str;
        return str.slice(0, maxLength - 3) + '...';
    },

    /**
     * Show element
     * @param {HTMLElement} el
     */
    show(el) {
        if (el) el.hidden = false;
    },

    /**
     * Hide element
     * @param {HTMLElement} el
     */
    hide(el) {
        if (el) el.hidden = true;
    },

    /**
     * Generate a tag-safe name from owner/repo
     * @param {string} owner
     * @param {string} repo
     * @param {string} date - YYYY-MM-DD format
     * @returns {string}
     */
    generateReleaseTag(owner, repo, date) {
        return `${owner}__${repo}__${date}`;
    },

    /**
     * Parse release tag back to components
     * @param {string} tag
     * @returns {{owner: string, repo: string, date: string} | null}
     */
    parseReleaseTag(tag) {
        const parts = tag.split('__');
        if (parts.length !== 3) return null;
        return {
            owner: parts[0],
            repo: parts[1],
            date: parts[2]
        };
    }
};

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
