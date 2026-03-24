# AI Website Editor

**Document Version:** 2.0  
**Last Updated:** 2026-03-07  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, frontend developers, product team

---

## Overview

The AI Website Editor allows customers to create and edit static websites through a plain-language chat interface and guided setup wizard — **no code, no filenames, no HTML**. The customer describes what they want; the AI updates the site; a live preview reflects changes immediately.

The editor is a dedicated section of the Client Panel, separate from FileBrowser. Customers who prefer direct file access continue to use FileBrowser and SFTP as normal. The AI editor is an additional, non-technical path.

Admins can also open the AI editor for any customer's domain directly from the Admin Panel, using any configured AI model, with no content or code restrictions.

---

## User Modes

The editor operates in two distinct modes depending on who is using it:

| Mode | Who | Model | Restrictions | Token Budget |
|---|---|---|---|---|
| **Customer mode** | Customer via Client Panel | Plan-assigned model (overridable per customer) | Static HTML/CSS/JS + contact form PHP only | Per-plan monthly budget |
| **Admin mode** | Admin via Admin Panel | Any configured model, admin selects | None — any code, any content | No budget limit |

---

## What the Editor Produces

### Customer Mode

- Static HTML/CSS websites with JavaScript for interactive content
- Contact form with email delivery (PHP handler from a fixed platform template)
- All output files stored in the customer's existing `public_html/` directory on their PV
- Sites are immediately live on the customer's domain after publishing

### Admin Mode

- Any code and content — no restrictions
- Admin can write server-side PHP, complex JavaScript, custom logic, framework integrations
- Admin can edit any file type in the customer's `public_html/` directory
- Admin is trusted and acts on behalf of the customer

### What Customer Mode Does Not Do

- No server-side applications, CMSs, or databases
- No login systems, user accounts, or sessions
- No e-commerce or payment processing
- No JavaScript frameworks (React, Vue, Angular, etc.) — vanilla JS only
- No external CDN scripts except from the platform-maintained allowlist (e.g. Google Fonts)
- PHP is restricted to a single fixed contact form handler — never freely AI-generated

General JavaScript **is permitted** in customer mode for interactive content: animations, scroll effects, image galleries, accordions, tabs, counters, map embeds, and similar static-site interactivity.

---

## LLM Provider Configuration

### Supported Providers

The platform supports multiple LLM providers simultaneously. Each is configured with its own API key and can host multiple models. Admins define which models are available and assign default models per plan.

| Provider | Type | Notes |
|---|---|---|
| **Google** | Native API | Gemini models (`gemini-2.0-flash`, `gemini-1.5-pro`, etc.) |
| **Anthropic** | Native API | Claude models (`claude-haiku-3-5`, `claude-sonnet-4-5`, etc.) |
| **OpenAI** | Native API | GPT models (`gpt-4o-mini`, `gpt-4o`, etc.) |
| **Custom** | OpenAI-compatible API | Any self-hosted or third-party API that implements the OpenAI `/v1/chat/completions` endpoint (Ollama, LM Studio, OpenRouter, Groq, Together AI, Mistral, etc.) |

### Configuring Providers (Admin Panel → Settings → AI → Providers)

Each provider entry stores:

```json
{
  "provider_id": "google_main",
  "type": "google",                         // "google" | "anthropic" | "openai" | "openai_compatible"
  "display_name": "Google Gemini",
  "api_key": "AIza...",                     // stored as Kubernetes Secret
  "base_url": null,                         // required for openai_compatible type
  "enabled": true
}
```

**Custom OpenAI-compatible provider example:**
```json
{
  "provider_id": "local_ollama",
  "type": "openai_compatible",
  "display_name": "Local Ollama",
  "api_key": null,                          // null if no auth required
  "base_url": "http://ollama.internal:11434/v1",
  "enabled": true
}
```

API keys are stored as Kubernetes Secrets and never returned to the client panel.

### Configuring Models (Admin Panel → Settings → AI → Models)

Each model entry references a provider and defines its properties:

```json
{
  "model_id": "gemini-flash",
  "provider_id": "google_main",
  "model_name": "gemini-2.0-flash",        // model identifier sent to the API
  "display_name": "Gemini 2.0 Flash",
  "cost_per_1m_input_tokens": 0.10,        // for admin cost tracking (USD)
  "cost_per_1m_output_tokens": 0.40,
  "enabled": true,
  "available_for_customers": true,         // false = admin-only
  "available_for_admins": true
}
```

### Default Model Assignment Per Plan

Each hosting plan specifies the default model for AI editor requests from customers on that plan. This can be overridden per customer.

| Plan | Recommended Default Model | Rationale |
|---|---|---|
| Starter | `gemini-2.0-flash` | Cheapest per token; sufficient quality for simple sites |
| Business | `claude-haiku-3-5` or `gemini-2.0-flash` | Balance of quality and cost |
| Premium | `claude-haiku-3-5` or `gpt-4o-mini` | Better output quality; higher budget available |

Admins set the default model per plan in **Admin Panel → Settings → AI → Plan Defaults**.

### Per-Customer Model Override

Each customer record can override the plan default:

```json
{
  "customer_id": "cust_001",
  "ai_editor": {
    "enabled": true,                        // null = inherit from plan
    "model_id": "gemini-flash",             // null = use plan default
    "token_budget_monthly": 100000,         // null = use plan default
    "token_budget_override_reason": "Power user — increased budget on request"
  }
}
```

If `enabled` is set to `false`, the AI editor is disabled for that customer entirely, regardless of their plan.

### Admin Model Selection

When an admin opens the AI editor for a customer domain, they see a **model selector dropdown** at the top of the editor showing all enabled models marked `available_for_admins: true`. The admin can switch models freely mid-session. Admin sessions are not subject to token budgets.

---

## User Journey

### Phase 1: First-Time Setup — Guided Wizard

The wizard runs once per domain. It collects enough information to generate a complete first version of the site without the customer writing a single line of content.

```
Client Panel → AI Website Editor → [domain] → "Set up your website"

Step 1 — About Your Business
  Business name:     [________________]
  Tagline:           [________________]  e.g. "Honest plumbing since 1998"
  Business type:     [Dropdown / free text]
                     Plumber · Restaurant · Photographer · Consultant
                     Hair Salon · Law Firm · Gym · Other...

Step 2 — Your Pages
  Which pages do you want on your site?
  [✓] Home        [✓] About Us    [✓] Services    [ ] Gallery
  [✓] Contact     [ ] Testimonials [ ] FAQ        [ ] Blog (coming soon)

Step 3 — Look & Feel
  Choose a colour style:
  [● Warm & Earthy]  [○ Bold & Modern]  [○ Clean & Minimal]  [○ Dark & Professional]
  — or enter a brand colour: [#______]

Step 4 — Contact Details
  Phone:      [________________]
  Email:      [________________]  (pre-filled from account)
  Address:    [________________]
  WhatsApp:   [________________]  (optional)
  Business hours:  [________________]  e.g. "Mon–Fri 8am–5pm"

Step 5 — Logo & Social
  Logo:       [Upload logo]  (optional — placeholder used if skipped)
  Facebook:   [________________]  (optional)
  Instagram:  [________________]  (optional)
  LinkedIn:   [________________]  (optional)

  [← Back]                        [Generate My Website →]
```

After the customer clicks **Generate My Website**:

1. The wizard data is sent to the Management API
2. The API constructs a structured AI prompt from the wizard fields (not a freeform description)
3. The plan-assigned AI model generates the full HTML/CSS/JS for each selected page
4. Files are written to the staging buffer (`.ai_staging/`)
5. The editor opens on the live preview of the Home page
6. A progress indicator shows generation status per page (Home ✓, About ✓, Services ✓...)
7. Customer reviews the result and clicks **Publish** to make it live

**Token cost note:** The wizard uses structured prompts constructed server-side from wizard fields — one API call per page, no back-and-forth. This is the cheapest generation path.

---

### Phase 2: Ongoing Editing — Chat + Live Preview

After the wizard is complete and the site is published, the customer manages their site through the AI editor. New pages can be added at any time through the chat interface — the wizard is not required again.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  AI Website Editor — example.com                          [Publish] [⎌ Undo] │
├───────────────────┬──────────────────────────────────────────────────────────┤
│  Pages            │                                                          │
│  ─────────────    │                  LIVE PREVIEW                            │
│  ● Home           │  ┌────────────────────────────────────────────────────┐  │
│    About Us       │  │                                                    │  │
│    Services       │  │   [Logo]    Acme Plumbing    Home  About  Contact  │  │
│    Contact        │  │                                                    │  │
│                   │  │   ┌──────────────────────────────────────────────┐ │  │
│  [+ Add page]     │  │   │  Honest Plumbing Since 1998                  │ │  │
│                   │  │   │  We fix leaks fast. Call us today.           │ │  │
│  ─────────────    │  │   │                   [Get a Free Quote]         │ │  │
│  AI Assistant     │  │   └──────────────────────────────────────────────┘ │  │
│                   │  │                                                    │  │
│  ┌─────────────┐  │  │   Our Services          About Us                  │  │
│  │ Change the  │  │  │   ────────────          ────────                  │  │
│  │ hero button │  │  │   ...                   ...                       │  │
│  │ text to     │  │  └────────────────────────────────────────────────────┘  │
│  │ "Book Now"  │  │                                                          │
│  └─────────────┘  │  ● Pending changes — [Accept All] [Reject All]           │
│  [Send ↵]         │                                                          │
│                   │  Changed: Hero button text                               │
│  ┌─────────────┐  │  "Get a Free Quote" → "Book Now"                         │
│  │ AI          │  │                                                          │
│  │ Done! I've  │  │                                                          │
│  │ updated the │  │                                                          │
│  │ button.     │  │                                                          │
│  └─────────────┘  │                                                          │
└───────────────────┴──────────────────────────────────────────────────────────┘
```

**UI Components:**

| Element | Description |
|---|---|
| **Page list** | Left sidebar listing all pages by friendly name. Click to switch. |
| **Add page** | Opens a dialog: page name + description → AI generates the page and updates navigation on all existing pages |
| **Live preview** | Full-width rendered preview of the current page, refreshed after each accepted change |
| **Chat panel** | Plain-language input. Customer describes changes. AI responds with a plain-English summary — never raw code. |
| **Change summary** | Below the preview: human-readable description of what changed |
| **Accept / Reject** | Per-change or Accept All / Reject All. Changes are staged until accepted. |
| **Undo** | Reverts the last accepted change |
| **Publish** | Writes all accepted staged changes to `public_html/` and makes them live |

---

## Chat Interface Design

### Customer Mode

The customer types natural language. The AI responds with a brief plain-English summary of what changed. **The customer never sees HTML or code.**

```
Customer: "Add a photo gallery section to this page with 6 image slots"
AI:       "Done — I've added a gallery with 6 image placeholders. Upload
           your photos using the Images panel on the left and I'll slot
           them in."

Customer: "Make the gallery open each image in a lightbox when clicked"
AI:       "Updated — clicking any gallery image now opens it in a lightbox
           overlay with close and next/previous navigation."

Customer: "Add an animated counter that shows our stats: 500 clients,
           10 years in business, 98% satisfaction"
AI:       "Added a stats bar with animated counters. The numbers count up
           when the visitor scrolls to that section."

Customer: "Add a Google Map showing our location"
AI:       "I've added a map embed. You'll need to replace the placeholder
           with your own Google Maps embed code — you can get this from
           maps.google.com (Share → Embed a map)."

Customer: "Build me a members login area"
AI:       "I can't build login systems or user accounts — that requires
           server-side application code beyond what I can add here. Would
           you like a contact form instead, or I can add a link to an
           external service like a members portal?"
```

### New Page Creation via Chat

After the wizard is complete, customers can ask the AI to create new pages directly in chat — no separate dialog required:

```
Customer: "Create a new Team page with sections for our 4 staff members"
AI:       "Creating your Team page now... Done. I've added a Team page
           with 4 staff sections (name, role, and bio for each). It's
           been added to your navigation menu. Switch to it in the Pages
           panel on the left to fill in your team details."
```

The `[+ Add page]` button in the sidebar remains available as an alternative path.

### Guided Prompt Suggestions

Below the chat input, context-aware suggestion chips offer zero-typing common actions:

```
Suggestions for Home page:
  [Add a testimonials section]  [Update my phone number]
  [Add an image gallery]        [Add animated statistics]
```

Suggestions update when the customer switches pages or accepts a change.

### Admin Mode Chat

In admin mode, the chat has no restrictions. The admin can instruct the AI to produce any code or content. No scope refusals. No output scanner stripping.

```
Admin: "Add a PHP script that reads products from a CSV file and
        renders them as a product grid with filtering by category"
AI:    [Generates complete PHP + HTML + CSS + JS implementation]

Admin: "Integrate the Stripe.js payment library and add a checkout
        button that posts to their existing backend"
AI:    [Generates the integration code]
```

The admin is responsible for what is deployed to the customer's domain.

---

## Page Management

### Page List

Pages are shown by friendly name, not filename. Internally, `Home` maps to `index.html`, `About Us` to `about.html`, etc. The customer never sees filenames.

### Adding a New Page

Pages can be added in two ways after the wizard:

**Via chat:**
```
Customer: "Add a Pricing page with three plan tiers"
AI: Generates the page, adds to navigation, confirms in chat.
```

**Via sidebar button:**
```
[+ Add page] →

  Page name:    [Team]
  Description:  "A page introducing our 5 team members with photos and bios"

  [Cancel]  [Generate page →]
```

In both cases the new page is added to the navigation bar on all existing pages automatically.

### Deleting a Page

Customer clicks the page in the sidebar → "Delete page" → confirmation dialog. The HTML file is removed and the page is removed from the navigation on all other pages.

### Page Order / Navigation

Customer can drag pages in the sidebar to reorder them. The navigation bar on all pages updates to match.

---

## Contact Form

Adding a contact form is initiated through the chat interface or a suggestion chip:

```
Customer: "Add a contact form to my Contact page"
AI:       "I've added a contact form with Name, Email, and Message fields.
           Submissions will be sent to admin@acme.com.
           Would you like to add any other fields, like Phone or Subject?"
```

The HTML form and `contact.js` are AI-generated. The PHP handler (`contact.php`) is generated **from a fixed, security-reviewed platform template** — the AI fills in the recipient email and field list only. The customer never sees the PHP code.

**Fixed contact form handler features (platform template):**
- Sends email via platform SMTP relay (Docker-Mailserver)
- CSRF token validation
- Honeypot field (blocks naive bots)
- Rate limit: 5 submissions per hour per IP (enforced by platform middleware)
- JSON response consumed by the AI-generated `contact.js`
- No database, no file writes, no external HTTP calls

**Limits per plan:**

| Plan | Contact forms per domain |
|---|---|
| Starter | 1 |
| Business | 3 |
| Premium | Unlimited |

---

## JavaScript in Customer Mode

General JavaScript is permitted in customer mode for interactive website content. The AI may generate inline `<script>` blocks or `.js` files for:

**Permitted JavaScript:**
- Navigation interactions (mobile menu toggle, sticky header)
- Scroll animations and reveal effects
- Image galleries and lightboxes (vanilla JS, no frameworks)
- Animated counters and progress bars
- Tabs, accordions, and collapsible sections
- Form validation (client-side, in addition to server-side handling)
- Simple map embed helpers
- Cookie consent banners
- Social share buttons (platform allowlist only)

**Not permitted in customer mode (output scanner enforced):**
- JavaScript framework imports (`react`, `vue`, `angular`, etc.)
- `eval()`, `Function()`, `innerHTML` with untrusted data
- External script tags not on the platform allowlist
- `fetch()` or `XMLHttpRequest` to arbitrary URLs (only the contact form endpoint is allowed)
- `localStorage`/`sessionStorage` for sensitive data
- `document.cookie` manipulation

The output scanner validates JavaScript in AI-generated files and strips disallowed patterns before writing.

---

## Technical Architecture

### Where the Editor Lives

- **Customer:** Client Panel → AI Website Editor (`/editor/{domain_id}`)
- **Admin:** Admin Panel → Client → Domains → [domain] → AI Editor (`/admin/clients/{id}/editor/{domain_id}`)

Both operate on the same `public_html/` PV via the staging buffer. FileBrowser and SFTP remain available for direct file access.

### Staging Buffer

Changes are held in a per-domain staging buffer until the customer (or admin) clicks **Publish**.

```
public_html/        ← live site (what visitors see)
.ai_staging/        ← pending changes (not web-accessible)
```

The live preview inside the editor renders from `.ai_staging/`. On **Publish**, staging is copied to `public_html/`. On **Reject All**, staging is reset to match `public_html/`.

### API Flow

```
User types in chat
  ↓
Client/Admin Panel sends:
  POST /api/v1/ai/edit
  {
    "domain_id": "domain_001",
    "page": "index.html",
    "instruction": "Add an animated stats counter",
    "current_page_html": "<html>...</html>",
    "mode": "customer"          // "customer" | "admin"
    // admin requests also include: "model_id": "claude-sonnet"
  }
  ↓
Management API:
  1. Authenticate request (customer token → customer mode; admin token → admin mode)
  2. [Customer only] Check token budget — reject if exhausted
  3. [Customer only] Resolve model: customer override → plan default
  4. [Admin only] Use model_id from request (any enabled model)
  5. Build prompt (customer: scoped prompt; admin: unrestricted prompt)
  6. Call configured LLM provider API
  7. [Customer only] Run output scanner
  8. Write result to .ai_staging/
  9. Return change summary (customer: plain English; admin: plain English + optional diff)
  ↓
Panel:
  - Refresh live preview from .ai_staging/
  - Display change summary
  - Show Accept / Reject / Publish controls
```

### Prompt Construction

**Customer mode system prompt (< 400 tokens, static per session):**
```
You are a website editor. Output only the complete updated HTML file requested.
No explanation, no markdown fences, no commentary.

Permitted output:
- Valid HTML5 with inline or linked CSS
- Vanilla JavaScript (no frameworks) for interactive content:
  animations, galleries, accordions, tabs, counters, nav toggles, form validation
- <script> tags referencing contact.js (contact form only)
- External scripts only from: fonts.googleapis.com, fonts.gstatic.com

Do not output:
- PHP or other server-side code
- Imports of React, Vue, Angular, or any JS framework
- <script src="..."> to any domain not in the permitted list
- Login systems, database queries, payment processing

If the request requires something outside these rules, output exactly:
REFUSED: <one sentence reason and an alternative you can offer>

Business context: {{business_name}} — {{business_type}}. Brand colour: {{brand_colour}}.
```

**Admin mode system prompt:**
```
You are a web developer assistant. Output the complete updated file as requested.
No explanation, no markdown fences.
The admin has full authority to add any code or content to this customer's website.
```

Only the current page file is sent per request — not the entire site. This is the primary token cost control.

### Output Scanner (Customer Mode Only)

Admin mode bypasses the output scanner entirely.

| Check | Action on failure |
|---|---|
| File size > 150KB | Reject, return error |
| Contains `<?php` or `<?=` | Strip, log warning |
| `<script src>` not on allowlist | Strip |
| `<iframe>` | Strip |
| `javascript:` in `href` / `src` | Strip |
| `on*=` inline event attributes | Strip |
| `eval(` / `Function(` | Strip |
| `fetch(` / `XMLHttpRequest` to non-allowlist URL | Strip |
| Response starts with `REFUSED:` | Return refusal message to customer, do not write file |

### Token Budget Tracking

```sql
CREATE TABLE ai_token_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  domain_id     UUID NOT NULL REFERENCES domains(id),
  billing_cycle DATE NOT NULL,            -- first day of the month
  tokens_used   INT NOT NULL DEFAULT 0,
  tokens_budget INT NOT NULL,             -- resolved at cycle start from plan + overrides
  model_id      VARCHAR(100),             -- model in use for this cycle
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

Admin edits are logged separately and not counted against customer budgets:

```sql
CREATE TABLE ai_admin_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES admin_users(id),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  domain_id     UUID NOT NULL REFERENCES domains(id),
  model_id      VARCHAR(100) NOT NULL,
  tokens_input  INT NOT NULL,
  tokens_output INT NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

Budget exhaustion message shown to customer:
```
"You've used your AI editing budget for this month (50,000 tokens).
 Your budget resets on 1 April 2026. Contact your hosting provider
 if you need additional capacity."
```

---

## LLM Provider & Model Reference

### Cost Comparison (approximate, 2026)

| Provider | Model | Input (per 1M tokens) | Output (per 1M tokens) | Best For |
|---|---|---|---|---|
| Google | `gemini-2.0-flash` | $0.10 | $0.40 | Starter plan default — lowest cost |
| Google | `gemini-1.5-pro` | $1.25 | $5.00 | Higher quality generation |
| Anthropic | `claude-haiku-3-5` | $0.80 | $4.00 | Business plan default — good quality/cost |
| Anthropic | `claude-sonnet-4-5` | $3.00 | $15.00 | Admin use, premium output |
| OpenAI | `gpt-4o-mini` | $0.15 | $0.60 | Good alternative to Haiku |
| OpenAI | `gpt-4o` | $2.50 | $10.00 | Admin use, complex tasks |
| Custom | Any OpenAI-compatible | Varies | Varies | Self-hosted / cost control |

**Token budget cost at Gemini Flash pricing:**
- Starter 50k tokens/month ≈ **$0.015/month** per customer
- Business 200k tokens/month ≈ **$0.06/month** per customer
- Premium 500k tokens/month ≈ **$0.15/month** per customer

---

## Plan Defaults

| Feature | Starter | Business | Premium |
|---|---|---|---|
| AI Website Editor | ✅ | ✅ | ✅ |
| Default model | `gemini-2.0-flash` | `claude-haiku-3-5` | `claude-haiku-3-5` |
| Monthly token budget | 50,000 | 200,000 | 500,000 |
| Pages per domain | 5 | 15 | Unlimited |
| Contact forms per domain | 1 | 3 | Unlimited |
| Admin token top-up | ❌ | ✅ | ✅ |
| Per-customer model override | Admin only | Admin only | Admin only |
| Per-customer budget override | Admin only | Admin only | Admin only |
| Per-customer disable | Admin only | Admin only | Admin only |

All plan defaults are editable in **Admin Panel → Settings → AI → Plan Defaults**.

---

## Database Schema

### `ai_providers` Table

```sql
CREATE TABLE ai_providers (
  id           VARCHAR(100) PRIMARY KEY,   -- e.g. "google_main", "local_ollama"
  type         VARCHAR(30) NOT NULL,       -- "google" | "anthropic" | "openai" | "openai_compatible"
  display_name VARCHAR(100) NOT NULL,
  base_url     VARCHAR(500),              -- required for openai_compatible
  enabled      BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
  -- API key stored as Kubernetes Secret, referenced by provider_id
);
```

### `ai_models` Table

```sql
CREATE TABLE ai_models (
  id                        VARCHAR(100) PRIMARY KEY,  -- e.g. "gemini-flash", "haiku"
  provider_id               VARCHAR(100) NOT NULL REFERENCES ai_providers(id),
  model_name                VARCHAR(200) NOT NULL,     -- sent to API
  display_name              VARCHAR(100) NOT NULL,
  cost_per_1m_input_tokens  DECIMAL(10,4),
  cost_per_1m_output_tokens DECIMAL(10,4),
  enabled                   BOOLEAN DEFAULT TRUE,
  available_for_customers   BOOLEAN DEFAULT TRUE,
  available_for_admins      BOOLEAN DEFAULT TRUE,
  created_at                TIMESTAMP DEFAULT NOW()
);
```

### `ai_plan_defaults` Table

```sql
CREATE TABLE ai_plan_defaults (
  plan_id              VARCHAR(100) PRIMARY KEY REFERENCES plans(id),
  ai_editor_enabled    BOOLEAN DEFAULT TRUE,
  default_model_id     VARCHAR(100) REFERENCES ai_models(id),
  token_budget_monthly INT NOT NULL DEFAULT 50000,
  max_pages            INT,              -- NULL = unlimited
  max_contact_forms    INT               -- NULL = unlimited
);
```

### `ai_customer_overrides` Table

```sql
CREATE TABLE ai_customer_overrides (
  customer_id          UUID PRIMARY KEY REFERENCES customers(id),
  ai_editor_enabled    BOOLEAN,          -- NULL = inherit from plan
  model_id             VARCHAR(100) REFERENCES ai_models(id), -- NULL = use plan default
  token_budget_monthly INT,              -- NULL = use plan default
  override_reason      TEXT,
  set_by               UUID REFERENCES admin_users(id),
  updated_at           TIMESTAMP DEFAULT NOW()
);
```

---

## File Conventions

| Friendly name | Filename |
|---|---|
| Home | `index.html` |
| About Us | `about.html` |
| Services | `services.html` |
| Contact | `contact.html` |
| Gallery | `gallery.html` |
| [any custom page] | `{slugified-name}.html` |
| Shared stylesheet | `style.css` |
| Contact form handler | `contact.php` (platform template only) |
| Contact form script | `contact.js` |
| Uploaded images | `images/{filename}` |
| Custom JS files | `js/{filename}.js` |

All files live in `domains/{domain}/public_html/`. Navigation links use relative paths.

---

## Image Handling

1. **Logo:** Uploaded during wizard setup or via "Upload logo" in the editor sidebar. Stored as `images/logo.{ext}`. AI references it as `<img src="images/logo.png">`.
2. **Other images:** Customer uploads via the image uploader in the editor sidebar. AI references uploaded images by filename after upload.
3. **Placeholder images:** Until real images are uploaded, the AI uses CSS colour blocks or neutral SVG placeholders — no external image CDNs.
4. **Image suggestions:** AI suggests image placement in its responses but does not source or fetch images.

---

## Scope Enforcement (Customer Mode)

Scope is enforced at three independent layers. All three must be bypassed simultaneously for restricted content to reach disk — this is intentionally defence-in-depth.

| Layer | Mechanism | Can be bypassed by model? |
|---|---|---|
| **System prompt** | Instructs the model on permitted output | Yes — prompt injection is possible |
| **Output scanner** | Strips disallowed patterns server-side before write | No — server-side code, not prompt-dependent |
| **Contact form PHP** | Handler is a fixed platform template; no AI PHP generation permitted | No — API route does not accept PHP file creation |

Admin mode bypasses all three layers.

---

## Admin Panel Integration

### Per-Customer AI Settings

Admin Panel → Client → AI Website Editor

| Field | Detail |
|---|---|
| AI editor | Enabled / Disabled (inherits from plan if not overridden) |
| Model | `gemini-2.0-flash` (plan default) — [Change] |
| Token budget | `12,450 / 50,000 tokens used this month` — [Grant top-up] — [Override budget] |
| Pages created | 4 |
| Last activity | 2026-03-05 14:22 |
| Open AI Editor | [Open editor for this domain →] — opens admin mode editor |

### Platform-Wide AI Settings

Admin Panel → Settings → AI

**Providers tab:**
- List all configured providers (type, display name, enabled status)
- Add provider (type, display name, API key, base URL for custom)
- Edit / Enable / Disable / Delete provider

**Models tab:**
- List all configured models (provider, model name, cost, customer/admin availability)
- Add model (select provider, enter model name, set costs and availability flags)
- Edit / Enable / Disable model

**Plan Defaults tab:**
- Per-plan settings: enabled, default model, token budget, max pages, max contact forms
- Changes apply to new billing cycles; existing overrides are preserved

**Admin Usage tab:**
- Total tokens consumed by admin edits this month, broken down by model
- Top customers by admin edit activity

---

## Implementation Checklist

### Phase 1 — LLM Provider System + Setup Wizard

- [ ] `ai_providers`, `ai_models`, `ai_plan_defaults`, `ai_customer_overrides` DB tables
- [ ] Admin UI: Providers tab (add/edit/enable/disable, API key as K8s Secret)
- [ ] Admin UI: Models tab (add/edit/enable/disable, customer/admin flags)
- [ ] LLM abstraction layer: single `callModel(provider, model, messages)` function supporting Google, Anthropic, OpenAI, and OpenAI-compatible APIs
- [ ] Model resolution logic: customer override → plan default → platform fallback
- [ ] Setup wizard UI (5-step flow in Client Panel)
- [ ] Wizard data → structured prompt → per-page generation (one call per page)
- [ ] File write to staging buffer on wizard completion
- [ ] Publish button: staging → `public_html/`
- [ ] Token budget tracking (`ai_token_usage` table)
- [ ] Logo upload and image directory initialisation
- [ ] Contact form: HTML + JS (AI-generated) + PHP handler (platform template)

### Phase 2 — Chat Editor (Customer Mode)

- [ ] AI editor page in Client Panel (`/editor/{domain_id}`)
- [ ] Page list sidebar (friendly names, click to switch, drag to reorder)
- [ ] Staging buffer (`.ai_staging/`, not web-accessible)
- [ ] Live preview panel (sandboxed iframe from staging buffer)
- [ ] Chat input → `POST /api/v1/ai/edit` (mode: customer) → change summary
- [ ] New page creation via chat (generates page + updates nav on all pages)
- [ ] `[+ Add page]` sidebar button (name + description dialog)
- [ ] Accept / Reject / Undo / Publish flow
- [ ] Output scanner middleware (customer mode only)
- [ ] Guided suggestion chips (context-aware per page)
- [ ] Delete page (removes file + updates nav)
- [ ] Page reorder (drag sidebar → updates nav on all pages)
- [ ] Token exhaustion messaging
- [ ] Image uploader in editor sidebar

### Phase 3 — Admin Mode Editor

- [ ] Admin editor entry point: Admin Panel → Client → Domains → AI Editor
- [ ] Model selector dropdown (all admin-available models)
- [ ] Admin mode prompt (unrestricted)
- [ ] Admin mode skips output scanner and token budget check
- [ ] Admin token usage logging (`ai_admin_usage` table)
- [ ] Admin UI: per-customer AI settings (model override, budget override, top-up, disable)

### Phase 4 — Admin Panel AI Settings + Polish

- [ ] Admin UI: Plan Defaults tab
- [ ] Admin UI: Admin Usage tab
- [ ] Scope refusal messages with in-scope alternatives (customer mode)
- [ ] Model cost tracking and display in admin settings

---

## Related Documents

- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Client panel feature list
- [`../01-core/HOSTING_PLANS.md`](../01-core/HOSTING_PLANS.md) — Plan limits and token budgets
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel AI usage view

---

**Status:** Ready for implementation  
**Estimated Development Time:** 8–10 weeks (Phase 1: 2–3 weeks, Phase 2: 3 weeks, Phase 3: 1–2 weeks, Phase 4: 1 week)  
**Priority:** MEDIUM — post-MVP feature; does not block initial platform launch
