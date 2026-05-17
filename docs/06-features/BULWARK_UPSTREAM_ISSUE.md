# Title

Support Stalwart master-user impersonation for SSO from external admin panels

# Body

## Summary

Multi-tenant hosting platforms that already speak Stalwart's native master-user impersonation protocol (Roundcube's `jwt_auth.php` does this today) cannot use the same pattern with Bulwark. We can authenticate to Stalwart through Bulwark's session API — but the resulting session cookie is not honoured by the subsequent JMAP proxy route. The session-cookie path appears to be specific to user-driven password logins.

We'd like Bulwark to officially support delegated session creation, consistent with the master-user impersonation Stalwart already implements end-to-end.

## Use case (hosting platform context)

We build a Kubernetes-based hosting platform (50–100 tenants, ~1000 mailboxes today). Stalwart Mail Server is the backend; Bulwark is the user-facing webmail. The control panel needs an "Open Webmail" button on each mailbox that lands the operator's admin user in that mailbox's inbox **without re-prompting for the mailbox password** — credentials of individual mailboxes are not stored at the platform layer.

Today, with Roundcube, this works via Stalwart's standard master-user impersonation:

- The control panel mints a short-lived signed JWT carrying `{mailbox: <target>}`
- A Roundcube plugin (`jwt_auth.php`, ~100 LoC) verifies the JWT and calls `rcmail::login()` with username = `<target>%<master>` and the master password
- Roundcube logs the IMAP session in as the master, but operating on the target mailbox

The same pattern is impossible on Bulwark today because Bulwark's auth surface conflates "session created via API" with "user-driven password login".

## What we've tried

We built an `impersonator` sidecar inside the Bulwark Pod that:

1. Receives `GET /_impersonate?token=<jwt>` from the browser
2. Verifies the JWT (HS256, our signing key)
3. Calls `POST /api/auth/session` on the local Bulwark with body
   ```json
   {
     "serverUrl": "https://stalwart.example.com",
     "username": "target@example.com%master@example.com",
     "password": "<master_password>",
     "slot": 0
   }
   ```
4. Captures the response `Set-Cookie` headers
5. Returns `303 → /` plus those Set-Cookie headers to the browser

This is essentially what the user's browser would do if they typed the master-user form into a login screen, with `username` being the Stalwart master-impersonation string.

Bulwark accepts this:
- `/api/auth/session` returns `200 {"ok": true}`
- Two cookies are issued: `jmap_session` and `jmap_stalwart_ctx`
- The browser stores both, follows the 303 to `/`, loads the SPA

The SPA then makes its first XHR to `/api/account/stalwart/jmap` and **gets `401 {"error":"Not authenticated"}`** — despite both cookies being present in the request.

## Diagnostic trace

`/api/account/stalwart/jmap/route.js`:

```js
async function y(a) {
  try {
    let b = await (0, x.T)(a);
    if (!b) return NextResponse.json({error: "Not authenticated"}, {status: 401});
    let c = await a.text();
    let d = await fetch(`${b.serverUrl}/jmap/`, {
      method: "POST",
      headers: { Authorization: b.authHeader, "Content-Type": "application/json" },
      body: c,
    });
    ...
```

So the route relies on `x.T(req)` returning a truthy session. That function (module 3655's `T`, alias for the inner `j`) is:

```js
async function j(a) {
  let c = await (0, d.UL)();              // cookies()
  for (let slot of ...allSlots) {
    let session = (0, f.FR)(c, slot);      // mod 47749's FR
    if (session) return { serverUrl, authHeader, username, ... };
  }
  return null;
}
```

And `FR` (module 47749's `i`) is:

```js
function i(a, b) {
  let c = a.get(h(b))?.value;             // h(0) = "jmap_stalwart_ctx"
  if (!c) return null;
  let d = (0, e.GO)(c);                   // mod 31994's decrypt
  return d && typeof d === "object"
      && typeof d.serverUrl === "string"
      && typeof d.username === "string"
      && typeof d.authHeader === "string"
    ? d : null;
}
```

**Verified**:

- The `jmap_stalwart_ctx` cookie IS sent on the JMAP request (visible in `curl -v` output as the `Cookie:` header).
- The cookie value, decrypted manually with the Pod's `SESSION_SECRET`, decrypts to a valid payload:
  ```json
  {
    "serverUrl": "https://stalwart.example.com",
    "username": "target@example.com%master@example.com",
    "authHeader": "Basic <base64(target%master:pw)>"
  }
  ```
  All three fields are strings.
- Yet the route returns 401, and **no `"Payload decryption failed"` warning appears in Bulwark logs** — implying `cookies().get('jmap_stalwart_ctx').value` is returning `undefined` even though the Cookie header carries the value.
- This happens regardless of whether the request comes via Traefik, via the impersonator sidecar, or via direct loopback to `127.0.0.1:3000`.
- `SESSION_SECRET` is consistent between Pod restarts; the cookie is encrypted and immediately requested back to the same Pod.
- Reproduced on **Bulwark 1.6.5 AND 1.6.6**.

Tracking it further requires injecting `console.log` into the route handler, which our deployment can't do (read-only container FS).

## Why we believe this should work as documented

`/api/auth/session`'s contract today is: "POST credentials, get a session cookie, use the cookie for subsequent API calls". The route already constructs the Basic auth header itself:

```js
let p = `Basic ${Buffer.from(`${g}:${h}`).toString("base64")}`;
let q = ... await connectivity_probe(serverUrl, p, ...);
let r = (0, y.yp)(q, g, h);              // encrypt {serverUrl, username, password}
s.set(jmap_session_cookie, r, ...);
(0, C.yG)(s, n, { serverUrl: q, username: g, authHeader: p });   // encrypt + set jmap_stalwart_ctx
return NextResponse.json({ok: true});
```

The connectivity probe to Stalwart **succeeds with our master-user credentials** (Stalwart accepts the `<target>%<master>:<pw>` syntax exactly like any other Basic auth header — that's how master-user impersonation is supposed to work). Bulwark stores the resulting session correctly. The discrepancy is downstream: the SPA's JMAP proxy refuses to read it.

## Consistency with Stalwart

Master-user impersonation is a **first-class Stalwart feature**, documented at <https://stalw.art/docs/auth/authorization/administrator/>. The protocol is uniform across:

- IMAP `LOGIN "<target>%<master>" "<password>"`
- SMTP `AUTH PLAIN <base64(\0<target>%<master>\0<password>)>`
- HTTP JMAP `Authorization: Basic <base64(<target>%<master>:<password>)>`

Bulwark — which advertises itself as "purpose-built for Stalwart" — already handles all the moving pieces (the connectivity probe accepts it, the cookie is encrypted with it). Officially supporting impersonation by ensuring `/api/account/stalwart/jmap` honours sessions created via `/api/auth/session` would close the gap.

## Proposed solutions (in order of preference)

### A. Fix the cookie-read path on `/api/account/stalwart/jmap`

If `/api/auth/session`'s `jmap_stalwart_ctx` cookie is the canonical session, the JMAP proxy needs to read it. This may be a Next.js routing/build-output issue rather than design intent — happy to help repro on a writable build.

### B. Add a `?token=<signed_jwt>` query-param login (the Roundcube `jwt_auth.php` pattern)

Roundcube users have done this for years. Bulwark would:

1. Read `?token=<jwt>` from the request
2. Verify HS256/RS256 signature against `JWT_AUTH_SECRET` env (or a JWKS URL)
3. Require claims: `iss`, `sub` (mailbox), `iat`, `exp`, `jti` (replay protection)
4. Mint a session as if `/api/auth/session` had been called with `username=<sub>%<master>` and `password=<MASTER_PASSWORD>` — both read from env
5. Set the `jmap_stalwart_ctx` cookie identically to the user-login path
6. `303 → /`

This avoids any custom OAuth scaffolding. Bulwark stays consistent with Stalwart's master-user model; the only new code is a JWT verifier + the env vars `JWT_AUTH_SECRET`, `STALWART_MASTER_USER`, `STALWART_MASTER_PASSWORD`.

### C. Document an officially-supported "delegated session" pattern

Even if the implementation path differs, a clearly-supported recipe (env vars to set, route to call, contract Bulwark commits to) would let multi-tenant hosters integrate without reverse-engineering the build artifacts.

## Why this matters

Bulwark is the modern JMAP-native client for Stalwart, and we'd love to make it our default webmail. The blocker right now isn't authentication strength — it's the absence of a delegated-session contract that Stalwart itself already provides for free at the protocol layer. Closing this gap brings Bulwark to feature parity with Roundcube for multi-tenant deployments.

Happy to help test a fix or contribute a PR for Option B if it's in scope.

---

### Environment

- Bulwark `1.6.5` and `1.6.6` (both affected, same behaviour)
- Stalwart Mail Server `0.16.x`
- Deployment: Kubernetes, two-container Pod (Bulwark + impersonator sidecar)
- `ALLOW_CUSTOM_JMAP_ENDPOINT=false`
- `oauthEnabled=false`, no external OIDC required
