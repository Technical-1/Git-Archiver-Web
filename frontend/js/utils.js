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
    },

    /**
     * Simple markdown to HTML renderer
     * Supports: headers, bold, italic, links, code blocks, lists
     * @param {string} markdown
     * @returns {string}
     */
    renderMarkdown(markdown) {
        if (!markdown) return '';

        let html = this.escapeHtml(markdown);

        // Code blocks (must be before inline code)
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // Bold and italic
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Unordered lists
        html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Paragraphs (double newlines)
        html = html.replace(/\n\n/g, '</p><p>');
        html = '<p>' + html + '</p>';

        // Clean up empty paragraphs
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/<p>(<h[1-6]>)/g, '$1');
        html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<pre>)/g, '$1');
        html = html.replace(/(<\/pre>)<\/p>/g, '$1');
        html = html.replace(/<p>(<ul>)/g, '$1');
        html = html.replace(/(<\/ul>)<\/p>/g, '$1');

        return html;
    }
};

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
