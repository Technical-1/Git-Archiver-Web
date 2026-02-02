/**
 * Main application logic for Git-Archiver Web
 */

const App = {
    // Application state
    state: {
        index: null,
        pendingRequests: [],
        filteredRepos: [],
        isLoading: true,
        searchQuery: '',
        currentPage: 1,
        pageSize: 50,
        hasMore: true
    },

    // Infinite scroll observer
    scrollObserver: null,

    // M6: Track pending status check requests to prevent race conditions
    pendingStatusChecks: new Map(),

    // DOM elements cache
    elements: {},

    // Auto-refresh interval (30 seconds)
    QUEUE_REFRESH_INTERVAL: 30000,
    refreshTimer: null,

    /**
     * Initialize the application
     */
    async init() {
        this.cacheElements();
        this.bindEvents();
        await this.loadData();
        this.startAutoRefresh();
    },

    /**
     * Start auto-refresh timer for queue
     */
    startAutoRefresh() {
        this.refreshTimer = setInterval(() => this.refreshQueue(), this.QUEUE_REFRESH_INTERVAL);

        // M4 & M6: Clean up timer and pending status checks on page unload to prevent memory leaks
        window.addEventListener('beforeunload', () => {
            if (this.refreshTimer) {
                clearInterval(this.refreshTimer);
                this.refreshTimer = null;
            }
            // M6: Also abort and clear pending status checks
            if (this.pendingStatusChecks) {
                this.pendingStatusChecks.forEach(controller => controller.abort());
                this.pendingStatusChecks.clear();
            }
        });
    },

    /**
     * Refresh queue data
     */
    async refreshQueue() {
        try {
            const btn = this.elements.queueRefreshBtn;
            if (btn) btn.classList.add('spinning');

            this.state.pendingRequests = await API.fetchPendingRequests();
            this.renderQueue();
            this.updateStats();
        } catch (error) {
            console.error('Failed to refresh queue:', error);
        } finally {
            const btn = this.elements.queueRefreshBtn;
            if (btn) btn.classList.remove('spinning');
        }
    },

    /**
     * Cache DOM element references
     */
    cacheElements() {
        this.elements = {
            // Form
            submitForm: document.getElementById('submit-form'),
            repoUrlInput: document.getElementById('repo-url'),
            submitBtn: document.getElementById('submit-btn'),
            formMessage: document.getElementById('form-message'),

            // Stats
            statRepos: document.getElementById('stat-repos'),
            statSize: document.getElementById('stat-size'),
            statPending: document.getElementById('stat-pending'),

            // Search
            searchInput: document.getElementById('search-input'),

            // Repos list
            reposLoading: document.getElementById('repos-loading'),
            reposEmpty: document.getElementById('repos-empty'),
            reposList: document.getElementById('repos-list'),
            reposError: document.getElementById('repos-error'),
            retryBtn: document.getElementById('retry-btn'),

            // Queue
            queueSection: document.getElementById('queue-section'),
            queueList: document.getElementById('queue-list'),
            queueRefreshBtn: document.getElementById('queue-refresh-btn'),

            // Modal
            modal: document.getElementById('repo-modal'),
            modalBody: document.getElementById('modal-body'),
            modalClose: document.querySelector('.modal-close'),
            modalBackdrop: document.querySelector('.modal-backdrop'),

            // Bulk Upload
            bulkUploadBtn: document.getElementById('bulk-upload-btn'),
            bulkModal: document.getElementById('bulk-modal'),
            bulkUrls: document.getElementById('bulk-urls'),
            bulkMessage: document.getElementById('bulk-message'),
            bulkSubmitBtn: document.getElementById('bulk-submit-btn'),
            bulkCancelBtn: document.getElementById('bulk-cancel-btn'),
            bulkResults: document.getElementById('bulk-results'),
            bulkClose: document.querySelector('.bulk-close'),
            bulkBackdrop: document.querySelector('.bulk-backdrop')
        };
    },

    /**
     * Bind event listeners
     */
    bindEvents() {
        // Form submission
        this.elements.submitForm.addEventListener('submit', (e) => this.handleSubmit(e));

        // Example buttons
        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.elements.repoUrlInput.value = btn.dataset.url;
                this.elements.repoUrlInput.focus();
            });
        });

        // Search
        this.elements.searchInput.addEventListener('input',
            Utils.debounce((e) => this.handleSearch(e.target.value), 300)
        );

        // Retry button
        this.elements.retryBtn.addEventListener('click', () => this.loadData());

        // Queue refresh button
        if (this.elements.queueRefreshBtn) {
            this.elements.queueRefreshBtn.addEventListener('click', () => this.refreshQueue());
        }

        // Modal close
        this.elements.modalClose.addEventListener('click', () => this.closeModal());
        this.elements.modalBackdrop.addEventListener('click', () => this.closeModal());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
                this.closeBulkModal();
            }
        });

        // Bulk upload modal
        this.elements.bulkUploadBtn.addEventListener('click', () => this.openBulkModal());
        this.elements.bulkClose.addEventListener('click', () => this.closeBulkModal());
        this.elements.bulkBackdrop.addEventListener('click', () => this.closeBulkModal());
        this.elements.bulkCancelBtn.addEventListener('click', () => this.closeBulkModal());
        this.elements.bulkSubmitBtn.addEventListener('click', () => this.handleBulkSubmit());
    },

    /**
     * Load initial data
     */
    async loadData() {
        this.state.isLoading = true;
        this.showLoading();

        try {
            // Load index and pending requests in parallel
            const [index, pending] = await Promise.all([
                API.fetchIndex(),
                API.fetchPendingRequests()
            ]);

            this.state.index = index;
            this.state.pendingRequests = pending;
            this.state.filteredRepos = this.getRepoList();

            this.updateStats();
            this.renderRepos();
            this.renderQueue();
        } catch (error) {
            console.error('Failed to load data:', error);
            this.showError();
        } finally {
            this.state.isLoading = false;
        }
    },

    /**
     * Get sorted list of repositories from index
     * L3: Validates archive_count at data layer to prevent invalid values
     */
    getRepoList() {
        if (!this.state.index?.repositories) return [];

        return Object.entries(this.state.index.repositories)
            .map(([url, data]) => ({
                url,
                ...data,
                // L3: Validate archive_count at data layer (clamp to 1-999)
                archive_count: Math.min(Math.max(parseInt(data.archive_count, 10) || 1, 1), 999)
            }))
            .sort((a, b) => new Date(b.last_archived) - new Date(a.last_archived));
    },

    /**
     * Get paginated subset of filtered repos
     */
    getPaginatedRepos() {
        const end = this.state.currentPage * this.state.pageSize;
        this.state.hasMore = end < this.state.filteredRepos.length;
        return this.state.filteredRepos.slice(0, end);
    },

    /**
     * Load more repositories (for infinite scroll)
     */
    loadMore() {
        if (!this.state.hasMore || this.state.isLoading) return;
        this.state.currentPage++;
        this.renderRepos();
    },

    /**
     * Reset pagination to first page
     */
    resetPagination() {
        this.state.currentPage = 1;
        this.state.hasMore = true;
    },

    /**
     * Setup infinite scroll observer
     */
    setupInfiniteScroll() {
        // Disconnect previous observer if exists
        if (this.scrollObserver) {
            this.scrollObserver.disconnect();
            // M5: Set observer to null after disconnect to prevent memory leaks
            this.scrollObserver = null;
        }

        const sentinel = document.getElementById('load-more-sentinel');
        if (!sentinel) return;

        this.scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.loadMore();
                }
            });
        }, {
            rootMargin: '100px'
        });

        this.scrollObserver.observe(sentinel);
    },

    /**
     * Update statistics display
     */
    updateStats() {
        const { index, pendingRequests } = this.state;

        this.elements.statRepos.textContent = index?.total_repos || 0;
        this.elements.statSize.textContent = index?.total_size_mb
            ? Utils.formatBytes(index.total_size_mb * 1024 * 1024)
            : '0 MB';
        this.elements.statPending.textContent = pendingRequests.length;
    },

    /**
     * Show loading state
     */
    showLoading() {
        Utils.show(this.elements.reposLoading);
        Utils.hide(this.elements.reposEmpty);
        Utils.hide(this.elements.reposList);
        Utils.hide(this.elements.reposError);
    },

    /**
     * Show error state
     */
    showError() {
        Utils.hide(this.elements.reposLoading);
        Utils.hide(this.elements.reposEmpty);
        Utils.hide(this.elements.reposList);
        Utils.show(this.elements.reposError);
    },

    /**
     * Render repository list
     */
    renderRepos() {
        Utils.hide(this.elements.reposLoading);
        Utils.hide(this.elements.reposError);

        // M6: Cancel all pending status checks before rendering new repos
        this.pendingStatusChecks.forEach((abortController, key) => {
            abortController.abort();
        });
        this.pendingStatusChecks.clear();

        const allRepos = this.state.filteredRepos;

        if (allRepos.length === 0) {
            Utils.show(this.elements.reposEmpty);
            Utils.hide(this.elements.reposList);
            return;
        }

        Utils.hide(this.elements.reposEmpty);
        Utils.show(this.elements.reposList);

        const repos = this.getPaginatedRepos();

        // Build HTML with repos count (all content is sanitized via Utils.escapeHtml in renderRepoCard)
        let html = `<div class="repos-count">Showing ${repos.length} of ${allRepos.length} repositories</div>`;
        html += repos.map(repo => this.renderRepoCard(repo)).join('');

        // Add load-more sentinel if there are more repos
        if (this.state.hasMore) {
            html += `<div id="load-more-sentinel" class="load-more-sentinel">
                <span class="spinner"></span>
                <span>Loading more...</span>
            </div>`;
        }

        this.elements.reposList.innerHTML = html;

        // Bind click events to cards and check status
        this.elements.reposList.querySelectorAll('.repo-card').forEach(card => {
            card.addEventListener('click', () => {
                const url = card.dataset.url;
                const repo = allRepos.find(r => r.url === url);
                if (repo) this.openRepoModal(repo);
            });

            // Check source status (async, will update card when complete)
            const owner = card.dataset.owner;
            const repo = card.dataset.repo;
            if (owner && repo) {
                this.checkRepoSourceStatus(owner, repo, card);
            }
        });

        // Setup infinite scroll observer
        this.setupInfiniteScroll();
    },

    /**
     * Render a single repository card
     */
    renderRepoCard(repo) {
        const statusClass = repo.status || 'active';
        const statusLabel = repo.status
            ? repo.status.charAt(0).toUpperCase() + repo.status.slice(1)
            : 'Active';

        return `
            <div class="repo-card" data-url="${Utils.escapeHtml(repo.url)}" data-owner="${Utils.escapeHtml(repo.owner)}" data-repo="${Utils.escapeHtml(repo.repo)}">
                <div class="repo-card-header">
                    <span class="repo-name">${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</span>
                    <div class="repo-status-group">
                        <span class="repo-status ${statusClass}">${statusLabel}</span>
                        <span class="repo-source-status checking"><span class="status-dot pulse"></span></span>
                    </div>
                </div>
                ${repo.description ? `<p class="repo-description">${Utils.escapeHtml(repo.description)}</p>` : ''}
                <div class="repo-meta">
                    <span title="Archive count">📦 ${Math.min(Math.max(repo.archive_count || 1, 1), 999)} version${(repo.archive_count || 1) > 1 ? 's' : ''}</span>
                    <span title="Size">${Utils.formatBytes((repo.latest_size_mb || 0) * 1024 * 1024)}</span>
                    <span title="Last archived">${Utils.formatRelativeTime(repo.last_archived)}</span>
                </div>
            </div>
        `;
    },

    /**
     * Render pending queue
     */
    renderQueue() {
        const { pendingRequests } = this.state;

        if (pendingRequests.length === 0) {
            Utils.hide(this.elements.queueSection);
            return;
        }

        Utils.show(this.elements.queueSection);

        this.elements.queueList.innerHTML = pendingRequests.map(item => `
            <div class="queue-item">
                <span class="spinner"></span>
                <span class="queue-item-url">${Utils.escapeHtml(item.url)}</span>
                <span class="queue-item-time">${Utils.formatRelativeTime(item.created_at)}</span>
            </div>
        `).join('');
    },

    /**
     * Handle search input
     */
    handleSearch(query) {
        // L2: Limit search query length to prevent performance issues
        const limitedQuery = query.slice(0, 200);
        this.state.searchQuery = limitedQuery.toLowerCase().trim();
        const repos = this.getRepoList();

        if (!this.state.searchQuery) {
            this.state.filteredRepos = repos;
        } else {
            this.state.filteredRepos = repos.filter(repo => {
                const searchText = `${repo.owner} ${repo.repo} ${repo.description || ''}`.toLowerCase();
                return searchText.includes(this.state.searchQuery);
            });
        }

        this.resetPagination();
        this.renderRepos();
    },

    /**
     * Handle form submission
     */
    async handleSubmit(e) {
        e.preventDefault();

        const url = this.elements.repoUrlInput.value.trim();

        // Validate URL
        if (!Utils.isValidGitHubUrl(url)) {
            this.showFormMessage('Please enter a valid GitHub repository URL', 'error');
            return;
        }

        // Parse URL
        const parsed = Utils.parseGitHubUrl(url);
        if (!parsed) {
            this.showFormMessage('Could not parse repository URL', 'error');
            return;
        }

        // Check if already archived recently
        const repoKey = `https://github.com/${parsed.owner}/${parsed.repo}`;
        const existingRepo = this.state.index?.repositories?.[repoKey];
        if (existingRepo) {
            const lastArchived = new Date(existingRepo.last_archived);
            const hoursSince = (Date.now() - lastArchived) / (1000 * 60 * 60);
            if (hoursSince < 24) {
                this.showFormMessage(
                    `This repository was archived ${Utils.formatRelativeTime(existingRepo.last_archived)}. Click on it below to download.`,
                    'info'
                );
                return;
            }
        }

        // Check if already in queue
        const inQueue = this.state.pendingRequests.some(item =>
            item.url.includes(`${parsed.owner}/${parsed.repo}`)
        );
        if (inQueue) {
            this.showFormMessage('This repository is already in the queue', 'info');
            return;
        }

        // Disable form
        this.setFormLoading(true);

        try {
            const result = await API.submitUrl(url);

            Toast.success('Repository queued! Issue #' + result.issue_number);
            this.elements.repoUrlInput.value = '';

            // Refresh pending requests
            this.state.pendingRequests = await API.fetchPendingRequests();
            this.renderQueue();
            this.updateStats();
        } catch (error) {
            Toast.error(error.message || 'Failed to submit');
        } finally {
            this.setFormLoading(false);
        }
    },

    /**
     * Show form message
     */
    showFormMessage(message, type) {
        this.elements.formMessage.textContent = message;
        this.elements.formMessage.className = `form-message ${type}`;
        Utils.show(this.elements.formMessage);

        // Auto-hide after 10 seconds
        setTimeout(() => Utils.hide(this.elements.formMessage), 10000);
    },

    /**
     * Set form loading state
     */
    setFormLoading(loading) {
        this.elements.submitBtn.disabled = loading;
        const btnText = this.elements.submitBtn.querySelector('.btn-text');
        const btnLoading = this.elements.submitBtn.querySelector('.btn-loading');

        if (loading) {
            Utils.hide(btnText);
            Utils.show(btnLoading);
        } else {
            Utils.show(btnText);
            Utils.hide(btnLoading);
        }
    },

    /**
     * Open repository detail modal
     */
    async openRepoModal(repo) {
        // Guard: don't open modal without valid repo data
        if (!repo || !repo.owner || !repo.repo) {
            console.error('Cannot open modal: invalid repo data', repo);
            return;
        }

        Utils.show(this.elements.modal);
        document.body.style.overflow = 'hidden';

        // Show loading state
        this.elements.modalBody.innerHTML = `
            <div class="modal-header">
                <h3>${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</h3>
                <p>${Utils.escapeHtml(repo.description || 'No description')}</p>
            </div>
            <div class="loading-state">
                <span class="spinner large"></span>
                <p>Loading...</p>
            </div>
        `;

        try {
            // Fetch versions and README in parallel
            const [versions, readme] = await Promise.all([
                API.fetchRepoVersions(repo.owner, repo.repo),
                API.fetchReadme(repo.owner, repo.repo)
            ]);

            // H1: Validate URL protocol before rendering
            let safeUrl = '';
            try {
                const urlObj = new URL(repo.url);
                if (urlObj.protocol === 'https:' && urlObj.hostname === 'github.com') {
                    safeUrl = Utils.escapeHtml(repo.url);
                }
            } catch (e) {
                console.error('Invalid URL:', repo.url);
            }

            // Render modal content with tabs
            this.elements.modalBody.innerHTML = `
                <div class="modal-header">
                    <h3>${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</h3>
                    <p>${Utils.escapeHtml(repo.description || 'No description')}</p>
                    ${safeUrl ? `<p><a href="${safeUrl}" target="_blank">View on GitHub →</a></p>` : ''}
                </div>

                <div class="modal-tabs">
                    <button class="tab-btn active" data-tab="versions">Versions (${versions.length})</button>
                    <button class="tab-btn" data-tab="readme">README</button>
                </div>

                <div class="tab-content" id="tab-versions">
                    <div class="version-list">
                        ${versions.length > 0 ? versions.map(version => this.renderVersion(version, repo)).join('') : '<p class="empty-message">No versions found</p>'}
                    </div>
                </div>

                <div class="tab-content" id="tab-readme" hidden>
                    <div class="readme-content">
                        ${readme ? Utils.renderMarkdown(readme) : '<p class="empty-message">No README available</p>'}
                    </div>
                </div>
            `;

            // M7: Only bind tab events if data loaded successfully
            const tabButtons = this.elements.modalBody.querySelectorAll('.tab-btn');
            if (tabButtons.length > 0) {
                tabButtons.forEach(btn => {
                    btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
                });
            }
        } catch (error) {
            console.error('Error loading modal content:', error);
            this.elements.modalBody.innerHTML = `
                <div class="modal-header">
                    <h3>${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</h3>
                    <p>${Utils.escapeHtml(repo.description || 'No description')}</p>
                </div>
                <div class="error-state">
                    <p>Failed to load repository details. Please try again.</p>
                    <p class="error-details">${Utils.escapeHtml(error.message)}</p>
                </div>
            `;
        }
    },

    /**
     * Switch modal tab
     */
    switchTab(tabId) {
        // Update button states
        this.elements.modalBody.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Update content visibility
        this.elements.modalBody.querySelectorAll('.tab-content').forEach(content => {
            content.hidden = content.id !== `tab-${tabId}`;
        });
    },

    /**
     * Render a version item
     */
    renderVersion(version, repo) {
        // Find archive (support both old "archive.tar.gz" and new "{owner}_{repo}.tar.gz" naming)
        const archive = version.assets.find(a => a.name.endsWith('.tar.gz'));
        const metadata = version.assets.find(a => a.name === 'metadata.json');

        const parsed = Utils.parseReleaseTag(version.tag);
        const date = parsed?.date || version.date;
        const archiveName = repo ? `${repo.owner}_${repo.repo}.tar.gz` : (archive?.name || 'archive.tar.gz');

        // H2: Validate download URL starts with https:// before rendering
        let safeDownloadLink = '';
        if (archive && archive.download_url) {
            try {
                const downloadUrl = new URL(archive.download_url);
                if (downloadUrl.protocol === 'https:') {
                    const escapedUrl = Utils.escapeHtml(archive.download_url);
                    const escapedName = Utils.escapeHtml(archiveName);
                    safeDownloadLink = `<a href="${escapedUrl}" class="version-download" download="${escapedName}">Download</a>`;
                }
            } catch (e) {
                console.error('Invalid download URL:', archive.download_url);
            }
        }

        return `
            <div class="version-item">
                <div class="version-info">
                    <span class="version-date">${Utils.formatDate(date)}</span>
                    <span class="version-meta">${archive ? Utils.formatBytes(archive.size) : 'Unknown size'}</span>
                </div>
                ${safeDownloadLink}
            </div>
        `;
    },

    /**
     * Close modal
     */
    closeModal() {
        Utils.hide(this.elements.modal);
        document.body.style.overflow = '';
    },

    /**
     * Open bulk upload modal
     */
    openBulkModal() {
        Utils.show(this.elements.bulkModal);
        document.body.style.overflow = 'hidden';
        this.elements.bulkUrls.value = '';
        Utils.hide(this.elements.bulkMessage);
        Utils.hide(this.elements.bulkResults);
        this.elements.bulkUrls.focus();
    },

    /**
     * Close bulk upload modal
     */
    closeBulkModal() {
        Utils.hide(this.elements.bulkModal);
        document.body.style.overflow = '';
    },

    /**
     * Handle bulk upload submission
     */
    async handleBulkSubmit() {
        const text = this.elements.bulkUrls.value.trim();

        if (!text) {
            this.showBulkMessage('Please enter at least one URL', 'error');
            return;
        }

        // Parse URLs (one per line)
        const urls = text.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (urls.length === 0) {
            this.showBulkMessage('Please enter at least one URL', 'error');
            return;
        }

        if (urls.length > 20) {
            this.showBulkMessage('Maximum 20 URLs allowed per bulk submission', 'error');
            return;
        }

        // Validate URLs
        const invalidUrls = urls.filter(url => !Utils.isValidGitHubUrl(url));
        if (invalidUrls.length > 0) {
            this.showBulkMessage(`Invalid URL(s): ${invalidUrls.slice(0, 3).join(', ')}${invalidUrls.length > 3 ? '...' : ''}`, 'error');
            return;
        }

        // Set loading state
        this.setBulkLoading(true);
        Utils.hide(this.elements.bulkMessage);
        Utils.hide(this.elements.bulkResults);

        try {
            const result = await API.bulkSubmit(urls);

            // Show results
            this.showBulkResults(result);

            // Show toast summary
            if (result.summary.successful > 0) {
                Toast.success(`${result.summary.successful} repositories queued!`);
                this.state.pendingRequests = await API.fetchPendingRequests();
                this.renderQueue();
                this.updateStats();
            }
            if (result.summary.failed > 0) {
                Toast.error(`${result.summary.failed} submissions failed`);
            }

        } catch (error) {
            Toast.error(error.message || 'Failed to submit');
        } finally {
            this.setBulkLoading(false);
        }
    },

    /**
     * Show bulk upload message
     */
    showBulkMessage(message, type) {
        this.elements.bulkMessage.textContent = message;
        this.elements.bulkMessage.className = `form-message ${type}`;
        Utils.show(this.elements.bulkMessage);
    },

    /**
     * Set bulk submit loading state
     */
    setBulkLoading(loading) {
        this.elements.bulkSubmitBtn.disabled = loading;
        const btnText = this.elements.bulkSubmitBtn.querySelector('.btn-text');
        const btnLoading = this.elements.bulkSubmitBtn.querySelector('.btn-loading');

        if (loading) {
            Utils.hide(btnText);
            Utils.show(btnLoading);
        } else {
            Utils.show(btnText);
            Utils.hide(btnLoading);
        }
    },

    /**
     * Show bulk upload results
     */
    showBulkResults(result) {
        Utils.show(this.elements.bulkResults);

        const { summary, results } = result;

        this.elements.bulkResults.innerHTML = `
            <div class="bulk-summary">
                <strong>${summary.successful}</strong> queued, <strong>${summary.failed}</strong> failed
            </div>
            ${results.map(r => {
                const parsed = Utils.parseGitHubUrl(r.url);
                // H3: Truncate fallback URLs to prevent UI issues
                const displayUrl = parsed ? `${parsed.owner}/${parsed.repo}` : Utils.truncate(r.url, 100);
                return `
                <div class="bulk-result-item">
                    <span class="bulk-result-icon">${r.success ? '✓' : '✗'}</span>
                    <span class="bulk-result-url">${Utils.escapeHtml(displayUrl)}</span>
                    <span class="bulk-result-status ${r.success ? 'success' : 'error'}">
                        ${r.success ? `#${r.issue_number}` : Utils.escapeHtml(r.error)}
                    </span>
                </div>
            `}).join('')}
        `;
    },

    /**
     * Check and update source status for a repo card
     */
    async checkRepoSourceStatus(owner, repo, cardElement) {
        const statusContainer = cardElement.querySelector('.repo-source-status');
        if (!statusContainer) return;

        // M6: Create AbortController for this status check
        const checkKey = `${owner}/${repo}`;
        const abortController = new AbortController();
        this.pendingStatusChecks.set(checkKey, abortController);

        try {
            const status = await API.checkRepoStatus(owner, repo, abortController.signal);

            // Check if request was aborted
            if (abortController.signal.aborted) return;

            if (status.online === true) {
                statusContainer.className = 'repo-source-status online';
                statusContainer.innerHTML = '<span class="status-dot"></span>Online';
            } else if (status.online === false) {
                statusContainer.className = 'repo-source-status offline';
                statusContainer.innerHTML = '<span class="status-dot"></span>Offline';
            } else {
                statusContainer.className = 'repo-source-status';
                statusContainer.innerHTML = '';
            }
        } catch (error) {
            if (error.name === 'AbortError') return; // Request was cancelled
            console.error('Failed to check status:', error);
            statusContainer.className = 'repo-source-status';
            statusContainer.innerHTML = '';
        } finally {
            this.pendingStatusChecks.delete(checkKey);
        }
    }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
