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
        // M3: Check URL length before regex to prevent ReDoS
        const trimmedUrl = url.trim();
        if (trimmedUrl.length > 200) return false;
        // M3: Use length-limited character classes for better performance
        const pattern = /^https?:\/\/github\.com\/[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}\/?$/;
        return pattern.test(trimmedUrl);
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
            // M10: Preserve 'this' context
            const context = this;
            const later = () => {
                clearTimeout(timeout);
                func.apply(context, args);
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
     * Secure markdown to HTML renderer using marked.js and DOMPurify
     * @param {string} markdown
     * @returns {string}
     */
    renderMarkdown(markdown) {
        if (!markdown) return '';

        try {
            // Check if marked and DOMPurify are available
            if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
                console.warn('marked.js or DOMPurify not loaded, falling back to escaped text');
                return '<pre>' + this.escapeHtml(markdown) + '</pre>';
            }

            // Allowed URL protocols
            const allowedProtocols = ['http:', 'https:', 'mailto:'];

            // Custom renderer for secure link handling
            const renderer = new marked.Renderer();

            // Override link rendering to add security attributes and validate URLs
            renderer.link = function(href, title, text) {
                // Handle marked.js v12+ object-based parameters
                if (typeof href === 'object' && href !== null) {
                    const token = href;
                    href = token.href;
                    title = token.title;
                    text = token.text;
                }

                // M8: Check for dangerous protocols in lowercase before URL parsing
                const lowerHref = String(href).toLowerCase();
                if (lowerHref.startsWith('javascript:') || lowerHref.startsWith('data:')) {
                    return Utils.escapeHtml(text);
                }

                // Validate URL protocol
                try {
                    const url = new URL(href, window.location.origin);
                    if (!allowedProtocols.includes(url.protocol)) {
                        // Strip dangerous protocols (javascript:, data:, etc.)
                        return Utils.escapeHtml(text);
                    }
                } catch (e) {
                    // If URL parsing fails, strip the link
                    return Utils.escapeHtml(text);
                }

                const titleAttr = title ? ` title="${Utils.escapeHtml(title)}"` : '';
                return `<a href="${Utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
            };

            // Override image rendering to validate src URLs
            renderer.image = function(href, title, text) {
                // Handle marked.js v12+ object-based parameters
                if (typeof href === 'object' && href !== null) {
                    const token = href;
                    href = token.href;
                    title = token.title;
                    text = token.text;
                }

                // Validate URL protocol
                try {
                    const url = new URL(href, window.location.origin);
                    if (!allowedProtocols.includes(url.protocol)) {
                        // Strip dangerous protocols
                        return Utils.escapeHtml(text || '');
                    }
                } catch (e) {
                    return Utils.escapeHtml(text || '');
                }

                const titleAttr = title ? ` title="${Utils.escapeHtml(title)}"` : '';
                const altAttr = text ? Utils.escapeHtml(text) : '';
                return `<img src="${Utils.escapeHtml(href)}" alt="${altAttr}"${titleAttr} loading="lazy">`;
            };

            // Configure marked options
            marked.setOptions({
                gfm: true,
                breaks: true,
                headerIds: false,
                mangle: false,
                renderer: renderer
            });

            // Parse markdown to HTML
            const rawHtml = marked.parse(markdown);

            // Sanitize with DOMPurify using strict whitelist
            const cleanHtml = DOMPurify.sanitize(rawHtml, {
                ALLOWED_TAGS: [
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'p', 'br', 'hr',
                    'ul', 'ol', 'li',
                    'a', 'img',
                    'code', 'pre',
                    'blockquote',
                    'strong', 'em', 'del',
                    'table', 'thead', 'tbody', 'tr', 'th', 'td'
                ],
                ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel', 'loading'],
                ALLOW_DATA_ATTR: false,
                ADD_ATTR: ['target', 'rel'],
                FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'object', 'embed'],
                FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
            });

            return cleanHtml;
        } catch (error) {
            console.error('Error rendering markdown:', error);
            return '<pre>' + this.escapeHtml(markdown) + '</pre>';
        }
    }
};

/**
 * Toast notification system
 */
const Toast = {
    container: null,

    init() {
        if (this.container) return;
        this.container = document.createElement('div');
        this.container.id = 'toast-container';
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    },

    show(message, type = 'info', duration = 5000) {
        this.init();

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icon = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' }[type] || 'ℹ';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon';
        iconSpan.textContent = icon;

        const msgSpan = document.createElement('span');
        msgSpan.className = 'toast-message';
        // L1: Use String() to ensure message is always a string with fallback
        msgSpan.textContent = String(message || 'An error occurred');

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        closeBtn.onclick = () => this.remove(toast);

        toast.appendChild(iconSpan);
        toast.appendChild(msgSpan);
        toast.appendChild(closeBtn);

        this.container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => toast.classList.add('toast-visible'));

        // Auto-remove (0 = persist)
        if (duration > 0) {
            setTimeout(() => this.remove(toast), duration);
        }

        return toast;
    },

    remove(toast) {
        if (!toast || !toast.parentNode) return;
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 300);
    },

    success(message, duration = 5000) { return this.show(message, 'success', duration); },
    error(message, duration = 0) { return this.show(message, 'error', duration); },
    warning(message, duration = 5000) { return this.show(message, 'warning', duration); },
    info(message, duration = 5000) { return this.show(message, 'info', duration); }
};

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
