# Git-Archiver-Web Improvement Plan

**Created**: 2026-02-02
**Status**: Draft
**Priority Levels**: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [P0: Critical Security Fixes](#2-p0-critical-security-fixes)
3. [P1: High Priority Stability Improvements](#3-p1-high-priority-stability-improvements)
4. [P2: Medium Priority Performance & UX](#4-p2-medium-priority-performance--ux)
5. [P3: Low Priority Polish](#5-p3-low-priority-polish)
6. [Implementation Schedule](#6-implementation-schedule)
7. [Testing Strategy](#7-testing-strategy)
8. [Rollback Plan](#8-rollback-plan)

---

## 1. Executive Summary

This plan addresses **23 identified issues** across the Git-Archiver-Web application, organized by priority and component. The improvements focus on:

- **Security**: Rate limiting, input validation, XSS prevention
- **Reliability**: Error handling, retry logic, data backup
- **Performance**: Caching, pagination, optimized queries
- **Maintainability**: Logging, testing, configuration management

### Impact Assessment

| Priority | Issues | Estimated Effort | Risk if Unaddressed |
|----------|--------|------------------|---------------------|
| P0 (Critical) | 3 | 4-6 hours | Service abuse, data loss |
| P1 (High) | 5 | 6-8 hours | Reliability issues |
| P2 (Medium) | 8 | 8-12 hours | Poor UX at scale |
| P3 (Low) | 7 | 6-10 hours | Technical debt |

---

## 2. P0: Critical Security Fixes

### 2.1 Implement Rate Limiting in Cloudflare Worker

**Issue**: The worker currently has no rate limiting. The `checkRateLimit()` function always returns `{ allowed: true }`.

**Risk**: Malicious actors could spam submissions, exhaust GitHub API limits, or create thousands of issues.

**Solution**: Implement IP-based rate limiting using Cloudflare KV storage.

#### Implementation Details

**File**: `worker/src/index.js`

**Step 1**: Create KV namespace in Cloudflare dashboard
```
Name: RATE_LIMIT
```

**Step 2**: Update `wrangler.toml`
```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "<your-kv-namespace-id>"
```

**Step 3**: Implement rate limiting logic

```javascript
// Rate limit configuration
const RATE_LIMITS = {
  submit: { requests: 10, window: 3600 },      // 10 submissions per hour
  bulkSubmit: { requests: 3, window: 3600 },   // 3 bulk submissions per hour
  index: { requests: 60, window: 60 },         // 60 index fetches per minute
  status: { requests: 30, window: 60 },        // 30 status checks per minute
};

/**
 * Check and update rate limit for a given IP and action
 * @param {string} ip - Client IP address
 * @param {string} action - Action type (submit, bulkSubmit, index, status)
 * @param {KVNamespace} kv - Cloudflare KV namespace
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
async function checkRateLimit(ip, action, kv) {
  const limit = RATE_LIMITS[action];
  if (!limit || !kv) {
    return { allowed: true, remaining: Infinity, resetAt: 0 };
  }

  const key = `ratelimit:${action}:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  // Get current rate limit data
  const data = await kv.get(key, 'json');

  if (!data || data.resetAt <= now) {
    // Create new window
    const newData = {
      count: 1,
      resetAt: now + limit.window
    };
    await kv.put(key, JSON.stringify(newData), {
      expirationTtl: limit.window + 60 // Add buffer for clock skew
    });
    return {
      allowed: true,
      remaining: limit.requests - 1,
      resetAt: newData.resetAt
    };
  }

  if (data.count >= limit.requests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: data.resetAt
    };
  }

  // Increment counter
  const updatedData = {
    count: data.count + 1,
    resetAt: data.resetAt
  };
  await kv.put(key, JSON.stringify(updatedData), {
    expirationTtl: data.resetAt - now + 60
  });

  return {
    allowed: true,
    remaining: limit.requests - updatedData.count,
    resetAt: data.resetAt
  };
}

/**
 * Get client IP from request headers
 * @param {Request} request
 * @returns {string}
 */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}
```

**Step 4**: Update request handlers to use rate limiting

```javascript
async function handleSubmit(request, env) {
  const ip = getClientIP(request);

  // Check rate limit
  const rateLimit = await checkRateLimit(ip, 'submit', env.RATE_LIMIT);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({
      error: 'Rate limit exceeded',
      message: 'Too many submissions. Try again later.',
      retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(rateLimit.resetAt),
        'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)),
        ...corsHeaders
      }
    });
  }

  // ... rest of submit logic

  // Include rate limit headers in success response
  return new Response(JSON.stringify(result), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': String(rateLimit.remaining),
      'X-RateLimit-Reset': String(rateLimit.resetAt),
      ...corsHeaders
    }
  });
}
```

**Step 5**: Update frontend to display rate limit information

```javascript
// In frontend/js/api.js - update submitRepo function
async submitRepo(url) {
  const response = await fetch(`${this.workerUrl}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });

  // Extract rate limit headers
  const rateLimitInfo = {
    limit: response.headers.get('X-RateLimit-Limit'),
    remaining: response.headers.get('X-RateLimit-Remaining'),
    resetAt: response.headers.get('X-RateLimit-Reset')
  };

  if (response.status === 429) {
    const data = await response.json();
    throw new Error(`Rate limit exceeded. ${data.message}`);
  }

  return {
    data: await response.json(),
    rateLimit: rateLimitInfo
  };
}
```

**Testing**:
1. Submit 11 repos in quick succession - 11th should be rejected
2. Verify rate limit headers in response
3. Verify rate limit resets after window expires
4. Test with different IPs (use VPN or Cloudflare Workers preview)

---

### 2.2 Add Index Backup Before Updates

**Issue**: If the index update fails mid-write or corrupts the JSON, there's no way to recover previous state.

**Risk**: Complete loss of archive index, requiring manual reconstruction.

**Solution**: Create versioned backups of index.json before each update.

#### Implementation Details

**File**: `.github/workflows/archive.yml`

**Step 1**: Add backup step before index update

```yaml
      - name: Backup existing index
        if: steps.validate.outputs.valid == 'true' && steps.check_changes.outputs.has_changes == 'true'
        id: backup
        run: |
          INDEX_URL="https://github.com/${{ github.repository }}/releases/download/index/index.json"

          # Download existing index
          if curl -sL -o index_backup.json "$INDEX_URL" && [ -s index_backup.json ] && jq -e '.' index_backup.json >/dev/null 2>&1; then
            # Create backup with timestamp
            BACKUP_TAG="index-backup-$(date +%Y%m%d-%H%M%S)"
            echo "Creating backup: $BACKUP_TAG"
            echo "backup_tag=$BACKUP_TAG" >> $GITHUB_OUTPUT
            echo "has_backup=true" >> $GITHUB_OUTPUT

            # Store backup info in the file
            jq --arg tag "$BACKUP_TAG" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
              '. + {backup_tag: $tag, backup_time: $time}' index_backup.json > index_backup_meta.json
            mv index_backup_meta.json index_backup.json
          else
            echo "No existing index to backup"
            echo "has_backup=false" >> $GITHUB_OUTPUT
          fi

      - name: Upload index backup
        if: steps.backup.outputs.has_backup == 'true'
        uses: softprops/action-gh-release@v1
        with:
          tag_name: ${{ steps.backup.outputs.backup_tag }}
          name: "Index Backup - ${{ steps.backup.outputs.backup_tag }}"
          body: |
            Automatic backup of index.json before update.
            Trigger: Archive of ${{ steps.parse.outputs.owner }}/${{ steps.parse.outputs.repo }}
            To restore: Download index.json and upload to the index release.
          files: index_backup.json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Step 2**: Add cleanup job to remove old backups (keep last 10)

```yaml
      - name: Cleanup old backups
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # List all backup releases, sorted by date (oldest first)
          BACKUP_RELEASES=$(gh release list --limit 100 | grep "index-backup-" | tail -n +11 | awk '{print $3}')

          for TAG in $BACKUP_RELEASES; do
            echo "Deleting old backup: $TAG"
            gh release delete "$TAG" -y --cleanup-tag || true
          done
```

**Step 3**: Add recovery script

**File**: `scripts/restore-index.sh`

```bash
#!/bin/bash
# Restore index.json from a backup release

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <backup-tag>"
    echo ""
    echo "Available backups:"
    gh release list --limit 20 | grep "index-backup-"
    exit 1
fi

BACKUP_TAG="$1"

echo "Downloading backup from release: $BACKUP_TAG"
gh release download "$BACKUP_TAG" -p "index_backup.json" -O index_restored.json

if [ ! -s index_restored.json ]; then
    echo "Error: Failed to download backup"
    exit 1
fi

echo "Validating JSON..."
if ! jq -e '.' index_restored.json >/dev/null 2>&1; then
    echo "Error: Backup file is not valid JSON"
    exit 1
fi

echo ""
echo "Backup contents:"
echo "- Total repos: $(jq '.total_repos' index_restored.json)"
echo "- Total size: $(jq '.total_size_mb' index_restored.json) MB"
echo "- Last updated: $(jq -r '.last_updated' index_restored.json)"
echo ""

read -p "Restore this backup to the index release? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Remove backup metadata before restoring
    jq 'del(.backup_tag, .backup_time)' index_restored.json > index.json

    echo "Uploading to index release..."
    gh release upload index index.json --clobber

    echo "Index restored successfully!"
    rm index_restored.json index.json
else
    echo "Restore cancelled"
    rm index_restored.json
fi
```

**Testing**:
1. Trigger an archive and verify backup release is created
2. Verify backup contains valid JSON with correct repo count
3. Test restore script with a backup
4. Verify old backups are cleaned up (keep only 10)

---

### 2.3 Fix Potential XSS in Markdown Renderer

**Issue**: The custom markdown renderer uses regex replacements that could potentially be bypassed with crafted input.

**Risk**: XSS attacks via malicious README content in archived repositories.

**Solution**: Replace custom renderer with battle-tested markdown library (marked.js) plus DOMPurify for sanitization.

#### Implementation Details

**Step 1**: Add marked.js and DOMPurify to frontend

**File**: `frontend/index.html` - add before app.js

```html
<!-- Markdown rendering with XSS protection -->
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.8/dist/purify.min.js"></script>
```

**Step 2**: Update markdown renderer

**File**: `frontend/js/utils.js` - replace renderMarkdown function

```javascript
/**
 * Render markdown to safe HTML using marked.js + DOMPurify
 * @param {string} markdown - Raw markdown content
 * @returns {string} - Sanitized HTML
 */
function renderMarkdown(markdown) {
  if (!markdown) return '';

  // Configure marked with security options
  marked.setOptions({
    gfm: true,           // GitHub Flavored Markdown
    breaks: true,        // Convert \n to <br>
    headerIds: false,    // Don't generate IDs (prevents DOM clobbering)
    mangle: false,       // Don't mangle email addresses
  });

  // Custom renderer for links (open in new tab)
  const renderer = new marked.Renderer();
  const originalLinkRenderer = renderer.link.bind(renderer);

  renderer.link = function(href, title, text) {
    // Validate URL protocol - only allow safe protocols
    const allowedProtocols = ['http:', 'https:', 'mailto:'];
    try {
      const url = new URL(href, window.location.origin);
      if (!allowedProtocols.includes(url.protocol)) {
        return text; // Strip dangerous links, just show text
      }
    } catch {
      return text; // Invalid URL
    }

    const html = originalLinkRenderer(href, title, text);
    // Add target and rel attributes for security
    return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  };

  marked.setOptions({ renderer });

  try {
    const rawHtml = marked.parse(markdown);

    // Sanitize with DOMPurify for defense in depth
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'hr',
        'ul', 'ol', 'li',
        'a', 'img',
        'code', 'pre', 'blockquote',
        'strong', 'em', 'del',
        'table', 'thead', 'tbody', 'tr', 'th', 'td'
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel', 'loading'],
      ALLOW_DATA_ATTR: false,
    });
  } catch (error) {
    console.error('Markdown parsing error:', error);
    // Safe fallback - escape and wrap in pre
    return '<pre>' + escapeHtml(markdown) + '</pre>';
  }
}
```

**Testing**:
1. Test with normal markdown (headers, lists, code blocks, links, images)
2. Test XSS payloads:
   - `<script>alert('xss')</script>`
   - `[link](javascript:alert('xss'))`
   - `![img](data:text/html,<script>alert('xss')</script>)`
   - `<img src=x onerror=alert('xss')>`
3. Verify links open in new tab with noopener
4. Test with real README files from popular repos

---

## 3. P1: High Priority Stability Improvements

### 3.1 Add Retry Logic for GitHub API Calls

**Issue**: GitHub API calls can fail due to rate limits (429) or transient errors (5xx), causing workflow failures.

**Solution**: Implement exponential backoff retry logic in both workflows and worker.

#### Implementation Details

**File**: `.github/workflows/archive.yml`

Add a retry helper and use it for all API calls:

```yaml
      - name: Setup retry function
        run: |
          # Create retry helper script
          cat > /tmp/retry.sh << 'RETRY_SCRIPT'
          #!/bin/bash
          # Retry a command with exponential backoff
          # Usage: retry.sh <max_attempts> <command...>

          MAX_ATTEMPTS=$1
          shift
          COMMAND="$@"

          ATTEMPT=1
          DELAY=5

          while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
            echo "Attempt $ATTEMPT of $MAX_ATTEMPTS"

            if OUTPUT=$(eval "$COMMAND" 2>&1); then
              echo "$OUTPUT"
              exit 0
            fi

            if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
              echo "Waiting ${DELAY}s before retry..."
              sleep $DELAY
              DELAY=$((DELAY * 2))
              [ $DELAY -gt 300 ] && DELAY=300  # Cap at 5 minutes
            fi

            ATTEMPT=$((ATTEMPT + 1))
          done

          echo "All $MAX_ATTEMPTS attempts failed"
          exit 1
          RETRY_SCRIPT

          chmod +x /tmp/retry.sh
```

**File**: `worker/src/index.js`

```javascript
/**
 * Fetch with retry and exponential backoff
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
        throw new Error('Rate limited');
      }

      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  throw lastError;
}
```

---

### 3.2 Improve Error Handling with "Fail Closed" Pattern

**Issue**: Several error handlers return success-like responses on failure.

**Solution**: Errors should fail explicitly, not assume success.

```javascript
// BEFORE (dangerous)
async function checkRepository(owner, repo, env) {
  try {
    // ... API call
  } catch (error) {
    return { exists: true }; // WRONG: assumes success on error
  }
}

// AFTER (safe)
async function checkRepository(owner, repo, env) {
  try {
    // ... API call with retry
  } catch (error) {
    return {
      exists: false,
      error: `Failed to verify repository: ${error.message}`
    };
  }
}
```

---

### 3.3 Add Comprehensive Logging

**Issue**: No logging beyond console.error() makes debugging difficult.

**Solution**: Implement structured logging with request IDs.

```javascript
class Logger {
  constructor(requestId) {
    this.requestId = requestId;
    this.startTime = Date.now();
  }

  log(level, message, data = {}) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      level,
      message,
      durationMs: Date.now() - this.startTime,
      ...data
    }));
  }

  info(msg, data) { this.log('info', msg, data); }
  error(msg, data) { this.log('error', msg, data); }
}
```

---

### 3.4 Add Workflow Timeout Handling

**Issue**: Large repositories can timeout during clone or compress steps.

**Solution**: Add explicit timeouts and cleanup on failure.

```yaml
jobs:
  archive:
    runs-on: ubuntu-latest
    timeout-minutes: 30  # Overall job timeout

    steps:
      - name: Clone repository
        timeout-minutes: 10
        run: |
          timeout 540 git clone --depth 100 "$URL" repo || {
            echo "Clone timed out"
            exit 1
          }

      - name: Cleanup on failure
        if: failure()
        run: |
          rm -rf repo *.tar.gz index.json
```

---

### 3.5 Validate Index JSON Schema

**Issue**: Index updates could introduce malformed data.

**Solution**: Add schema validation before uploading index.

```yaml
      - name: Validate index before upload
        run: |
          # Check required fields exist
          jq -e '.repositories and .total_repos and .total_size_mb' index.json || exit 1

          # Check total_repos matches actual count
          ACTUAL=$(jq '.repositories | length' index.json)
          STATED=$(jq '.total_repos' index.json)
          [ "$ACTUAL" = "$STATED" ] || {
            echo "Count mismatch: $ACTUAL vs $STATED"
            jq --argjson count "$ACTUAL" '.total_repos = $count' index.json > fixed.json
            mv fixed.json index.json
          }
```

---

## 4. P2: Medium Priority Performance & UX

### 4.1 Implement Frontend Pagination

**Issue**: Loading all repos at once becomes slow with thousands of entries.

**Solution**: Add infinite scroll pagination.

```javascript
const App = {
  state: {
    currentPage: 1,
    pageSize: 50,
    hasMore: true
  },

  getPaginatedRepos() {
    const end = this.state.currentPage * this.state.pageSize;
    const filtered = this.filterRepos();
    this.state.hasMore = end < filtered.length;
    return filtered.slice(0, end);
  },

  loadMore() {
    if (!this.state.hasMore) return;
    this.state.currentPage++;
    this.renderRepos();
  },

  setupInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) this.loadMore();
    });
    observer.observe(document.getElementById('load-more-sentinel'));
  }
};
```

---

### 4.2 Add Response Caching in Worker

**Issue**: Every request fetches fresh data from GitHub.

**Solution**: Cache responses with appropriate TTLs.

```javascript
const CACHE_TTL = {
  index: 300,    // 5 minutes
  status: 60,    // 1 minute
  readme: 3600,  // 1 hour
};

async function cachedFetch(cacheKey, fetchFn, ttl, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL(`https://cache/${cacheKey}`);

  let response = await cache.match(cacheUrl);
  if (response) return response;

  response = await fetchFn();
  ctx.waitUntil(cache.put(cacheUrl, response.clone()));
  return response;
}
```

---

### 4.3 Add Toast Notifications

**Issue**: Success/error messages auto-hide and can be missed.

**Solution**: Implement persistent toast notifications.

```javascript
const Toast = {
  show(message, type = 'info', duration = 5000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toast.remove();
    toast.appendChild(closeBtn);

    document.getElementById('toast-container').appendChild(toast);

    if (duration > 0) {
      setTimeout(() => toast.remove(), duration);
    }
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 0); }, // Errors persist
};
```

---

### 4.4-4.8 Additional Medium Priority Items

- **4.4** Search result highlighting with `<mark>` tags
- **4.5** Service Worker for offline support
- **4.6** Statistics dashboard (total archives, trends)
- **4.7** Improved modal UX (keyboard nav, prevent accidental close)
- **4.8** Bulk operation progress indicator

---

## 5. P3: Low Priority Polish

### 5.1-5.7 Low Priority Items

- **5.1** Dynamic configuration (auto-detect worker URL)
- **5.2** Unit tests for utility functions
- **5.3** Integration tests with Miniflare
- **5.4** E2E tests with Playwright
- **5.5** Full-text search with Algolia
- **5.6** Standardize naming conventions
- **5.7** Analytics integration

---

## 6. Implementation Schedule

### Phase 1: Critical Security (Week 1)
- [ ] 2.1 Rate limiting
- [ ] 2.2 Index backup
- [ ] 2.3 XSS fix

### Phase 2: Stability (Week 2)
- [ ] 3.1 Retry logic
- [ ] 3.2 Fail closed pattern
- [ ] 3.3 Logging
- [ ] 3.4 Timeout handling
- [ ] 3.5 Schema validation

### Phase 3: Performance (Week 3)
- [ ] 4.1 Pagination
- [ ] 4.2 Response caching
- [ ] 4.3 Toast notifications

### Phase 4: Polish (Week 4+)
- [ ] Remaining P2 items
- [ ] P3 items as time permits

---

## 7. Testing Strategy

### Unit Tests
- Utility functions (URL parsing, formatting)
- Validation logic
- Rate limit calculations

### Integration Tests
- Worker endpoints (Miniflare)
- Workflow steps (act)
- Index operations

### E2E Tests
- Full submission flow
- Search and browse
- Error scenarios

### Security Tests
- XSS payload testing
- Rate limit bypass attempts
- Input fuzzing

---

## 8. Rollback Plan

### Worker Changes
1. Keep previous version in comments
2. Use `wrangler rollback` for quick revert
3. Monitor error rates after deploy

### Workflow Changes
1. Test in separate branch first
2. Use workflow_dispatch for manual testing
3. Keep backup of previous files

### Index Changes
1. Always create backup before update
2. Maintain restore script
3. Test restore process regularly

---

## File Change Summary

| File | Changes |
|------|---------|
| `worker/src/index.js` | Rate limiting, retry logic, logging, caching |
| `worker/wrangler.toml` | KV namespace binding |
| `.github/workflows/archive.yml` | Backup, timeout, retry, validation |
| `.github/workflows/update-archives.yml` | Error handling, logging |
| `frontend/index.html` | marked.js, DOMPurify CDN links |
| `frontend/js/app.js` | Pagination, toast integration |
| `frontend/js/api.js` | Rate limit headers, validation |
| `frontend/js/utils.js` | Toast system, secure markdown |
| `frontend/css/styles.css` | Toast styles, pagination styles |
| `scripts/restore-index.sh` | New: Index restoration script |

---

*End of Improvement Plan*
