/**
 * API client for Git-Archiver Web
 */

const API = {
    // Configuration
    config: {
        // Your GitHub username/org
        GITHUB_OWNER: 'Technical-1',
        // Your repository name
        GITHUB_REPO: 'Git-Archiver-Web',
        // Cloudflare Worker URL
        WORKER_URL: 'https://git-archiver.btc-treasuries.workers.dev',
        // GitHub API base
        GITHUB_API: 'https://api.github.com'
    },

    /**
     * Fetch the master index of all archived repositories
     * Uses the worker to proxy the request and avoid CORS issues
     * @returns {Promise<Object>}
     */
    async fetchIndex() {
        try {
            const response = await fetch(`${this.config.WORKER_URL}/index`);

            if (!response.ok) {
                throw new Error(`Failed to fetch index: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching index:', error);
            throw error;
        }
    },

    /**
     * Fetch pending archive requests (open issues)
     * @returns {Promise<Array>}
     */
    async fetchPendingRequests() {
        try {
            const url = `${this.config.GITHUB_API}/repos/${this.config.GITHUB_OWNER}/${this.config.GITHUB_REPO}/issues?labels=archive-request&state=open&per_page=20`;
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 404) return [];
                throw new Error(`Failed to fetch issues: ${response.status}`);
            }

            const issues = await response.json();

            // Parse issue body to extract URL
            return issues.map(issue => {
                const urlMatch = issue.body?.match(/url:\s*(https:\/\/github\.com\/[^\s]+)/);
                return {
                    id: issue.id,
                    number: issue.number,
                    url: urlMatch ? urlMatch[1] : null,
                    created_at: issue.created_at,
                    title: issue.title
                };
            }).filter(item => item.url);
        } catch (error) {
            console.error('Error fetching pending requests:', error);
            return [];
        }
    },

    /**
     * Fetch releases for a specific repository
     * @param {string} owner - Repo owner
     * @param {string} repo - Repo name
     * @returns {Promise<Array>}
     */
    async fetchRepoVersions(owner, repo) {
        try {
            // Fetch all releases and filter by tag prefix
            const prefix = `${owner}__${repo}__`;
            const url = `${this.config.GITHUB_API}/repos/${this.config.GITHUB_OWNER}/${this.config.GITHUB_REPO}/releases?per_page=100`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`Failed to fetch releases: ${response.status}`);
            }

            const releases = await response.json();

            // Filter releases for this repo
            return releases
                .filter(release => release.tag_name.startsWith(prefix))
                .map(release => ({
                    tag: release.tag_name,
                    date: release.published_at,
                    assets: release.assets.map(asset => ({
                        name: asset.name,
                        size: asset.size,
                        download_url: asset.browser_download_url
                    }))
                }));
        } catch (error) {
            console.error('Error fetching repo versions:', error);
            return [];
        }
    },

    /**
     * Submit a new repository URL for archiving
     * @param {string} url - GitHub repository URL
     * @returns {Promise<Object>}
     */
    async submitUrl(url) {
        try {
            const response = await fetch(`${this.config.WORKER_URL}/submit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ url })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Submission failed');
            }

            return data;
        } catch (error) {
            console.error('Error submitting URL:', error);
            throw error;
        }
    },

    /**
     * Check if a repository exists on GitHub
     * @param {string} owner
     * @param {string} repo
     * @returns {Promise<Object|null>}
     */
    async checkRepository(owner, repo) {
        try {
            const url = `${this.config.GITHUB_API}/repos/${owner}/${repo}`;
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`GitHub API error: ${response.status}`);
            }

            const data = await response.json();
            return {
                exists: true,
                description: data.description,
                stars: data.stargazers_count,
                size: data.size * 1024, // GitHub reports size in KB
                archived: data.archived,
                private: data.private
            };
        } catch (error) {
            console.error('Error checking repository:', error);
            return null;
        }
    },

    /**
     * Get direct download URL for an archive
     * @param {string} tag - Release tag
     * @returns {string}
     */
    getDownloadUrl(tag) {
        return `https://github.com/${this.config.GITHUB_OWNER}/${this.config.GITHUB_REPO}/releases/download/${tag}/archive.tar.gz`;
    }
};

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
}
