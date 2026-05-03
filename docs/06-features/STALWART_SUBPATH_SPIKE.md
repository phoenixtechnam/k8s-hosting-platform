# Stalwart 0.16 WebUI Subpath Spike

**Date:** 2026-05-01
**Verdict:** NOT VIABLE — rename to `stalwart.${DOMAIN}` (Option b)

## What was tested

The spike goal was to determine whether Stalwart 0.16's embedded WebUI SPA
can be served at a sub-path of `admin.${DOMAIN}` (e.g. `/__stalwart/`) via
an nginx path-rewriting reverse proxy, so that one fewer DNS record and TLS
certificate is needed.

Two proxy configurations were analysed:

### Configuration A — Naive prefix-strip

```
location /__stalwart/ {
    proxy_pass http://stalwart-spike:8080/;
}
```

Strips `/__stalwart/` before forwarding. The SPA HTML loads but every asset
reference inside (`/static/`, `/favicon.ico`, `/app.js`) is root-relative —
the browser fetches them from `admin.${DOMAIN}/static/...` (the admin panel
origin), not from the Stalwart backend. All static assets 404. The SPA never
renders.

### Configuration B — Aggressive rewrite (also rewrite API paths)

```
location /__stalwart/    { proxy_pass ...:8080/; }
location /jmap/          { proxy_pass ...:8080/jmap/; }
location /.well-known/jmap { proxy_pass ...:8080/.well-known/jmap; }
location /healthz/       { proxy_pass ...:8080/healthz/; }
location /auth/          { proxy_pass ...:8080/auth/; }
```

Even if you proxy every API path to Stalwart, the SPA's own JS bundle is
fetched as `/app-<hash>.js` (root-relative). nginx has no rule for that path,
so it falls through to the admin panel upstream. The bundle never loads —
same 404 outcome.

The SPA would only work if nginx intercepted every _unpredictable_ content-
addressed asset URL (e.g. `/assets/index-BkZy3Tjr.js`). This is a moving
target: any Stalwart upgrade changes the content hash, breaking the nginx
config.

## Why rewriting is not fixable without a custom build

Stalwart 0.16 ships the `stalwartlabs/webui` SPA bundled inside the container
image. That SPA is compiled with `BASE_PATH=/` hard-coded (standard Leptos/
Trunk default). All `<script src>`, `<link href>`, and fetch() calls use
absolute-from-root URLs.

To serve it at `/__stalwart/` you would need to:

1. Clone `stalwartlabs/webui`, set `data-trunk-public-url="/__stalwart/"` in
   `index.html`, rebuild with Trunk, and patch the container image — or
2. Inject a `<base href="/__stalwart/">` tag via nginx `sub_filter` after
   decompressing the response (requires `ngx_http_sub_module`, and the
   `sub_filter` only targets HTML, not JS `import()` statements or fetch
   calls that use `location.origin + '/jmap/...'`).

Neither approach is maintainable in a supported upgrade path: option 1 forks
the upstream image; option 2 requires recompiling NGINX Ingress.

## Collateral damage from the aggressive proxy

Even in the optimistic case where the SPA loaded, routing `/jmap/`, `/auth/`,
and `/.well-known/jmap` at the `admin.*` host would:

- Expose Stalwart's authentication endpoint (`/auth/token`) under the admin
  panel domain, where ModSecurity CRS OWASP rule 920420 fires (wrong Content-
  Type). A modsecurity-snippet bypass is already documented in the base
  `ingress-mgmt.yaml` — it would have to be replicated here.
- Let tenant JS code (served from the same admin origin) call Stalwart's JMAP
  API directly — a violation of the platform's tenant-isolation model.
- Invalidate the `sandbox="allow-same-origin"` iframe contract: the iframe
  and the admin panel would share the same origin, meaning the Stalwart SPA
  could read the admin panel's localStorage / cookies.

## Decision

Subpath approach is not viable without a custom WebUI build. Proceeding to
**Option b: rename `mail-admin.${DOMAIN}` → `stalwart.${DOMAIN}`**.

`stalwart.` is cleaner, widely understood, and unambiguous. It still requires
one DNS record and one TLS cert — same count as the current `mail-admin.`
setup — but looks intentional rather than like a legacy artefact.

Changes made in the same commit as this document: see Task 2 in the commit
message.
