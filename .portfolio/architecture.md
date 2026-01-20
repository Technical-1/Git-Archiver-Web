# Architecture

## System Overview

Git-Archiver Web is a serverless GitHub repository archiving service that I designed to run entirely on free-tier cloud services. The architecture prioritizes zero operational cost while maintaining reliability and scalability.

```mermaid
flowchart TB
    subgraph User["User Interface"]
        FE[Static Frontend<br/>GitHub Pages]
    end

    subgraph Submission["Submission Layer"]
        CW[Cloudflare Worker<br/>API Proxy]
    end

    subgraph Processing["Processing Layer"]
        GI[GitHub Issues<br/>Request Queue]
        GA[GitHub Actions<br/>Archive Engine]
    end

    subgraph Storage["Storage Layer"]
        GR[GitHub Releases<br/>Archive Storage]
        IDX[index.json<br/>Master Index]
    end

    subgraph External["External"]
        GHAPI[GitHub API]
        REPO[Target Repository]
    end

    FE -->|POST /submit| CW
    FE -->|GET /index| CW
    CW -->|Create Issue| GI
    CW -->|Fetch Index| IDX
    GI -->|Trigger on label| GA
    GA -->|Clone| REPO
    GA -->|Validate| GHAPI
    GA -->|Upload Archive| GR
    GA -->|Update| IDX
    GA -->|Close| GI
    FE -->|Fetch Releases| GHAPI
```

## Component Architecture

### Frontend Layer

```mermaid
flowchart LR
    subgraph Frontend["Static Frontend"]
        HTML[index.html]
        CSS[styles.css]
        APP[app.js<br/>Main Logic]
        API[api.js<br/>API Client]
        UTIL[utils.js<br/>Helpers]
    end

    APP --> API
    APP --> UTIL
    HTML --> CSS
    HTML --> APP
```

The frontend is a single-page application built with vanilla JavaScript. I deliberately avoided frameworks to minimize bundle size and eliminate build steps. The entire frontend consists of:

- **index.html**: Semantic markup with accessibility considerations
- **styles.css**: Custom CSS with dark theme and responsive design
- **app.js**: Application state management and UI rendering
- **api.js**: API client abstracting all backend communication
- **utils.js**: Pure utility functions for formatting, validation, and DOM manipulation

### Worker Layer (Cloudflare)

```mermaid
flowchart TB
    subgraph Worker["Cloudflare Worker"]
        CORS[CORS Handler]
        ROUTE[Router]

        subgraph Endpoints
            SUBMIT[POST /submit]
            BULK[POST /bulk-submit]
            INDEX[GET /index]
            README[GET /readme]
            STATUS[GET /status]
        end

        subgraph Validation
            URL[URL Validator]
            RATE[Rate Limiter]
            SIZE[Size Checker]
            DUP[Duplicate Checker]
        end
    end

    CORS --> ROUTE
    ROUTE --> Endpoints
    SUBMIT --> Validation
    BULK --> Validation
```

The Cloudflare Worker serves as a secure proxy between the frontend and GitHub API. Key responsibilities:

1. **Token Protection**: GitHub PAT never exposed to client
2. **Request Validation**: URL format, size limits, duplicate checking
3. **Rate Limiting**: IP-based throttling (configurable via KV)
4. **CORS Handling**: Enables cross-origin requests from GitHub Pages
5. **Index Proxying**: Avoids CORS issues with GitHub release asset redirects

### Processing Layer (GitHub Actions)

```mermaid
flowchart TB
    subgraph Archive["archive.yml Workflow"]
        TRIGGER[Issue Trigger]
        PARSE[Parse URL]
        VALIDATE[Validate Repo]
        CLONE[Clone Repository]
        COMPRESS[Create tar.gz]
        HASH[Calculate SHA256]
        CHECK[Check for Changes]
        RELEASE[Create Release]
        UPDATE[Update Index]
        CLOSE[Close Issue]
    end

    TRIGGER --> PARSE
    PARSE --> VALIDATE
    VALIDATE -->|Valid| CLONE
    VALIDATE -->|Invalid| CLOSE
    CLONE --> COMPRESS
    COMPRESS --> HASH
    HASH --> CHECK
    CHECK -->|Changed| RELEASE
    CHECK -->|Unchanged| CLOSE
    RELEASE --> UPDATE
    UPDATE --> CLOSE
```

I chose GitHub Actions as the archive engine because:

1. **Free compute**: Unlimited minutes for public repositories
2. **Native integration**: Direct access to GitHub API with built-in tokens
3. **Event-driven**: Triggers on issue creation without polling
4. **Reliable**: Managed infrastructure with automatic retries

### Storage Layer

```mermaid
flowchart TB
    subgraph Releases["GitHub Releases"]
        IDX_REL[index Release<br/>tag: index]
        REPO_REL[Archive Releases<br/>tag: owner__repo__date]
    end

    subgraph Assets
        IDX_JSON[index.json<br/>Master Index]
        ARCHIVE[repo.tar.gz<br/>Archive File]
        META[metadata.json<br/>Repo Metadata]
        README[README.md<br/>Extracted README]
    end

    IDX_REL --> IDX_JSON
    REPO_REL --> ARCHIVE
    REPO_REL --> META
    REPO_REL --> README
```

## Key Architecture Decisions

### Why Serverless?

I chose a serverless architecture for several reasons:

1. **Zero maintenance**: No servers to patch, scale, or monitor
2. **Cost efficiency**: All services operate within free tiers
3. **Global distribution**: Cloudflare and GitHub CDN provide edge caching
4. **Automatic scaling**: Handles traffic spikes without configuration

### Why GitHub Issues as Queue?

Using GitHub Issues as a job queue was an unconventional but effective choice:

1. **Visibility**: Users can track their request status
2. **Auditability**: Complete history of all archive requests
3. **Native triggering**: GitHub Actions can trigger on issue events
4. **No additional services**: Eliminates need for Redis, SQS, etc.

### Why GitHub Releases for Storage?

1. **Unlimited storage**: No stated limits for public repos
2. **CDN-backed**: Fast downloads globally
3. **Versioning**: Natural support for multiple archive versions
4. **API accessible**: Easy programmatic access to assets

### Deduplication Strategy

I implemented content-based deduplication using SHA256 hashes:

1. Each archive's hash is stored in metadata.json
2. Before creating a new release, the workflow compares hashes
3. If unchanged, no new release is created (saves storage)
4. Daily update job re-archives repos only when content changes

### Security Considerations

1. **Token isolation**: GitHub PAT stored in Cloudflare secrets, never in frontend
2. **Input sanitization**: Strict URL regex validation
3. **XSS prevention**: All user input escaped before rendering
4. **Rate limiting**: Prevents abuse of submission endpoint
5. **Size limits**: 2GB cap prevents storage abuse

## Data Flow

### Submission Flow

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant W as Worker
    participant G as GitHub API
    participant I as GitHub Issue

    U->>F: Enter repo URL
    F->>W: POST /submit
    W->>G: Validate repo exists
    G-->>W: Repo metadata
    W->>W: Check size < 2GB
    W->>G: Check existing issues
    W->>G: Check today's release
    W->>G: Create issue with label
    G-->>W: Issue created
    W-->>F: Success response
    F-->>U: "Queued for archiving"
```

### Archive Flow

```mermaid
sequenceDiagram
    participant I as GitHub Issue
    participant A as GitHub Action
    participant R as Target Repo
    participant S as GitHub Releases

    I->>A: Issue opened with label
    A->>A: Parse URL from body
    A->>R: Validate repo (API)
    A->>R: Clone (depth 100)
    A->>A: Create tar.gz
    A->>A: Calculate SHA256
    A->>S: Check previous hash
    alt Content changed
        A->>S: Upload archive + metadata
        A->>S: Update index.json
    end
    A->>I: Comment result
    A->>I: Close issue
```

## Limitations

1. **Repository size**: 2GB maximum (GitHub release asset limit)
2. **Clone depth**: Limited to 100 commits for speed
3. **Private repos**: Not supported (intentional)
4. **Rate limits**: 10 requests/hour per IP (configurable)
5. **GitHub dependency**: Entire system relies on GitHub availability
