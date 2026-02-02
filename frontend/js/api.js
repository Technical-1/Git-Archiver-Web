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
        GITHUB_API: 'https://api.github.com',
        // M1: Fetch timeout in milliseconds
        FETCH_TIMEOUT: 30000,
        // M2: Max response size in bytes (10MB)
        MAX_RESPONSE_SIZE: 10 * 1024 * 1024
    },

    /**
     * M1: Fetch with timeout wrapper using AbortController
     * @param {string} url - URL to fetch
     * @param {Object} options - Fetch options
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise<Response>}
     */
    async fetchWithTimeout(url, options = {}, timeout = this.config.FETCH_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: options.signal || controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timeout');
            }
            throw error;
        }
    },

    /**
     * M2: Validate response size before parsing
     * @param {Response} response
     * @throws {Error} if response is too large
     */
    validateResponseSize(response) {
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > this.config.MAX_RESPONSE_SIZE) {
            throw new Error('Response size exceeds maximum allowed (10MB)');
        }
    },

    /**
     * Validate index structure
     * @param {Object} index
     * @returns {boolean}
     */
    validateIndex(index) {
        if (!index || typeof index !== 'object') return false;
        if (typeof index.repositories !== 'object') return false;
        if (typeof index.total_repos !== 'number') return false;
        if (typeof index.total_size_mb !== 'number') return false;
        return true;
    },

    /**
     * Fetch the master index of all archived repositories
     * Uses the worker to proxy the request and avoid CORS issues
     * @returns {Promise<Object>}
     */
    async fetchIndex() {
        try {
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(`${this.config.WORKER_URL}/index`);

            if (!response.ok) {
                throw new Error(`Failed to fetch index: ${response.status}`);
            }

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let index;
            try {
                index = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse index JSON: ' + parseError.message);
            }

            if (!this.validateIndex(index)) {
                console.error('Index validation failed, using empty index');
                return { repositories: {}, total_repos: 0, total_size_mb: 0 };
            }

            return index;
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
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(url);

            if (!response.ok) {
                if (response.status === 404) return [];
                throw new Error(`Failed to fetch issues: ${response.status}`);
            }

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let issues;
            try {
                issues = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse issues JSON: ' + parseError.message);
            }

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
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(url);

            if (!response.ok) {
                throw new Error(`Failed to fetch releases: ${response.status}`);
            }

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let releases;
            try {
                releases = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse releases JSON: ' + parseError.message);
            }

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
     * Fetch README content from a release via worker proxy
     * @param {string} owner - Repo owner
     * @param {string} repo - Repo name
     * @param {string} tag - Release tag (optional, uses latest if not provided)
     * @returns {Promise<string>}
     */
    async fetchReadme(owner, repo, tag = null) {
        try {
            let url = `${this.config.WORKER_URL}/readme?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
            if (tag) {
                url += `&tag=${encodeURIComponent(tag)}`;
            }

            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(url);
            if (!response.ok) return null;

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse README JSON: ' + parseError.message);
            }
            return data.readme;
        } catch (error) {
            console.error('Error fetching README:', error);
            return null;
        }
    },

    /**
     * Check if original repository is online/offline
     * @param {string} owner - Repo owner
     * @param {string} repo - Repo name
     * @param {AbortSignal} signal - Optional abort signal for cancellation
     * @returns {Promise<Object>}
     */
    async checkRepoStatus(owner, repo, signal = null) {
        try {
            const url = `${this.config.WORKER_URL}/status?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
            // M1: Use fetch with timeout, pass signal if provided
            const response = await this.fetchWithTimeout(url, signal ? { signal } : {});

            if (!response.ok) {
                return { online: null, status: 'error', message: 'Failed to check status' };
            }

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            try {
                return await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse status JSON: ' + parseError.message);
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error; // Re-throw abort errors
            console.error('Error checking repo status:', error);
            return { online: null, status: 'error', message: 'Failed to check status' };
        }
    },

    /**
     * Submit multiple repository URLs for archiving
     * @param {Array<string>} urls - Array of GitHub repository URLs
     * @returns {Promise<Object>}
     */
    async bulkSubmit(urls) {
        try {
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(`${this.config.WORKER_URL}/bulk-submit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ urls })
            });

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse bulk submit response: ' + parseError.message);
            }

            if (!response.ok && !data.results) {
                throw new Error(data.error || 'Bulk submission failed');
            }

            return data;
        } catch (error) {
            console.error('Error bulk submitting URLs:', error);
            throw error;
        }
    },

    /**
     * Submit a new repository URL for archiving
     * @param {string} url - GitHub repository URL
     * @returns {Promise<Object>}
     */
    async submitUrl(url) {
        try {
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(`${this.config.WORKER_URL}/submit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ url })
            });

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse submit response: ' + parseError.message);
            }

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
            // M1: Use fetch with timeout
            const response = await this.fetchWithTimeout(url);

            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`GitHub API error: ${response.status}`);
            }

            // M2: Validate response size
            this.validateResponseSize(response);

            // M9: Wrap JSON parsing with try-catch
            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error('Failed to parse repository JSON: ' + parseError.message);
            }

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
