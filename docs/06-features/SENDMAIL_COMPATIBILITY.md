# Sendmail compatibility for workload pods

**Status:** Phase 3 T5.1 — backend plumbing complete. Workload catalog
manifest changes pending (tracked in the application catalog repo).

## Problem

Legacy web apps (WordPress, PHP `mail()`, classic CGI scripts, many
old forum and wiki engines) hard-code `/usr/sbin/sendmail` as the
mail submission path. They shell out to it with the message on stdin
and expect it to "just work". In classic Linux hosting (Plesk, cPanel)
this is provided by a local MTA or a sendmail wrapper.

In our k8s architecture, the mail server is a separate pod (Stalwart
in the `mail` namespace). Workload pods have no MTA, no local
sendmail, and no direct SMTP authentication material. We need a way
to:

1. Provide `/usr/sbin/sendmail` inside every workload container.
2. Authenticate outbound mail to Stalwart's submission port (587)
   with credentials scoped per-customer (for rate limiting).
3. Never leak the credentials into the customer's file manager.
4. Survive pod restarts and credential rotation.

## Architecture (platform side)

The platform backend owns a new module at
`backend/src/modules/mail-submit/`:

- `service.ts` — generate/rotate/load per-client submission credentials
- `pvc-writer.ts` — write `.platform/sendmail-auth` to the client's PVC
- `routes.ts` — admin + client_admin endpoints to manage credentials

### Data model

Table `mail_submit_credentials` (migration 0013):

| column | notes |
|--------|-------|
| `id` | uuid |
| `client_id` | FK to `clients.id` ON DELETE CASCADE |
| `username` | `submit-<client_id>` (deterministic, unique among active) |
| `password_encrypted` | cleartext encrypted via `OIDC_ENCRYPTION_KEY` |
| `password_hash` | bcrypt hash, consumed by Stalwart |
| `revoked_at` | null for active rows |
| `created_at` / `last_used_at` | audit trail |

A partial unique index on `(username) WHERE revoked_at IS NULL`
ensures each client has at most one active credential at a time.

### Stalwart integration

Migration 0014 extends `stalwart.principals` with a `UNION ALL`
branch that exposes active submit credentials as additional
principals. Stalwart sees them as `individual` accounts with
quota = 0 so they can authenticate at submission but can't receive
mail (they're not in `stalwart.emails`).

Rate limiting leverages Stalwart's `[queue.throttle]` rules already
keyed on the authenticated `sender` principal — since submit
usernames are per-customer, the existing throttle config
automatically scopes limits per-customer.

### File on disk

The credential is written to the customer's PVC at:

    /data/.platform/sendmail-auth

Format is msmtprc-compatible:

    # Platform-managed — DO NOT EDIT
    account default
    host mail.platform.internal
    port 587
    auth on
    tls on
    tls_starttls on
    user submit-<client_id>
    password <plain>

The file-manager sidecar hides everything under `.platform/` from
the customer's browsing interface. A platform-internal header
(`X-Platform-Internal: 1`) bypasses the hide for the backend's
own writes.

## Workload manifest changes required

The application catalog repo
(`https://github.com/phoenixtechnam/k8s-application-catalog`)

### 1. Mounts the `.platform` subPath

```yaml
volumes:
  - name: customer-data
    persistentVolumeClaim:
      claimName: {{ .CustomerPvc }}
  - name: platform-config
    persistentVolumeClaim:
      claimName: {{ .CustomerPvc }}
containers:
  - name: app
    volumeMounts:
      - name: customer-data
        mountPath: /var/www/html
      - name: platform-config
        mountPath: /etc/platform
        subPath: .platform
        readOnly: true
```

The `subPath` mount projects only `.platform/` into the container,
so the customer's app can't accidentally browse into other reserved
platform files even if one is added later.

### 2. Includes msmtp in the base image

Debian/Ubuntu:

    RUN apt-get install -y --no-install-recommends msmtp msmtp-mta

Alpine:

    RUN apk add --no-cache msmtp

`msmtp-mta` provides a symlink `/usr/sbin/sendmail → msmtp` so legacy
apps that hard-code the sendmail path Just Work.

### 3. Configures msmtp to read `/etc/platform/sendmail-auth`

Option A — entrypoint symlink:

    ln -sf /etc/platform/sendmail-auth /etc/msmtprc

Option B — environment variable (for custom base images):

    ENV MSMTP_CONFIG_FILE=/etc/platform/sendmail-auth

### 4. Pod permissions

The app process must be able to read `/etc/platform/sendmail-auth`.
The file is written with default 0644 mode, so any user can read. If
the workload runs as non-root with a restricted fsGroup, add the
PVC's gid to `fsGroup` in the pod spec.

## Admin workflow

1. Admin enables email for a client (existing UI).
2. Backend auto-provisions a submit credential on first enable
   (TODO — currently manual via `/mail/submit-credential/rotate`).
3. Admin calls `POST /clients/:id/mail/submit-credential/rotate`
   to generate credentials. The response includes the plain
   password once (not stored anywhere else in plain form).
4. The backend writes `.platform/sendmail-auth` to the PVC
   immediately via the file-manager sidecar.
5. Workload pods pick up the new credentials on next send
   (msmtp re-reads the config file every invocation).

## Rotation

Operators can rotate at any time via:

    POST /api/v1/clients/:clientId/mail/submit-credential/rotate

The response includes:

- `id` of the new credential
- `username` (same deterministic value)
- `password` (plain — returned ONCE)
- `pushedToPvc: true/false` — whether the PVC write succeeded
- `pushError` — if the write failed

If the PVC write fails (file-manager unreachable, namespace missing),
the credential is still active in the DB. The admin can retry the
write via:

    POST /api/v1/clients/:clientId/mail/submit-credential/push-to-pvc

This endpoint decrypts the stored password and re-writes the file.

## Revocation

`POST /rotate` revokes the existing active credential. Direct
revocation without rotation isn't exposed through the API yet (use
the DB directly or call rotate and ignore the new password).

## Security notes

- The plain password is only ever transmitted once (at rotation
  response) and stored encrypted at rest via `OIDC_ENCRYPTION_KEY`.
- The bcrypt hash is what Stalwart sees — it cannot recover the
  plain password from the `stalwart.principals` view.
- The file-manager hides `.platform/` even for admin-scoped access
  because the hide is enforced in the sidecar itself.
- If `OIDC_ENCRYPTION_KEY` changes, existing encrypted passwords
  become unreadable — operators must rotate all submit credentials
  to regenerate the PVC files.

## Testing

Backend unit tests:

    backend/src/modules/mail-submit/service.test.ts

File-manager sidecar hide tests:

    images/file-manager-sidecar/hide.test.mjs

    cd images/file-manager-sidecar && node --test hide.test.mjs

End-to-end (local dev):

```bash
# 1. Rotate a credential
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://dind.local:2012/api/v1/clients/$CLIENT_ID/mail/submit-credential/rotate

# 2. Verify the auth file was written
#    (admin can peek via kubectl exec inside the file-manager pod)
kubectl exec -n client-$CLIENT_ID deploy/file-manager -- \
  cat /data/.platform/sendmail-auth

# 3. Verify the file does NOT show up in the customer file manager UI
curl -H "Authorization: Bearer $TOKEN" \
  "http://dind.local:2012/api/v1/clients/$CLIENT_ID/file-manager/ls?path=/"
# The response should NOT contain .platform in its entries.
```
