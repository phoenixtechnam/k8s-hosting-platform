-- F4 — DB-backed WAF rule exclusions.
--
-- Companion to the static k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml.
-- A backend reconciler (modules/waf-rule-exclusions/reconciler.ts) renders the
-- enabled rows into the `modsec-crs-exclusions-dynamic` ConfigMap (file
-- REQUEST-901-EXCLUSION-RULES-BEFORE-CRS-DYNAMIC.conf) and bumps a hash
-- annotation on the modsec-crs Deployment so it rolls. The static file
-- stays for global, repo-versioned exclusions; this table holds the
-- operator-managed surgical exclusions added from the WAF Events tab.
--
-- scope:
--   - 'args_names_only': remove ARGS_NAMES from the rule's variable list
--     (keeps ARG values + headers scanned — the standard CRS JSON-API
--     false-positive fix)
--   - 'full_disable':    ctl:ruleRemoveById — disables the rule entirely
--     for matching hosts (use sparingly)
--
-- hostname_regex is rendered into a `@rx <value>` operator on
-- REQUEST_HEADERS:X-Forwarded-Host. The service layer validates that
-- the regex parses and contains no double-quote (which would terminate
-- the SecRule string and allow rule injection). Operators are expected
-- to anchor with ^/$ to avoid over-broad matches.
--
-- rule_id has digits-only constraint matching the api-contracts Zod
-- regex; the renderer trusts it as a number literal.

CREATE TABLE IF NOT EXISTS waf_rule_exclusions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         varchar(16)  NOT NULL,
  hostname_regex  varchar(255) NOT NULL,
  scope           varchar(32)  NOT NULL,
  reason          text         NOT NULL,
  created_by      varchar(255) NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  disabled        boolean      NOT NULL DEFAULT false,

  CONSTRAINT waf_rule_exclusions_rule_id_digits CHECK (rule_id ~ '^[0-9]+$'),
  CONSTRAINT waf_rule_exclusions_scope_enum     CHECK (scope IN ('args_names_only', 'full_disable')),
  CONSTRAINT waf_rule_exclusions_regex_no_quote CHECK (position('"' in hostname_regex) = 0),
  CONSTRAINT waf_rule_exclusions_regex_no_newline CHECK (position(E'\n' in hostname_regex) = 0),
  -- Bare CR mid-line in the rendered .conf has unpredictable lexer
  -- behavior. Zod blocks it at the API; DB CHECK is the last-resort
  -- defense against direct DB writes, migration replays, or future
  -- service-layer bypasses.
  CONSTRAINT waf_rule_exclusions_regex_no_cr CHECK (position(E'\r' in hostname_regex) = 0),
  -- Trailing `\` would escape the closing `"` in the rendered SecRule
  -- and crash modsec-crs (CrashLoopBackOff → cluster-wide WAF outage).
  -- The API layer catches this via Zod .refine(regexParseable) calling
  -- new RegExp(); this DB check is the last-resort defense against
  -- direct-SQL bypass. Mid-string `\` is permitted because legitimate
  -- patterns escape `.` as `\.`.
  CONSTRAINT waf_rule_exclusions_regex_no_trailing_backslash
    CHECK (right(hostname_regex, 1) <> '\')
);

-- Same (rule_id, hostname_regex, scope) pair MUST be unique among
-- ENABLED rows. Disabled rows are excluded so an operator can keep
-- audit history without blocking re-creation.
CREATE UNIQUE INDEX IF NOT EXISTS waf_rule_exclusions_unique_enabled
  ON waf_rule_exclusions (rule_id, hostname_regex, scope)
  WHERE disabled = false;

CREATE INDEX IF NOT EXISTS waf_rule_exclusions_disabled_idx
  ON waf_rule_exclusions (disabled);

CREATE INDEX IF NOT EXISTS waf_rule_exclusions_rule_id_idx
  ON waf_rule_exclusions (rule_id);
