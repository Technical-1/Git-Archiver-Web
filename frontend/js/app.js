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
        searchQuery: ''
    },

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
            modalBackdrop: document.querySelector('.modal-backdrop')
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
            if (e.key === 'Escape') this.closeModal();
        });
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
     */
    getRepoList() {
        if (!this.state.index?.repositories) return [];

        return Object.entries(this.state.index.repositories)
            .map(([url, data]) => ({ url, ...data }))
            .sort((a, b) => new Date(b.last_archived) - new Date(a.last_archived));
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

        const repos = this.state.filteredRepos;

        if (repos.length === 0) {
            Utils.show(this.elements.reposEmpty);
            Utils.hide(this.elements.reposList);
            return;
        }

        Utils.hide(this.elements.reposEmpty);
        Utils.show(this.elements.reposList);

        this.elements.reposList.innerHTML = repos.map(repo => this.renderRepoCard(repo)).join('');

        // Bind click events to cards
        this.elements.reposList.querySelectorAll('.repo-card').forEach(card => {
            card.addEventListener('click', () => {
                const url = card.dataset.url;
                const repo = repos.find(r => r.url === url);
                if (repo) this.openRepoModal(repo);
            });
        });
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
            <div class="repo-card" data-url="${Utils.escapeHtml(repo.url)}">
                <div class="repo-card-header">
                    <span class="repo-name">${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</span>
                    <span class="repo-status ${statusClass}">${statusLabel}</span>
                </div>
                ${repo.description ? `<p class="repo-description">${Utils.escapeHtml(repo.description)}</p>` : ''}
                <div class="repo-meta">
                    <span title="Archive count">📦 ${repo.archive_count || 1} version${(repo.archive_count || 1) > 1 ? 's' : ''}</span>
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
        this.state.searchQuery = query.toLowerCase().trim();
        const repos = this.getRepoList();

        if (!this.state.searchQuery) {
            this.state.filteredRepos = repos;
        } else {
            this.state.filteredRepos = repos.filter(repo => {
                const searchText = `${repo.owner} ${repo.repo} ${repo.description || ''}`.toLowerCase();
                return searchText.includes(this.state.searchQuery);
            });
        }

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

            this.showFormMessage(
                `Repository queued for archiving! Issue #${result.issue_number} created.`,
                'success'
            );
            this.elements.repoUrlInput.value = '';

            // Refresh pending requests
            this.state.pendingRequests = await API.fetchPendingRequests();
            this.renderQueue();
            this.updateStats();
        } catch (error) {
            this.showFormMessage(error.message || 'Failed to submit. Please try again.', 'error');
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
                <p>Loading versions...</p>
            </div>
        `;

        // Fetch versions
        const versions = await API.fetchRepoVersions(repo.owner, repo.repo);

        // Render modal content
        this.elements.modalBody.innerHTML = `
            <div class="modal-header">
                <h3>${Utils.escapeHtml(repo.owner)}/${Utils.escapeHtml(repo.repo)}</h3>
                <p>${Utils.escapeHtml(repo.description || 'No description')}</p>
                <p>
                    <a href="${Utils.escapeHtml(repo.url)}" target="_blank">View on GitHub →</a>
                </p>
            </div>

            <div class="modal-section">
                <h4>Archived Versions (${versions.length})</h4>
                <div class="version-list">
                    ${versions.length > 0 ? versions.map(version => this.renderVersion(version)).join('') : '<p>No versions found</p>'}
                </div>
            </div>
        `;
    },

    /**
     * Render a version item
     */
    renderVersion(version) {
        const archive = version.assets.find(a => a.name === 'archive.tar.gz');
        const metadata = version.assets.find(a => a.name === 'metadata.json');

        const parsed = Utils.parseReleaseTag(version.tag);
        const date = parsed?.date || version.date;

        return `
            <div class="version-item">
                <div class="version-info">
                    <span class="version-date">${Utils.formatDate(date)}</span>
                    <span class="version-meta">${archive ? Utils.formatBytes(archive.size) : 'Unknown size'}</span>
                </div>
                ${archive ? `<a href="${archive.download_url}" class="version-download" download>Download</a>` : ''}
            </div>
        `;
    },

    /**
     * Close modal
     */
    closeModal() {
        Utils.hide(this.elements.modal);
        document.body.style.overflow = '';
    }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
