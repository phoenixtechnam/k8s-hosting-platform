// Claim Validator — sidecar for the per-client oauth2-proxy.
//
// Listens on port 4181. Receives the NGINX auth_request subrequest,
// forwards it to the local oauth2-proxy on port 4180, and — on a 200
// response — decodes the X-Auth-Request-Id-Token and applies the
// claim rules configured for the matching ingress route. Any rule
// failure becomes a 403; any non-200 response from oauth2-proxy is
// passed through unchanged so the redirect-to-login flow keeps working.
//
// Why a sidecar:
//   NGINX's auth_request directive only accepts a single auth-url. To
//   layer "OIDC-validated session AND custom claim policy" we need a
//   single endpoint that does both. This sidecar IS that endpoint —
//   it composes "session check" (delegated to oauth2-proxy) with
//   "claim policy" (read from a file at /etc/claim-rules/rules.json).
//
// Rule file format:
//   {
//     "<ingress-route-id>": [
//       {"claim":"membership","operator":"contains","value":"paid"},
//       {"claim":"groups","operator":"in","value":["engineers","admins"]}
//     ]
//   }
//
// The route id is read from the `route` query parameter the platform
// adds to the auth-url annotation. When no rules are configured for a
// route, this validator only enforces the oauth2-proxy session check.

import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, watch } from 'node:fs';

const PORT = Number(process.env.PORT ?? 4181);
const OAUTH2_PROXY_HOST = process.env.OAUTH2_PROXY_HOST ?? '127.0.0.1';
const OAUTH2_PROXY_PORT = Number(process.env.OAUTH2_PROXY_PORT ?? 4180);
const RULES_PATH = process.env.RULES_PATH ?? '/etc/claim-rules/rules.json';

// Header oauth2-proxy sets when --pass-id-token is on. The validator
// requires this header on a 200-from-oauth2-proxy response when any
// rule is configured for the route — without it we cannot evaluate.
const ID_TOKEN_HEADER = 'x-auth-request-id-token';

let rules = {};

function loadRules() {
  try {
    const raw = readFileSync(RULES_PATH, 'utf8');
    rules = JSON.parse(raw);
    log('rules-loaded', { routes: Object.keys(rules).length });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('rules-load-error', { error: err.message });
    }
    rules = {};
  }
}

function log(event, fields = {}) {
  // Single-line JSON for cluster log scrapers. No PII (claim values
  // are intentionally not logged — they may contain user identifiers).
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n',
  );
}

// Decode a JWT's payload without verification — oauth2-proxy already
// verified the token signature against the OIDC JWKS. We trust the
// upstream header. Returns null if decoding fails.
function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Walk a dotted path through an object — supports "user.email" and
// "address.country". Returns undefined when any segment is missing.
function getClaim(payload, path) {
  let cur = payload;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Apply a single rule to the decoded claim set. Returns true on pass.
// Operators:
//   equals / not_equals     — string equality
//   contains / not_contains — substring (string) or element-of (array)
//   in / not_in             — claim value matches one of value[]
//   exists                  — claim is present (any value, including null)
//   regex                   — ECMAScript regex match against string claim
function applyRule(payload, rule) {
  const v = getClaim(payload, rule.claim);
  switch (rule.operator) {
    case 'exists':
      return v !== undefined;
    case 'equals':
      return typeof v === 'string' && v === rule.value;
    case 'not_equals':
      return !(typeof v === 'string' && v === rule.value);
    case 'contains':
      if (typeof rule.value !== 'string') return false;
      if (typeof v === 'string') return v.includes(rule.value);
      if (Array.isArray(v)) return v.includes(rule.value);
      return false;
    case 'not_contains':
      if (typeof rule.value !== 'string') return true;
      if (typeof v === 'string') return !v.includes(rule.value);
      if (Array.isArray(v)) return !v.includes(rule.value);
      return true;
    case 'in':
      if (!Array.isArray(rule.value)) return false;
      if (typeof v === 'string') return rule.value.includes(v);
      if (Array.isArray(v)) return v.some((x) => rule.value.includes(x));
      return false;
    case 'not_in':
      if (!Array.isArray(rule.value)) return true;
      if (typeof v === 'string') return !rule.value.includes(v);
      if (Array.isArray(v)) return !v.some((x) => rule.value.includes(x));
      return true;
    case 'regex':
      if (typeof v !== 'string' || typeof rule.value !== 'string') return false;
      try {
        return new RegExp(rule.value).test(v);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// Apply ALL rules with AND semantics. Returns the first failing rule
// for diagnostics, or null on full pass.
function evaluateRules(payload, ruleList) {
  for (const rule of ruleList) {
    if (!applyRule(payload, rule)) return rule;
  }
  return null;
}

// Forward the auth-request to oauth2-proxy and call the callback with
// the upstream Response object. We preserve the cookie + auth headers
// so oauth2-proxy can resolve the session. The path is hardcoded to
// /oauth2/auth — the validator's only job is to wrap that one endpoint.
function callOauth2Proxy(headers, callback) {
  const req = httpRequest(
    {
      host: OAUTH2_PROXY_HOST,
      port: OAUTH2_PROXY_PORT,
      path: '/oauth2/auth',
      method: 'GET',
      // Preserve cookies + any X-Forwarded-* headers NGINX set.
      headers,
    },
    (res) => callback(null, res),
  );
  req.on('error', (err) => callback(err));
  req.end();
}

function handleRequest(req, res) {
  // Only one path is exposed — keep the surface small.
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/auth' && url.pathname !== '/ping') {
    res.writeHead(404).end();
    return;
  }
  if (url.pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  const routeId = url.searchParams.get('route') ?? '';
  const ruleList = rules[routeId] ?? [];

  // Forward to oauth2-proxy. Strip hop-by-hop headers but keep cookies
  // and auth headers (the only ones oauth2-proxy actually uses).
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'connection' ||
      lk === 'content-length' ||
      lk === 'transfer-encoding'
    ) {
      continue;
    }
    forwardHeaders[k] = v;
  }

  callOauth2Proxy(forwardHeaders, (err, upstream) => {
    if (err) {
      log('oauth2-proxy-error', { route: routeId, error: err.message });
      res.writeHead(502, { 'content-type': 'text/plain' }).end('oauth2-proxy unreachable');
      return;
    }
    const status = upstream.statusCode ?? 500;
    // Capture upstream headers so we can pass identity headers
    // back to NGINX (auth-response-headers picks them up there).
    const upstreamHeaders = { ...upstream.headers };
    // Drop hop-by-hop response headers.
    delete upstreamHeaders['transfer-encoding'];
    delete upstreamHeaders['connection'];

    if (status !== 200) {
      // Pass through the redirect/401 unchanged so the OAuth2 flow
      // (302 → /oauth2/start → IdP) works as designed.
      res.writeHead(status, upstreamHeaders);
      upstream.pipe(res);
      return;
    }

    // 200 from oauth2-proxy — session is valid. If we have rules,
    // decode the id_token header and apply them.
    if (ruleList.length === 0) {
      res.writeHead(200, upstreamHeaders);
      upstream.pipe(res);
      return;
    }

    const idToken = upstreamHeaders[ID_TOKEN_HEADER];
    if (!idToken || typeof idToken !== 'string') {
      log('rules-no-id-token', { route: routeId });
      // 403 — caller has session but no id_token to evaluate. The
      // ingress config must enable passIdToken when claimRules is set.
      // The reconciler validates this at write time but defence in
      // depth here keeps us from accidentally allowing.
      res.writeHead(403, { 'content-type': 'text/plain' }).end(
        'claim validation requires pass_id_token to be enabled on the ingress',
      );
      upstream.resume(); // drain
      return;
    }

    const payload = decodeJwtPayload(idToken);
    if (!payload) {
      log('rules-bad-id-token', { route: routeId });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(
        'invalid id_token',
      );
      upstream.resume();
      return;
    }

    const failingRule = evaluateRules(payload, ruleList);
    if (failingRule) {
      log('rule-failed', {
        route: routeId,
        claim: failingRule.claim,
        operator: failingRule.operator,
      });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(
        `claim '${failingRule.claim}' failed '${failingRule.operator}' check`,
      );
      upstream.resume();
      return;
    }

    log('allow', { route: routeId, rules: ruleList.length });
    res.writeHead(200, upstreamHeaders);
    upstream.pipe(res);
  });
}

loadRules();
try {
  watch(RULES_PATH, { persistent: false }, () => loadRules());
} catch {
  // File may not exist yet on cold start; loadRules handles ENOENT.
}

createServer(handleRequest).listen(PORT, () => {
  log('startup', { port: PORT, oauth2Proxy: `${OAUTH2_PROXY_HOST}:${OAUTH2_PROXY_PORT}` });
});
