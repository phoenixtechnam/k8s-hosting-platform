# Test fixture for the Bulwark JWT-impersonation plugin

A self-contained code block to develop the plugin against — no
hosting-platform access needed. Spins up Stalwart locally via Docker,
provisions a master + target mailbox automatically, and ships a JWT
minter so you can generate signed handoff tokens to feed to your plugin.

## What you get out of the box

```
$ ./mint-token.sh dev@example.test
http://localhost:8080/_impersonate?token=eyJhbGciOiJIUzI1NiIs...
```

Open that URL in your browser pointed at your dev Bulwark instance.
Your plugin sees `?token=<jwt>`, verifies it, master-auths to Stalwart
as `dev@example.test%master@example.test:<master-password>`, sets the
Bulwark session, redirects to `/`.

---

## 1. JWT contract

The platform-side spec we'd commit to emit. The plugin only has to
verify these claims.

| Claim | Required | Notes |
|---|---|---|
| `alg` (header) | yes | HS256. Other algs MUST be rejected before signature verification (defends against `alg=none`). |
| `typ` (header) | optional | When present MUST be `JWT`. |
| `iss` | yes | Constant: `platform-api/webmail`. The plugin rejects anything else (defends against tokens issued for a different subsystem being replayed at the handoff). |
| `iat` | yes | Issued-at epoch seconds. |
| `exp` | yes | Expiry epoch seconds. Plugin enforces a hard ceiling — recommended **300 seconds max**. |
| `nbf` | optional | Not-before epoch seconds. Honored when present. |
| `jti` | yes | Random UUID. Plugin keeps an LRU of seen `jti`s and rejects replays for the token's lifetime. |
| `mailbox` | yes | Target mailbox address (RFC 5322 dot-atom local-part + valid domain). MUST NOT contain `%` or `:` — those would inject into the master-user auth string. The plugin rejects anything that doesn't match a strict regex. |
| `tenant_id` | optional | Free-form tenant identifier for audit logging. The plugin can opt to require it. |
| `actor_user_id` | optional | The platform user who triggered the handoff, for audit logging. |

**Signing key**: HS256, env var of the operator's choice
(e.g. `BULWARK_JWT_AUTH_SECRET`). Operators set it; the platform signs
with the same value.

**Clock skew**: ±60 seconds tolerated on `iat` and `nbf`.

**Replay protection**: in-memory LRU of `jti`s, sized for at least
1000 entries. TTL = max JWT lifetime + 60s skew.

---

## 2. JWT minter (Node, zero deps)

```js
// mint-token.js — drop into your test directory, run as:
//   node mint-token.js dev@example.test [secret] [ttl_seconds]
const crypto = require('node:crypto');

const mailbox = process.argv[2];
const secret = process.argv[3] || process.env.BULWARK_JWT_AUTH_SECRET || 'dev-secret-min-32-chars-long-aaaa';
const ttl = parseInt(process.argv[4] || '60', 10);

if (!mailbox || !mailbox.includes('@')) {
  console.error('usage: node mint-token.js <mailbox> [secret] [ttl_seconds]');
  process.exit(2);
}
if (secret.length < 32) {
  console.error('secret must be ≥32 chars');
  process.exit(2);
}

const b64 = v => Buffer.from(v).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const header  = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64(JSON.stringify({
  iss: 'platform-api/webmail',
  mailbox,
  jti: crypto.randomUUID(),
  tenant_id: 'fixture-tenant',
  actor_user_id: 'fixture-actor',
  iat: now,
  exp: now + ttl,
}));
const sig = b64(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());

console.log(`${header}.${payload}.${sig}`);
```

Run it:
```sh
$ node mint-token.js dev@example.test 'dev-secret-min-32-chars-long-aaaa' 60
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwbGF0Zm9...
```

Drop that into your handoff URL: `http://localhost:8080/_impersonate?token=<jwt>`.

---

## 3. Stalwart + master-user docker-compose

```yaml
# docker-compose.yml
services:
  stalwart:
    image: stalwartlabs/stalwart:v0.16.5
    container_name: bulwark-fixture-stalwart
    ports:
      - "8080:8080"     # JMAP management + JMAP API
      - "1143:143"      # IMAP
      - "1465:465"      # submissions
      - "1587:587"      # submission
    environment:
      # Stalwart's first-boot generates a temporary admin password if
      # STALWART_RECOVERY_ADMIN is unset. Setting it pins the credential
      # so the bootstrap script knows the value without log-scraping.
      - STALWART_RECOVERY_ADMIN=admin:bootstrap-recovery-pw-not-secret
    volumes:
      - stalwart-data:/opt/stalwart
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8080/jmap/session"]
      interval: 5s
      timeout: 3s
      retries: 30

volumes:
  stalwart-data:
```

Bring it up:
```sh
docker compose up -d
docker compose logs stalwart | grep -i 'bootstrap mode' | head -1
```

> **First-boot mode** — Stalwart v0.16+ starts in a restricted "bootstrap
> mode" with only HTTP open on :8080. The `x:Bootstrap/set` JMAP call
> is the only mutation allowed; everything else returns
> `forbidden / "The server is in bootstrap mode."`. `setup.sh` below
> does the Bootstrap/set + restart + provisioning automatically.

---

## 4. One-shot bootstrap script — creates master + target mailbox

Save as `setup.sh`, `chmod +x`, run AFTER `docker compose up`:

```sh
#!/usr/bin/env bash
set -euo pipefail

STALWART="${STALWART:-http://localhost:8080}"
HOSTNAME="${HOSTNAME:-mail.example.test}"
DOMAIN_NAME="${DOMAIN_NAME:-example.test}"
MASTER_PW="${MASTER_PW:-master-pw-keep-secret}"
TARGET_PW="${TARGET_PW:-dev-pw-also-secret}"
RECOVERY_PW="${RECOVERY_PW:-bootstrap-recovery-pw-not-secret}"

jmap() {
  curl -sf -u "$1" -H 'content-type:application/json' -X POST "${STALWART}/jmap/" -d "$2"
}

# Step 1: complete bootstrap mode. x:Bootstrap/set is the only call
# Stalwart accepts in bootstrap mode; it provisions the permanent
# admin (admin@<defaultDomain> with a freshly-generated password) and
# requires a process restart before the new admin is usable.
ACCT=$(curl -sf -u "admin:${RECOVERY_PW}" "${STALWART}/jmap/session" \
  | jq -r '(.primaryAccounts // {}) | to_entries[] | select(.key == "urn:stalwart:jmap") | .value')
BOOT_RESP=$(jmap "admin:${RECOVERY_PW}" \
  '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:Bootstrap/set",{"accountId":"'"$ACCT"'","update":{"singleton":{
      "serverHostname":"'"$HOSTNAME"'","defaultDomain":"'"$DOMAIN_NAME"'",
      "generateDkimKeys":false,"requestTlsCertificate":false
    }}},"c0"]]}')
ADMIN_USER=$(echo "$BOOT_RESP" | jq -r '.methodResponses[0][1].updated.singleton.username // empty')
ADMIN_PW=$(echo "$BOOT_RESP"   | jq -r '.methodResponses[0][1].updated.singleton.secret   // empty')
if [ -n "$ADMIN_USER" ]; then
  echo "✓ bootstrap completed — permanent admin: ${ADMIN_USER} (${ADMIN_PW})"
  echo "  restart Stalwart to activate the new admin, then re-run this script."
  echo "  e.g.  docker compose restart stalwart && sleep 10 && \\"
  echo "        ADMIN_USER=${ADMIN_USER} ADMIN_PW=${ADMIN_PW} ./setup.sh"
  exit 0
fi
# Past bootstrap — use the credentials the caller passed.
ADMIN_USER="${ADMIN_USER:?ADMIN_USER (e.g. admin@example.test) required after first run}"
ADMIN_PW="${ADMIN_PW:?ADMIN_PW required after first run}"

# Step 2: Domain (idempotent).
DOM_EXISTING=$(jmap "${ADMIN_USER}:${ADMIN_PW}" \
  '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:Domain/get",{"accountId":"'"$ACCT"'","ids":null,"properties":["id","name"]},"g"]]}' \
  | jq -r --arg n "$DOMAIN_NAME" '.methodResponses[0][1].list[] | select(.name == $n) | .id' | head -1)
DOMAIN_ID="${DOM_EXISTING:-$(jmap "${ADMIN_USER}:${ADMIN_PW}" \
  '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:Domain/set",{"accountId":"'"$ACCT"'","create":{"d":{"name":"'"$DOMAIN_NAME"'"}}},"c0"]]}' \
  | jq -r '.methodResponses[0][1].created.d.id')}"
echo "✓ domain ${DOMAIN_NAME} (${DOMAIN_ID})"

# Step 3: master account (Admin role — has impersonate permission)
jmap "${ADMIN_USER}:${ADMIN_PW}" \
  '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:Account/set",{"accountId":"'"$ACCT"'","create":{"m":{
      "@type":"User","name":"master","domainId":"'"$DOMAIN_ID"'",
      "credentials":{"0":{"@type":"Password","secret":"'"$MASTER_PW"'"}},
      "roles":{"@type":"Admin"}
    }}},"c0"]]}' > /dev/null

# Step 4: target mailbox
jmap "${ADMIN_USER}:${ADMIN_PW}" \
  '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:Account/set",{"accountId":"'"$ACCT"'","create":{"t":{
      "@type":"User","name":"dev","domainId":"'"$DOMAIN_ID"'",
      "credentials":{"0":{"@type":"Password","secret":"'"$TARGET_PW"'"}}
    }}},"c0"]]}' > /dev/null

echo ""
echo "════════════════════════════════════════════════════════"
echo "  domain:        ${DOMAIN_NAME}"
echo "  master:        master@${DOMAIN_NAME}  (${MASTER_PW})"
echo "  target:        dev@${DOMAIN_NAME}     (${TARGET_PW})"
echo "  master-auth:   dev@${DOMAIN_NAME}%master@${DOMAIN_NAME} : ${MASTER_PW}"
echo "  JMAP URL:      ${STALWART}/jmap/"
echo "════════════════════════════════════════════════════════"
```

⚠ **`.local` TLD is blocked by Stalwart for auth** — using `.test`
here (RFC 6761 reserved, not blocked). Don't switch to `.local`.

---

## 5. The plugin's job, restated

When your plugin receives `GET /_impersonate?token=<jwt>` (or whatever
handler path you wire up):

```
1. Pull `token` from query string
2. Verify JWT (header alg/typ, sig via HMAC-SHA256, iat/exp/nbf,
   jti not previously seen, mailbox regex, iss === "platform-api/webmail")
3. Build the master-auth Basic header:
     Basic base64(<mailbox>%<MASTER_USER>:<MASTER_PASSWORD>)
4. POST to Bulwark's own session-creation route (whichever surface you
   pick — could be /api/auth/session, could be a new plugin-owned
   endpoint that mints the cookie directly without basic-auth at all)
5. Forward Bulwark's Set-Cookie to the browser
6. 303 → /
```

Steps 3+4 are what the
[existing impersonator sidecar](https://github.com/phoenixtechnam/k8s-hosting-platform/blob/main/k8s/base/bulwark-impersonator/configmap.yaml#L160-L230)
does today — same flow, just outside Bulwark. Moving it inside Bulwark
as a plugin is the proposal.

---

## 6. End-to-end smoke (no plugin involvement, prove the master-auth works)

`accountId` for the impersonated mailbox is whatever the bootstrap
returned for the `dev` account — look it up via `/jmap/session` while
authenticated AS dev-via-master, then issue `Mailbox/get` with that
accountId:

```sh
DEV_AUTH=$(printf 'dev@example.test%%master@example.test:%s' "master-pw-keep-secret" | base64 -w0)

# 1. Resolve dev's primary mail accountId via the master-impersonated session
ACCT=$(curl -sf -H "Authorization: Basic $DEV_AUTH" http://localhost:8080/jmap/session \
  | jq -r '.primaryAccounts."urn:ietf:params:jmap:mail"')

# 2. Mailbox/get for that accountId
curl -sf -H "Authorization: Basic $DEV_AUTH" -H 'content-type:application/json' \
  -X POST http://localhost:8080/jmap/ \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],
       \"methodCalls\":[[\"Mailbox/get\",{\"accountId\":\"${ACCT}\",\"ids\":null,
                                          \"properties\":[\"name\",\"role\"]},\"a\"]]}" \
  | jq '.methodResponses[0][1].list'
```

Expected output — five default folders proves the chain works:

```json
[
  { "id": "a", "name": "Inbox",         "role": "inbox"  },
  { "id": "b", "name": "Deleted Items", "role": "trash"  },
  { "id": "c", "name": "Junk Mail",     "role": "junk"   },
  { "id": "d", "name": "Drafts",        "role": "drafts" },
  { "id": "e", "name": "Sent Items",    "role": "sent"   }
]
```

Verified end-to-end against `stalwartlabs/stalwart:v0.16.5` from a
clean docker volume — full transcript can be reproduced by running
`docker compose up -d`, then `./setup.sh` (which prints the new admin
creds), then `docker compose restart stalwart` + re-running setup.sh
with those creds, then the smoke command above.

---

## 7. Open questions to call out in the plugin design

- **Where does the plugin write the session cookie**? If Bulwark v1.6.x
  introduces a plugin hook for "session-create", great. If not, the
  plugin would need to internally call the same code path that
  `/api/auth/session` does today (currently broken from cookie-set →
  cookie-read, per the upstream issue).
- **Where does the secret come from**? Probably a new env var
  (`BULWARK_JWT_AUTH_SECRET` or similar), readable at plugin init.
- **Should there be a per-tenant secret**? For multi-platform hosting
  scenarios, a JWKS URL would be more scalable than a single shared
  secret — but a shared HS256 secret is the right MVP.
- **Audit logging**: emit one structured log line per accepted impersonate,
  with `jti`, `mailbox`, `tenant_id`, `actor_user_id`, request IP, and
  the request's HTTP referer. Operators rely on this for security review.
