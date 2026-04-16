# AI-Assisted Editing

**Document Version:** 3.0  
**Last Updated:** 2026-04-16  
**Status:** DRAFT — Phase 1-3 in implementation  
**Audience:** Backend developers, frontend developers, product team

---

## Architecture: Two AI Surfaces, One Backend

The platform provides AI editing through two distinct user experiences that share a common LLM backend:

| Surface | Who | Where | Shows code? | Scope |
|---|---|---|---|---|
| **AI Code Assistant** | Admins, technical clients | Integrated into File Manager | Yes — diffs, raw files | Single file or folder |
| **AI Website Editor** | Non-technical end users | Dedicated editor page | No — plain English + live preview | Pages and site-wide |

```
                    ┌─────────────────────┐
   File Manager     │                     │     Website Editor
   (code view)      │   AI Edit Service   │     (no-code view)
        │           │                     │          │
        │           │  • Provider layer   │          │
  POST /ai/edit     │  • Token budget     │   POST /ai/edit
  mode: "file"      │  • Output scanner   │   mode: "website"
  or "folder"       │  • Staging buffer   │   scope: page
  context: raw code │  • Audit logging    │   context: page name
        │           │                     │          │
        └───────────┴─────────────────────┘──────────┘
```

---

## Surface 1: AI Code Assistant (File Manager)

### Mode A — Single File (file open in editor)

The editor shows a Monaco diff view: original on the left, AI-proposed changes on the right.

- Chat input below the editor
- LLM receives the single file's content as context
- Response replaces the right pane of the diff view
- User reviews diff → **Accept** (overwrites file) or **Reject** (discards)
- No output scanner — admin/technical user is trusted with raw code

### Mode B — Folder Context (no file open)

When no file is open, the AI has access to all files in the current folder.

- User types an instruction (e.g., "Add dark mode to all pages")
- Backend runs a **two-step agentic loop**:
  1. **Plan step**: LLM sees file listing → requests files it needs → proposes a change plan
  2. **Execute step**: LLM generates modified files one at a time
- Modal shows all proposed changes with per-file diffs
- **Apply All** writes changes; **Cancel** discards

### Agentic Loop Detail

```
Step 1 (plan — cheap):
  Input: file listing of current folder + user instruction
  Output: { filesToRead: ["style.css", "index.php"], plan: "..." }

Step 2 (per file — sequential):
  Input: file content + plan excerpt
  Output: modified file content
  Repeat for each file in the plan
```

---

## Surface 2: AI Website Editor (Client Panel — Phase 4+)

**Status:** Design complete, implementation deferred to post-Phase 3.

Non-technical users see pages, not files. They describe what they want in plain language; the AI updates the site; a live preview shows changes immediately.

- Page sidebar with friendly names (Home, About, Contact)
- Live preview iframe (renders via backend proxy — supports PHP)
- Chat responses in plain English (no code shown)
- Changes accumulate in `.ai_staging/`; Publish pushes to live
- May require its own sidecar for preview serving (TBD)

See the sections below for detailed Website Editor specification (preserved from v2.0).

---

## LLM Provider System

### Supported Providers (all from day 1)

| Provider | Type | SDK/Protocol |
|---|---|---|
| **Anthropic** | Native API | `@anthropic-ai/sdk` — Claude models |
| **OpenAI** | Native API | `openai` SDK — GPT models |
| **OpenAI-Compatible** | Custom endpoint | `openai` SDK with `baseURL` — Ollama, Groq, Together, Mistral, LM Studio, etc. |

### Provider Configuration

Each provider entry:

```json
{
  "id": "anthropic_main",
  "type": "anthropic",
  "displayName": "Anthropic Claude",
  "baseUrl": null,
  "apiKeySet": true,
  "enabled": true
}
```

API keys stored as encrypted values in the database (not Kubernetes Secrets — simpler for CRUD operations). Never returned to any panel.

### Model Configuration

Each model entry:

```json
{
  "id": "claude-sonnet",
  "providerId": "anthropic_main",
  "modelName": "claude-sonnet-4-5",
  "displayName": "Claude Sonnet 4.5",
  "costPer1mInput": 3.00,
  "costPer1mOutput": 15.00,
  "maxOutputTokens": 8192,
  "enabled": true
}
```

### Admin Panel → Settings → AI

**Providers tab:** Add/edit/delete providers, set API keys, test connection
**Models tab:** Add/edit/delete models per provider, set costs, enable/disable

---

## Unified API: `POST /api/v1/ai/edit`

```typescript
interface AiEditRequest {
  mode: 'file' | 'folder' | 'website';
  deploymentId: string;

  // mode: 'file' — single file edit
  filePath?: string;
  fileContent?: string;

  // mode: 'folder' — multi-file edit
  folderPath?: string;

  // mode: 'website' — page edit (Phase 4+)
  pageName?: string;

  instruction: string;
  modelId?: string;        // admin can override; clients use plan default
}

interface AiEditResponse {
  changes: Array<{
    path: string;
    action: 'create' | 'modify' | 'delete';
    diff?: string;
    originalContent?: string;
    modifiedContent?: string;
    summary?: string;
  }>;
  tokensUsed: { input: number; output: number };
  budgetRemaining?: number;
  planSummary?: string;     // folder mode: the plan before execution
}
```

---

## Output Scanner (Customer Mode Only)

Admin mode bypasses the scanner. Customer mode enforces:

| Check | Action |
|---|---|
| File size > 150KB | Reject |
| Contains `<?php` or `<?=` | Strip (except allowlisted contact form) |
| `<script src>` not on allowlist | Strip |
| `<iframe>` | Strip |
| `eval(` / `Function(` | Strip |
| `fetch(` to non-allowlist URL | Strip |
| Response starts with `REFUSED:` | Return refusal message |

---

## Token Budget & Usage Limits

| Control | Starter | Business | Premium | Admin |
|---|---|---|---|---|
| Monthly token budget | 50k | 200k | 500k | Unlimited |
| Requests/minute | 5 | 15 | 30 | 60 |
| Max files per folder edit | 5 | 15 | 30 | Unlimited |
| Output scanner | On | On | On | Off |
| Max output tokens/request | 4096 | 8192 | 8192 | 16384 |

---

## Database Schema

### `ai_providers`

```sql
CREATE TABLE IF NOT EXISTS ai_providers (
  id              VARCHAR(100) PRIMARY KEY,
  type            VARCHAR(30) NOT NULL,
  display_name    VARCHAR(200) NOT NULL,
  base_url        VARCHAR(500),
  api_key_enc     TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### `ai_models`

```sql
CREATE TABLE IF NOT EXISTS ai_models (
  id                        VARCHAR(100) PRIMARY KEY,
  provider_id               VARCHAR(100) NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_name                VARCHAR(200) NOT NULL,
  display_name              VARCHAR(200) NOT NULL,
  cost_per_1m_input_tokens  NUMERIC(10,4) DEFAULT 0,
  cost_per_1m_output_tokens NUMERIC(10,4) DEFAULT 0,
  max_output_tokens         INTEGER NOT NULL DEFAULT 4096,
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### `ai_token_usage`

```sql
CREATE TABLE IF NOT EXISTS ai_token_usage (
  id              VARCHAR(36) PRIMARY KEY,
  client_id       VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deployment_id   VARCHAR(36) REFERENCES deployments(id) ON DELETE SET NULL,
  model_id        VARCHAR(100) NOT NULL REFERENCES ai_models(id),
  mode            VARCHAR(20) NOT NULL,
  tokens_input    INTEGER NOT NULL,
  tokens_output   INTEGER NOT NULL,
  instruction     TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_token_usage_client_idx ON ai_token_usage(client_id, created_at);
```

---

## Implementation Phases

### Phase 1 — LLM Backend (current)
- [x] Database schema migration
- [x] API contracts (Zod schemas)
- [x] Provider abstraction (Anthropic, OpenAI, OpenAI-compatible)
- [x] `POST /ai/edit` (file mode)
- [x] Token budget tracking
- [x] Output scanner
- [x] Admin provider/model CRUD endpoints

### Phase 2 — File Manager AI (single file)
- [x] Chat panel in file editor
- [x] Monaco diff mode (original vs AI-proposed)
- [x] Accept / Reject flow

### Phase 3 — Folder Mode
- [x] Two-step agentic loop (plan → execute)
- [x] Change plan modal with per-file diffs
- [x] Apply All / Cancel

### Phase 4 — Website Editor (future)
- [ ] Dedicated editor page with page sidebar + live preview
- [ ] Plain-English chat (no code)
- [ ] Staging buffer + Publish flow
- [ ] Setup wizard
- [ ] Preview sidecar (TBD)

### Phase 5 — Admin Settings & Polish (future)
- [ ] Plan Defaults tab
- [ ] Usage dashboard
- [ ] Cost tracking
- [ ] Budget top-up UI

---

## Related Documents

- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md)
- [`../01-core/HOSTING_PLANS.md`](../01-core/HOSTING_PLANS.md)
- [`../07-reference/COMPETITIVE_ANALYSIS.md`](../07-reference/COMPETITIVE_ANALYSIS.md)
