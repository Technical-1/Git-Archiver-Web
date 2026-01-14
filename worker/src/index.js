/**
 * Git-Archiver Web - Cloudflare Worker
 *
 * This worker handles repository submission requests and creates
 * GitHub issues to trigger the archive workflow.
 *
 * Environment variables required:
 * - GITHUB_TOKEN: Personal Access Token with repo scope
 * - GITHUB_OWNER: Repository owner (your username)
 * - GITHUB_REPO: Repository name (git-archiver-web)
 */

// Rate limiting configuration
const RATE_LIMITS = {
    requests_per_hour: 10,
    requests_per_day: 50
};

// GitHub URL validation regex
const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/;

/**
 * Main request handler
 */
export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return handleCORS();
        }

        const url = new URL(request.url);

        // Route requests
        if (request.method === 'POST' && url.pathname === '/submit') {
            return handleSubmit(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
        }

        if (request.method === 'GET' && url.pathname === '/index') {
            return handleIndexFetch(env);
        }

        if (request.method === 'GET' && url.pathname === '/readme') {
            const owner = url.searchParams.get('owner');
            const repo = url.searchParams.get('repo');
            const tag = url.searchParams.get('tag');
            if (!owner || !repo) {
                return errorResponse(400, 'Missing owner or repo parameter');
            }
            return handleReadmeFetch(owner, repo, tag, env);
        }

        if (request.method === 'GET' && url.pathname === '/status') {
            const owner = url.searchParams.get('owner');
            const repo = url.searchParams.get('repo');
            if (!owner || !repo) {
                return errorResponse(400, 'Missing owner or repo parameter');
            }
            return handleStatusCheck(owner, repo);
        }

        if (request.method === 'POST' && url.pathname === '/bulk-submit') {
            return handleBulkSubmit(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/') {
            return jsonResponse({
                service: 'Git-Archiver Web API',
                endpoints: {
                    'POST /submit': 'Submit a repository URL for archiving',
                    'POST /bulk-submit': 'Submit multiple repository URLs',
                    'GET /index': 'Fetch the master index of archived repositories',
                    'GET /readme': 'Fetch README for archived repo (?owner=X&repo=Y&tag=Z)',
                    'GET /status': 'Check if original repo is online (?owner=X&repo=Y)',
                    'GET /health': 'Health check'
                }
            });
        }

        return errorResponse(404, 'Not found');
    }
};

/**
 * Fetch and proxy the index.json from GitHub releases
 * This avoids CORS issues with GitHub's release asset redirects
 */
async function handleIndexFetch(env) {
    try {
        // Common headers for GitHub API (with auth to avoid rate limits)
        const githubHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Git-Archiver-Worker/1.0',
            'Authorization': `token ${env.GITHUB_TOKEN}`
        };

        // First, get the release info
        const releaseUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/index`;
        const releaseResponse = await fetch(releaseUrl, { headers: githubHeaders });

        if (!releaseResponse.ok) {
            if (releaseResponse.status === 404) {
                return jsonResponse({ repositories: {}, total_repos: 0, total_size_mb: 0 });
            }
            throw new Error(`Failed to fetch release: ${releaseResponse.status}`);
        }

        const release = await releaseResponse.json();

        // Find the index.json asset
        const indexAsset = release.assets?.find(a => a.name === 'index.json');
        if (!indexAsset) {
            return jsonResponse({ repositories: {}, total_repos: 0, total_size_mb: 0 });
        }

        // Fetch the asset content (with auth)
        const assetResponse = await fetch(indexAsset.url, {
            headers: {
                'Accept': 'application/octet-stream',
                'User-Agent': 'Git-Archiver-Worker/1.0',
                'Authorization': `token ${env.GITHUB_TOKEN}`
            }
        });

        if (!assetResponse.ok) {
            throw new Error(`Failed to fetch index asset: ${assetResponse.status}`);
        }

        const indexData = await assetResponse.json();
        return jsonResponse(indexData);

    } catch (error) {
        console.error('Index fetch error:', error);
        return errorResponse(500, 'Failed to fetch index');
    }
}

/**
 * Handle repository submission
 */
async function handleSubmit(request, env) {
    try {
        // Parse request body
        const body = await request.json();
        const repoUrl = body.url?.trim();

        // Validate URL
        if (!repoUrl) {
            return errorResponse(400, 'Missing URL');
        }

        const match = repoUrl.match(GITHUB_URL_REGEX);
        if (!match) {
            return errorResponse(400, 'Invalid GitHub URL. Format: https://github.com/owner/repo');
        }

        const [, owner, repo] = match;

        // Rate limiting (using in-memory for simplicity, use KV for production)
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateLimitResult = await checkRateLimit(clientIP, env);
        if (!rateLimitResult.allowed) {
            return errorResponse(429, `Rate limit exceeded. Try again in ${rateLimitResult.retryAfter} seconds.`);
        }

        // Check if repository exists
        const repoCheck = await checkRepository(owner, repo);
        if (!repoCheck.exists) {
            return errorResponse(404, 'Repository not found on GitHub');
        }

        if (repoCheck.private) {
            return errorResponse(400, 'Cannot archive private repositories');
        }

        // Check repository size (2GB limit)
        const maxSizeBytes = 2 * 1024 * 1024 * 1024; // 2GB
        if (repoCheck.size > maxSizeBytes) {
            return errorResponse(400, `Repository too large (${formatBytes(repoCheck.size)}). Maximum size is 2GB.`);
        }

        // Check for existing pending request (open issue)
        const existingIssue = await checkExistingRequest(owner, repo, env);
        if (existingIssue) {
            return errorResponse(409, `This repository is already queued (Issue #${existingIssue.number})`);
        }

        // Check if already archived today
        const todayRelease = await checkTodayRelease(owner, repo, env);
        if (todayRelease) {
            return errorResponse(409, `This repository was already archived today. Download: ${todayRelease.url}`);
        }

        // Create GitHub issue
        const issue = await createGitHubIssue(owner, repo, repoUrl, env);

        return jsonResponse({
            success: true,
            message: 'Repository queued for archiving',
            issue_number: issue.number,
            issue_url: issue.html_url
        }, 201);

    } catch (error) {
        console.error('Submit error:', error);
        return errorResponse(500, 'Internal server error');
    }
}

/**
 * Check rate limit for IP address
 * Simple in-memory implementation - for production, use Cloudflare KV
 */
async function checkRateLimit(ip, env) {
    // For now, always allow (implement KV-based rate limiting for production)
    // In production, use env.RATE_LIMIT KV namespace

    return { allowed: true };

    /* Production implementation with KV:
    const key = `rate:${ip}`;
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);

    try {
        const data = await env.RATE_LIMIT.get(key, { type: 'json' });

        if (!data) {
            // First request
            await env.RATE_LIMIT.put(key, JSON.stringify({ requests: [now] }), { expirationTtl: 3600 });
            return { allowed: true };
        }

        // Filter requests in last hour
        const recentRequests = data.requests.filter(t => t > hourAgo);

        if (recentRequests.length >= RATE_LIMITS.requests_per_hour) {
            const oldestRequest = Math.min(...recentRequests);
            const retryAfter = Math.ceil((oldestRequest + 3600000 - now) / 1000);
            return { allowed: false, retryAfter };
        }

        // Add this request
        recentRequests.push(now);
        await env.RATE_LIMIT.put(key, JSON.stringify({ requests: recentRequests }), { expirationTtl: 3600 });

        return { allowed: true };
    } catch (error) {
        console.error('Rate limit error:', error);
        return { allowed: true }; // Fail open
    }
    */
}

/**
 * Check if repository exists on GitHub
 */
async function checkRepository(owner, repo) {
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Git-Archiver-Worker/1.0'
            }
        });

        if (response.status === 404) {
            return { exists: false };
        }

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const data = await response.json();

        return {
            exists: true,
            private: data.private,
            archived: data.archived,
            size: data.size * 1024, // GitHub reports in KB
            description: data.description
        };
    } catch (error) {
        console.error('Repository check error:', error);
        // Fail open - let the action try anyway
        return { exists: true, private: false, size: 0 };
    }
}

/**
 * Check for existing open issue for this repository
 */
async function checkExistingRequest(owner, repo, env) {
    try {
        const response = await fetch(
            `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?labels=archive-request&state=open&per_page=100`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${env.GITHUB_TOKEN}`,
                    'User-Agent': 'Git-Archiver-Worker/1.0'
                }
            }
        );

        if (!response.ok) return null;

        const issues = await response.json();
        const searchPattern = `${owner}/${repo}`.toLowerCase();

        return issues.find(issue =>
            issue.title.toLowerCase().includes(searchPattern) ||
            issue.body?.toLowerCase().includes(searchPattern)
        );
    } catch (error) {
        console.error('Check existing request error:', error);
        return null; // Fail open
    }
}

/**
 * Check if repository was already archived today
 */
async function checkTodayRelease(owner, repo, env) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const tag = `${owner}__${repo}__${today}`;

        const response = await fetch(
            `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/${tag}`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${env.GITHUB_TOKEN}`,
                    'User-Agent': 'Git-Archiver-Worker/1.0'
                }
            }
        );

        if (response.status === 404) return null;
        if (!response.ok) return null;

        const release = await response.json();
        return {
            tag: release.tag_name,
            url: release.html_url
        };
    } catch (error) {
        console.error('Check today release error:', error);
        return null; // Fail open
    }
}

/**
 * Create GitHub issue to trigger archive workflow
 */
async function createGitHubIssue(owner, repo, repoUrl, env) {
    const issueBody = `---
url: ${repoUrl}
requested_at: ${new Date().toISOString()}
---

Automated archive request for \`${owner}/${repo}\`

This issue will be automatically closed once the archive is created.`;

    const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`,
        {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${env.GITHUB_TOKEN}`,
                'User-Agent': 'Git-Archiver-Worker/1.0',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: `Archive Request: ${owner}/${repo}`,
                body: issueBody,
                labels: ['archive-request']
            })
        }
    );

    if (!response.ok) {
        const error = await response.text();
        console.error('GitHub issue creation failed:', error);
        throw new Error('Failed to create archive request');
    }

    return await response.json();
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        }
    });
}

/**
 * Create JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

/**
 * Create error response
 */
function errorResponse(status, message) {
    return jsonResponse({ error: message }, status);
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Fetch README from archived release
 * Proxies the request to avoid CORS issues
 */
async function handleReadmeFetch(owner, repo, tag, env) {
    try {
        const githubHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Git-Archiver-Worker/1.0',
            'Authorization': `token ${env.GITHUB_TOKEN}`
        };

        // If no tag provided, find the latest release for this repo
        let releaseTag = tag;
        if (!releaseTag) {
            // Fetch all releases and find latest for this owner/repo
            const releasesUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=100`;
            const releasesResponse = await fetch(releasesUrl, { headers: githubHeaders });

            if (!releasesResponse.ok) {
                return errorResponse(500, 'Failed to fetch releases');
            }

            const releases = await releasesResponse.json();
            const repoPrefix = `${owner}__${repo}__`;
            const matchingReleases = releases.filter(r => r.tag_name.startsWith(repoPrefix));

            if (matchingReleases.length === 0) {
                return errorResponse(404, 'No archived versions found for this repository');
            }

            // Sort by date (newest first) and get the latest
            matchingReleases.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            releaseTag = matchingReleases[0].tag_name;
        }

        // Fetch the release to get README asset
        const releaseUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/${releaseTag}`;
        const releaseResponse = await fetch(releaseUrl, { headers: githubHeaders });

        if (!releaseResponse.ok) {
            if (releaseResponse.status === 404) {
                return errorResponse(404, 'Release not found');
            }
            throw new Error(`Failed to fetch release: ${releaseResponse.status}`);
        }

        const release = await releaseResponse.json();

        // Find README asset
        const readmeAsset = release.assets?.find(a => a.name === 'README.md');
        if (!readmeAsset) {
            return jsonResponse({ readme: null, message: 'No README available for this archive' });
        }

        // Fetch README content
        const readmeResponse = await fetch(readmeAsset.url, {
            headers: {
                'Accept': 'application/octet-stream',
                'User-Agent': 'Git-Archiver-Worker/1.0',
                'Authorization': `token ${env.GITHUB_TOKEN}`
            }
        });

        if (!readmeResponse.ok) {
            throw new Error(`Failed to fetch README: ${readmeResponse.status}`);
        }

        const readmeContent = await readmeResponse.text();
        return jsonResponse({ readme: readmeContent, tag: releaseTag });

    } catch (error) {
        console.error('README fetch error:', error);
        return errorResponse(500, 'Failed to fetch README');
    }
}

/**
 * Check if original repository is still online
 */
async function handleStatusCheck(owner, repo) {
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Git-Archiver-Worker/1.0'
            }
        });

        if (response.status === 404) {
            return jsonResponse({
                online: false,
                status: 'deleted',
                message: 'Repository not found'
            });
        }

        if (response.status === 451) {
            return jsonResponse({
                online: false,
                status: 'dmca',
                message: 'Repository unavailable due to DMCA'
            });
        }

        if (!response.ok) {
            return jsonResponse({
                online: null,
                status: 'unknown',
                message: `Unable to check status: ${response.status}`
            });
        }

        const data = await response.json();

        return jsonResponse({
            online: true,
            status: data.archived ? 'archived' : 'active',
            private: data.private,
            archived: data.archived,
            message: data.archived ? 'Repository is archived on GitHub' : 'Repository is active'
        });

    } catch (error) {
        console.error('Status check error:', error);
        return jsonResponse({
            online: null,
            status: 'error',
            message: 'Failed to check repository status'
        });
    }
}

/**
 * Handle bulk submission of multiple repositories
 */
async function handleBulkSubmit(request, env) {
    try {
        const body = await request.json();
        const urls = body.urls;

        if (!Array.isArray(urls) || urls.length === 0) {
            return errorResponse(400, 'Missing or empty urls array');
        }

        // Limit bulk submissions
        const MAX_BULK_URLS = 20;
        if (urls.length > MAX_BULK_URLS) {
            return errorResponse(400, `Maximum ${MAX_BULK_URLS} URLs per bulk submission`);
        }

        const results = [];
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

        for (const url of urls) {
            const repoUrl = url?.trim();

            // Validate URL
            if (!repoUrl) {
                results.push({ url, success: false, error: 'Empty URL' });
                continue;
            }

            const match = repoUrl.match(GITHUB_URL_REGEX);
            if (!match) {
                results.push({ url: repoUrl, success: false, error: 'Invalid GitHub URL' });
                continue;
            }

            const [, owner, repo] = match;

            try {
                // Check if repository exists
                const repoCheck = await checkRepository(owner, repo);
                if (!repoCheck.exists) {
                    results.push({ url: repoUrl, success: false, error: 'Repository not found' });
                    continue;
                }

                if (repoCheck.private) {
                    results.push({ url: repoUrl, success: false, error: 'Cannot archive private repositories' });
                    continue;
                }

                // Check size limit
                const maxSizeBytes = 2 * 1024 * 1024 * 1024;
                if (repoCheck.size > maxSizeBytes) {
                    results.push({ url: repoUrl, success: false, error: `Repository too large (${formatBytes(repoCheck.size)})` });
                    continue;
                }

                // Check for existing pending request
                const existingIssue = await checkExistingRequest(owner, repo, env);
                if (existingIssue) {
                    results.push({ url: repoUrl, success: false, error: `Already queued (Issue #${existingIssue.number})`, issue_number: existingIssue.number });
                    continue;
                }

                // Check if already archived today
                const todayRelease = await checkTodayRelease(owner, repo, env);
                if (todayRelease) {
                    results.push({ url: repoUrl, success: false, error: 'Already archived today', release_url: todayRelease.url });
                    continue;
                }

                // Create GitHub issue
                const issue = await createGitHubIssue(owner, repo, repoUrl, env);
                results.push({
                    url: repoUrl,
                    success: true,
                    issue_number: issue.number,
                    issue_url: issue.html_url
                });

                // Small delay between issue creations to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                console.error(`Bulk submit error for ${repoUrl}:`, error);
                results.push({ url: repoUrl, success: false, error: 'Failed to process' });
            }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        return jsonResponse({
            success: true,
            summary: {
                total: urls.length,
                successful,
                failed
            },
            results
        }, successful > 0 ? 201 : 200);

    } catch (error) {
        console.error('Bulk submit error:', error);
        return errorResponse(500, 'Internal server error');
    }
}
