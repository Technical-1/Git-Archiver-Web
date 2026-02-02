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

/**
 * Logger class for structured logging with request tracking
 */
class Logger {
    constructor(requestId) {
        this.requestId = requestId;
        this.startTime = Date.now();
    }

    log(level, message, data = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            requestId: this.requestId,
            level,
            message,
            durationMs: Date.now() - this.startTime,
            ...data
        };
        console.log(JSON.stringify(entry));
    }

    info(message, data) { this.log('info', message, data); }
    warn(message, data) { this.log('warn', message, data); }
    error(message, data) { this.log('error', message, data); }
}

/**
 * Generate a unique request ID for tracking using crypto
 */
function generateRequestId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return 'req_' + Date.now().toString(36) + '_' + hex;
}

// Constants
const MAX_REPO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB limit
const MAX_BULK_URLS = 20;

// Rate limiting configuration per endpoint
const RATE_LIMITS = {
    submit: { limit: 10, windowSeconds: 3600 },       // 10 requests per hour
    bulkSubmit: { limit: 3, windowSeconds: 3600 },    // 3 requests per hour
    index: { limit: 60, windowSeconds: 60 },          // 60 requests per minute
    status: { limit: 30, windowSeconds: 60 },         // 30 requests per minute
    readme: { limit: 30, windowSeconds: 60 }          // 30 requests per minute
};

// Cache TTL configuration (in seconds)
const CACHE_TTL = {
    index: 300,      // 5 minutes
    status: 60,      // 1 minute
    readme: 3600     // 1 hour
};

// GitHub URL validation regex
const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/;

/**
 * Fetch with retry logic for handling transient failures
 * Implements exponential backoff with respect for Retry-After headers
 */
async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
    let lastError;
    let delay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(url, options);

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                delay = retryAfter ? parseInt(retryAfter) * 1000 : delay * 2;
                throw new Error(`Rate limited, retry after ${delay}ms`);
            }

            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`);
            }

            return response;
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt}/${maxAttempts} failed:`, error.message);

            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, 30000);
            }
        }
    }

    throw lastError;
}

/**
 * Cached fetch helper using Cloudflare's Cache API
 * Caches responses for the specified TTL and adds X-Cache header
 *
 * @param {Request} request - The original request (used for cache key URL base)
 * @param {string} endpoint - The endpoint name (index, status, readme)
 * @param {Function} fetchFn - Async function that returns the Response to cache
 * @returns {Response} - Cached or fresh response with X-Cache header
 */
async function cachedFetch(request, endpoint, fetchFn) {
    const cache = caches.default;
    const ttl = CACHE_TTL[endpoint] || 60;

    // Create a cache key based on the request URL
    const cacheKey = new Request(request.url, {
        method: 'GET',
        headers: {}
    });

    // Try to get from cache first
    let response = await cache.match(cacheKey);

    if (response) {
        // Clone the response and add cache hit header
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-Cache', 'HIT');
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    }

    // Cache miss - fetch fresh data
    response = await fetchFn();

    // Only cache successful responses
    if (response.status === 200) {
        // Clone the response for caching (with cache control headers)
        const responseToCache = new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                ...Object.fromEntries(response.headers),
                'Cache-Control': `public, max-age=${ttl}`
            }
        });

        // Store in cache (don't await - fire and forget)
        cache.put(cacheKey, responseToCache);
    }

    // Return response with cache miss header
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Cache', 'MISS');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

/**
 * Extract client IP from request headers
 * Prefers CF-Connecting-IP (Cloudflare's header), falls back to X-Forwarded-For
 */
function getClientIP(request) {
    // CF-Connecting-IP is the most reliable on Cloudflare
    const cfIP = request.headers.get('CF-Connecting-IP');
    if (cfIP) {
        return cfIP;
    }

    // X-Forwarded-For can contain multiple IPs, take the first (original client)
    const forwardedFor = request.headers.get('X-Forwarded-For');
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }

    return 'unknown';
}

/**
 * Add X-Request-ID header to a response
 */
function addRequestIdHeader(response, requestId) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Request-ID', requestId);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

/**
 * Main request handler
 */
export default {
    async fetch(request, env, ctx) {
        // Generate request ID for tracking
        const requestId = generateRequestId();
        const logger = new Logger(requestId);
        const url = new URL(request.url);

        logger.info('Request received', { method: request.method, path: url.pathname });

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            const response = handleCORS();
            logger.info('Request completed', { status: 204 });
            return addRequestIdHeader(response, requestId);
        }

        let response;

        // Route requests
        if (request.method === 'POST' && url.pathname === '/submit') {
            response = await handleSubmit(request, env, logger);
        } else if (request.method === 'GET' && url.pathname === '/health') {
            response = jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
        } else if (request.method === 'GET' && url.pathname === '/index') {
            response = await handleIndexFetch(request, env, logger);
        } else if (request.method === 'GET' && url.pathname === '/readme') {
            const owner = url.searchParams.get('owner');
            const repo = url.searchParams.get('repo');
            const tag = url.searchParams.get('tag');
            if (!owner || !repo) {
                response = errorResponse(400, 'Missing owner or repo parameter');
            } else {
                response = await handleReadmeFetch(request, owner, repo, tag, env, logger);
            }
        } else if (request.method === 'GET' && url.pathname === '/status') {
            const owner = url.searchParams.get('owner');
            const repo = url.searchParams.get('repo');
            if (!owner || !repo) {
                response = errorResponse(400, 'Missing owner or repo parameter');
            } else {
                response = await handleStatusCheck(request, owner, repo, env, logger);
            }
        } else if (request.method === 'POST' && url.pathname === '/bulk-submit') {
            response = await handleBulkSubmit(request, env, logger);
        } else if (request.method === 'GET' && url.pathname === '/') {
            response = jsonResponse({
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
        } else {
            response = errorResponse(404, 'Not found');
        }

        logger.info('Request completed', { status: response.status });
        return addRequestIdHeader(response, requestId);
    }
};

/**
 * Fetch and proxy the index.json from GitHub releases
 * This avoids CORS issues with GitHub's release asset redirects
 * Uses Cloudflare Cache API for response caching
 */
async function handleIndexFetch(request, env, logger) {
    try {
        // Rate limiting check at the start
        const clientIP = getClientIP(request);
        const rateLimitResult = await checkRateLimit(clientIP, 'index', env);
        if (!rateLimitResult.allowed) {
            logger.warn('Rate limit exceeded', { clientIP, endpoint: 'index' });
            return rateLimitResponse(rateLimitResult);
        }

        // Use cached fetch for the index data
        const response = await cachedFetch(request, 'index', async () => {
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
            logger.info('Index fetched from GitHub', { repoCount: indexData.total_repos });
            return jsonResponse(indexData);
        });

        const cacheStatus = response.headers.get('X-Cache');
        logger.info('Index fetch completed', { cache: cacheStatus });

        return addRateLimitHeaders(response, rateLimitResult);

    } catch (error) {
        logger.error('Index fetch error', { error: error.message });
        return errorResponse(500, 'Failed to fetch index');
    }
}

/**
 * Handle repository submission
 */
async function handleSubmit(request, env, logger) {
    try {
        // Rate limiting check at the start
        const clientIP = getClientIP(request);
        const rateLimitResult = await checkRateLimit(clientIP, 'submit', env);
        if (!rateLimitResult.allowed) {
            logger.warn('Rate limit exceeded', { clientIP, endpoint: 'submit' });
            return rateLimitResponse(rateLimitResult);
        }

        // Parse request body
        const body = await request.json();
        const repoUrl = body.url?.trim();

        // Validate URL
        if (!repoUrl) {
            return addRateLimitHeaders(errorResponse(400, 'Missing URL'), rateLimitResult);
        }

        const match = repoUrl.match(GITHUB_URL_REGEX);
        if (!match) {
            return addRateLimitHeaders(
                errorResponse(400, 'Invalid GitHub URL. Format: https://github.com/owner/repo'),
                rateLimitResult
            );
        }

        const [, owner, repo] = match;
        logger.info('Processing submission', { owner, repo });

        // Check if repository exists
        const repoCheck = await checkRepository(owner, repo, env);
        if (!repoCheck.exists) {
            if (repoCheck.error) {
                logger.warn('Repository verification failed', { owner, repo, error: repoCheck.error });
                return addRateLimitHeaders(errorResponse(503, repoCheck.error), rateLimitResult);
            }
            return addRateLimitHeaders(errorResponse(404, 'Repository not found on GitHub'), rateLimitResult);
        }

        if (repoCheck.private) {
            return addRateLimitHeaders(errorResponse(400, 'Cannot archive private repositories'), rateLimitResult);
        }

        // Check repository size limit
        if (repoCheck.size > MAX_REPO_SIZE_BYTES) {
            return addRateLimitHeaders(
                errorResponse(400, `Repository too large (${formatBytes(repoCheck.size)}). Maximum size is ${formatBytes(MAX_REPO_SIZE_BYTES)}.`),
                rateLimitResult
            );
        }

        // Check for existing pending request (open issue)
        const existingIssue = await checkExistingRequest(owner, repo, env);
        if (existingIssue) {
            return addRateLimitHeaders(
                errorResponse(409, `This repository is already queued (Issue #${existingIssue.number})`),
                rateLimitResult
            );
        }

        // Check if already archived today
        const todayRelease = await checkTodayRelease(owner, repo, env);
        if (todayRelease) {
            return addRateLimitHeaders(
                errorResponse(409, `This repository was already archived today. Download: ${todayRelease.url}`),
                rateLimitResult
            );
        }

        // Create GitHub issue
        const issue = await createGitHubIssue(owner, repo, repoUrl, env);
        logger.info('Submission successful', { owner, repo, issueNumber: issue.number });

        return addRateLimitHeaders(
            jsonResponse({
                success: true,
                message: 'Repository queued for archiving',
                issue_number: issue.number,
                issue_url: issue.html_url
            }, 201),
            rateLimitResult
        );

    } catch (error) {
        logger.error('Submit error', { error: error.message });
        return errorResponse(500, 'Internal server error');
    }
}

/**
 * Check rate limit for IP address and endpoint
 * Uses Cloudflare KV for distributed rate limiting
 *
 * @param {string} ip - Client IP address
 * @param {string} endpoint - Endpoint name (submit, bulkSubmit, index, status)
 * @param {object} env - Environment bindings
 * @returns {object} { allowed, limit, remaining, resetAt, retryAfter }
 */
async function checkRateLimit(ip, endpoint, env) {
    const config = RATE_LIMITS[endpoint];
    if (!config) {
        console.error(`Unknown rate limit endpoint: ${endpoint}`);
        return { allowed: true, limit: 0, remaining: 0, resetAt: 0 };
    }

    const { limit, windowSeconds } = config;
    const key = `rate:${endpoint}:${ip}`;
    const now = Date.now();

    // Check if KV is available
    if (!env.RATE_LIMIT) {
        console.warn('RATE_LIMIT KV namespace not configured, allowing request');
        return { allowed: true, limit, remaining: limit, resetAt: now + windowSeconds * 1000 };
    }

    try {
        const data = await env.RATE_LIMIT.get(key, { type: 'json' });

        if (!data) {
            // First request - create new rate limit entry
            const resetAt = now + windowSeconds * 1000;
            await env.RATE_LIMIT.put(
                key,
                JSON.stringify({ count: 1, resetAt }),
                { expirationTtl: windowSeconds }
            );
            return { allowed: true, limit, remaining: limit - 1, resetAt };
        }

        // Check if window has expired (shouldn't happen due to TTL, but be safe)
        if (now >= data.resetAt) {
            const resetAt = now + windowSeconds * 1000;
            await env.RATE_LIMIT.put(
                key,
                JSON.stringify({ count: 1, resetAt }),
                { expirationTtl: windowSeconds }
            );
            return { allowed: true, limit, remaining: limit - 1, resetAt };
        }

        // Check if limit exceeded
        if (data.count >= limit) {
            const retryAfter = Math.ceil((data.resetAt - now) / 1000);
            return {
                allowed: false,
                limit,
                remaining: 0,
                resetAt: data.resetAt,
                retryAfter
            };
        }

        // Increment counter
        const newCount = data.count + 1;
        const remainingTtl = Math.ceil((data.resetAt - now) / 1000);
        await env.RATE_LIMIT.put(
            key,
            JSON.stringify({ count: newCount, resetAt: data.resetAt }),
            { expirationTtl: remainingTtl > 0 ? remainingTtl : 1 }
        );

        return {
            allowed: true,
            limit,
            remaining: limit - newCount,
            resetAt: data.resetAt
        };

    } catch (error) {
        // Fail closed - deny requests when we can't verify rate limits
        // This prevents attackers from bypassing limits by causing KV errors
        console.error('Rate limit check error:', error);
        return {
            allowed: false,
            limit,
            remaining: 0,
            resetAt: now + windowSeconds * 1000,
            retryAfter: 60, // Ask client to retry in 60 seconds
            error: 'Rate limit service unavailable'
        };
    }
}

/**
 * Create a rate-limited error response with appropriate headers
 */
function rateLimitResponse(rateLimitResult) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-RateLimit-Limit': String(rateLimitResult.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(rateLimitResult.resetAt / 1000)),
        'Retry-After': String(rateLimitResult.retryAfter)
    };

    return new Response(
        JSON.stringify({
            error: `Rate limit exceeded. Try again in ${rateLimitResult.retryAfter} seconds.`
        }),
        { status: 429, headers }
    );
}

/**
 * Add rate limit headers to a response
 */
function addRateLimitHeaders(response, rateLimitResult) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-RateLimit-Limit', String(rateLimitResult.limit));
    newHeaders.set('X-RateLimit-Remaining', String(rateLimitResult.remaining));
    newHeaders.set('X-RateLimit-Reset', String(Math.floor(rateLimitResult.resetAt / 1000)));

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

/**
 * Check if repository exists on GitHub
 * Fail-closed: returns { exists: false, error: message } on any failure
 */
async function checkRepository(owner, repo, env) {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Git-Archiver-Worker/1.0'
        };

        // Use auth if available to avoid rate limits
        if (env?.GITHUB_TOKEN) {
            headers['Authorization'] = `token ${env.GITHUB_TOKEN}`;
        }

        const response = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}`, {
            headers
        });

        if (response.status === 404) {
            return { exists: false };
        }

        if (!response.ok) {
            return { exists: false, error: `GitHub API error: ${response.status}` };
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
        // Fail closed - do not allow archive requests when we can't verify the repo
        return { exists: false, error: `Failed to verify repository: ${error.message}` };
    }
}

/**
 * Check for existing open issue for this repository
 */
async function checkExistingRequest(owner, repo, env) {
    try {
        const response = await fetchWithRetry(
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
        // Fail closed - return a synthetic "existing" result to prevent duplicates
        // when we can't verify. Better to reject than create duplicates.
        return { number: 'unknown', title: 'Unable to verify - request blocked' };
    }
}

/**
 * Check if repository was already archived today
 */
async function checkTodayRelease(owner, repo, env) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const tag = `${owner}__${repo}__${today}`;

        const response = await fetchWithRetry(
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
        // Fail closed - assume already archived to prevent duplicates
        return { tag: 'unknown', url: 'Unable to verify - assumed already archived' };
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

    const response = await fetchWithRetry(
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
async function handleReadmeFetch(request, owner, repo, tag, env, logger) {
    try {
        // Rate limiting check at the start
        const clientIP = getClientIP(request);
        const rateLimitResult = await checkRateLimit(clientIP, 'readme', env);
        if (!rateLimitResult.allowed) {
            logger.warn('Rate limit exceeded', { clientIP, endpoint: 'readme' });
            return rateLimitResponse(rateLimitResult);
        }

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
                return addRateLimitHeaders(errorResponse(500, 'Failed to fetch releases'), rateLimitResult);
            }

            const releases = await releasesResponse.json();
            const repoPrefix = `${owner}__${repo}__`;
            const matchingReleases = releases.filter(r => r.tag_name.startsWith(repoPrefix));

            if (matchingReleases.length === 0) {
                return addRateLimitHeaders(errorResponse(404, 'No archived versions found for this repository'), rateLimitResult);
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
                return addRateLimitHeaders(errorResponse(404, 'Release not found'), rateLimitResult);
            }
            throw new Error(`Failed to fetch release: ${releaseResponse.status}`);
        }

        const release = await releaseResponse.json();

        // Find README asset
        const readmeAsset = release.assets?.find(a => a.name === 'README.md');
        if (!readmeAsset) {
            return addRateLimitHeaders(jsonResponse({ readme: null, message: 'No README available for this archive' }), rateLimitResult);
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
        logger.info('README fetched successfully', { owner, repo, tag: releaseTag });
        return addRateLimitHeaders(jsonResponse({ readme: readmeContent, tag: releaseTag }), rateLimitResult);

    } catch (error) {
        logger.error('README fetch error', { error: error.message });
        return errorResponse(500, 'Failed to fetch README');
    }
}

/**
 * Check if original repository is still online
 */
async function handleStatusCheck(request, owner, repo, env, logger) {
    // Rate limiting check at the start (outside try block so it's available in catch)
    const clientIP = getClientIP(request);
    const rateLimitResult = await checkRateLimit(clientIP, 'status', env);
    if (!rateLimitResult.allowed) {
        logger.warn('Rate limit exceeded', { clientIP, endpoint: 'status' });
        return rateLimitResponse(rateLimitResult);
    }

    try {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Git-Archiver-Worker/1.0'
        };

        // Use auth if available to avoid rate limits
        if (env?.GITHUB_TOKEN) {
            headers['Authorization'] = `token ${env.GITHUB_TOKEN}`;
        }

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers
        });

        if (response.status === 404) {
            logger.info('Repository status checked', { owner, repo, status: 'deleted' });
            return addRateLimitHeaders(
                jsonResponse({
                    online: false,
                    status: 'deleted',
                    message: 'Repository not found'
                }),
                rateLimitResult
            );
        }

        if (response.status === 451) {
            logger.info('Repository status checked', { owner, repo, status: 'dmca' });
            return addRateLimitHeaders(
                jsonResponse({
                    online: false,
                    status: 'dmca',
                    message: 'Repository unavailable due to DMCA'
                }),
                rateLimitResult
            );
        }

        if (!response.ok) {
            return addRateLimitHeaders(
                jsonResponse({
                    online: null,
                    status: 'unknown',
                    message: `Unable to check status: ${response.status}`
                }),
                rateLimitResult
            );
        }

        const data = await response.json();
        const status = data.archived ? 'archived' : 'active';
        logger.info('Repository status checked', { owner, repo, status });

        return addRateLimitHeaders(
            jsonResponse({
                online: true,
                status: status,
                private: data.private,
                archived: data.archived,
                message: data.archived ? 'Repository is archived on GitHub' : 'Repository is active'
            }),
            rateLimitResult
        );

    } catch (error) {
        logger.error('Status check error', { error: error.message });
        return addRateLimitHeaders(
            jsonResponse({
                online: null,
                status: 'error',
                message: 'Failed to check repository status'
            }),
            rateLimitResult
        );
    }
}

/**
 * Handle bulk submission of multiple repositories
 */
async function handleBulkSubmit(request, env, logger) {
    try {
        // Rate limiting check at the start
        const clientIP = getClientIP(request);
        const rateLimitResult = await checkRateLimit(clientIP, 'bulkSubmit', env);
        if (!rateLimitResult.allowed) {
            logger.warn('Rate limit exceeded', { clientIP, endpoint: 'bulkSubmit' });
            return rateLimitResponse(rateLimitResult);
        }

        const body = await request.json();
        const urls = body.urls;

        if (!Array.isArray(urls) || urls.length === 0) {
            return addRateLimitHeaders(errorResponse(400, 'Missing or empty urls array'), rateLimitResult);
        }

        // Limit bulk submissions
        if (urls.length > MAX_BULK_URLS) {
            return addRateLimitHeaders(
                errorResponse(400, `Maximum ${MAX_BULK_URLS} URLs per bulk submission`),
                rateLimitResult
            );
        }

        logger.info('Processing bulk submission', { urlCount: urls.length });
        const results = [];

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
                const repoCheck = await checkRepository(owner, repo, env);
                if (!repoCheck.exists) {
                    results.push({ url: repoUrl, success: false, error: 'Repository not found' });
                    continue;
                }

                if (repoCheck.private) {
                    results.push({ url: repoUrl, success: false, error: 'Cannot archive private repositories' });
                    continue;
                }

                // Check size limit
                if (repoCheck.size > MAX_REPO_SIZE_BYTES) {
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
        logger.info('Bulk submission completed', { successful, failed });

        return addRateLimitHeaders(
            jsonResponse({
                success: true,
                summary: {
                    total: urls.length,
                    successful,
                    failed
                },
                results
            }, successful > 0 ? 201 : 200),
            rateLimitResult
        );

    } catch (error) {
        logger.error('Bulk submit error', { error: error.message });
        return errorResponse(500, 'Internal server error');
    }
}
