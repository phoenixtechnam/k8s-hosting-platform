# Private Worker Agent

Single-container home-side agent for the platform's **private worker** feature.
Run it anywhere you have outbound HTTPS, point it at a service running on the
same host (or LAN), and the platform will route public traffic for one of your
domains to that service through a TLS tunnel.

No public IP needed. No port forwarding. No inbound firewall holes.

## What it does

The agent decodes the platform-issued token from `$PRIVATE_WORKER_TOKEN`,
opens an outbound WebSocket-over-TLS connection to the cluster's tunnel
endpoint, and forwards traffic from the cluster-side proxy pod to your local
service. The agent is **stateless** — nothing is written outside `/tmp`. You
can `docker pull && docker restart` (or use Watchtower) without re-enrolling.

```
+----------------------+              wss://tunnels.<platform>/c/<slug>/
| your machine         |  ───────────────────────────────────────────►
|                      |          outbound TCP/443
|  +----------------+  |          NAT / CGNAT-friendly
|  | private-worker-|  |
|  |    agent       |  |   ┌────────────────────────┐
|  +────────┬───────+  |   │ platform cluster       │
|           │          |   │  - terminates tunnel   │
|  +────────▼───────+  |   │  - routes your domain  │
|  | your local app |◄─┼───┤  - applies TLS, oauth, │
|  | (e.g. :8080)   |  |   │    rate-limit, mTLS,…  │
|  +────────────────+  |   └────────────────────────┘
+----------------------+
```

## Quickstart

Get a token from the **Private Workers** page in your client panel. The token
is shown **once**, on creation — copy it immediately.

```bash
docker run -d \
  --name private-worker-agent \
  --restart unless-stopped \
  --network host \
  -e PRIVATE_WORKER_TOKEN='paste-the-token-here' \
  ghcr.io/phoenixtechnam/private-worker-agent:latest
```

`--network host` is the simplest way to reach a service running on `127.0.0.1`
of the same machine. If your service runs in another container, put both on
the same Docker network and set `local` to the other container's name (the
platform supports any reachable hostname, not just `127.0.0.1`) — see the
docker-compose example below.

Verify it's connected:

```bash
docker logs private-worker-agent | tail
# look for:  [I] login to server success...
```

In the platform UI, the worker's status will flip from `pending` to `active`
within a few seconds.

## docker-compose example

```yaml
services:
  my-app:
    image: my-internal-service:latest
    expose:
      - "8080"

  private-worker-agent:
    image: ghcr.io/phoenixtechnam/private-worker-agent:latest
    restart: unless-stopped
    depends_on:
      - my-app
    environment:
      # The platform issues this when you create a private worker.
      # Store it in a .env file — never commit it to git.
      PRIVATE_WORKER_TOKEN: ${PRIVATE_WORKER_TOKEN}
      # Optional: bump to "debug" to troubleshoot the dial-in.
      PRIVATE_WORKER_LOG_LEVEL: info
```

When you minted the worker, you set `local` to (for example)
`my-app:8080`; the agent will forward tunnel traffic to that hostname.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PRIVATE_WORKER_TOKEN` | yes | — | Base64url-encoded JSON token issued by the platform. Single source of truth — the agent has no other state. |
| `PRIVATE_WORKER_LOG_LEVEL` | no | `info` | One of `trace`, `debug`, `info`, `warn`, `error`. |
| `PRIVATE_WORKER_ADMIN_PORT` | no | `7400` | Bound on `127.0.0.1` only; used by the container's `HEALTHCHECK`. |
| `PRIVATE_WORKER_CONFIG_PATH` | no | `/tmp/frpc.toml` | Where the entrypoint writes the rendered config. Override only if you mount a tmpfs elsewhere. |

## What you'll need

- The platform-issued token (from your client panel → Private Workers → Create)
- A local service to expose (HTTP or any TCP service) reachable from inside the agent container
- Outbound HTTPS to the platform's tunnel host (port 443)

## What you do *not* need

- A public IP address
- Port forwarding on your router
- Any inbound firewall hole
- Static IP / dynamic-DNS
- An always-on machine that's the same one you minted the token on (any host with the token + network access works)

## Updating

```bash
docker pull ghcr.io/phoenixtechnam/private-worker-agent:latest
docker restart private-worker-agent
```

The token survives image upgrades because it lives in your environment, not
the container's filesystem. Watchtower / Renovate-style auto-updaters work
unchanged.

## Rotating the token

Operator UX: open the worker in the client panel → **Rotate** → copy the new
token → update your env / `.env` file → `docker restart private-worker-agent`.
The previous token is invalidated immediately on rotate; there is no dual-token
grace window in v1.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `PRIVATE_WORKER_TOKEN is not set` | env var didn't reach the container | Check `docker inspect <name>` env section; for `compose`, ensure `.env` is in the same directory as `docker-compose.yml` |
| `failed to base64-decode` / `invalid JSON` | token mangled in copy-paste | Re-copy from the platform UI; do not edit it |
| `Unsupported token version v=...` | platform minted a newer token format | Pull a newer agent image |
| `login to server failed: ...token...` in logs | token revoked or rotated | Mint a new token in the UI; update env; restart container |
| Tunnel up, but `https://your-domain/...` returns `502 Bad Gateway` | local service isn't running, or `local` host:port in the token doesn't match the actual service | `docker exec private-worker-agent curl -sI http://<local-host>:<local-port>` from inside the container; fix the local service or rotate the worker with the correct address |
| Agent reconnects every few seconds | network instability or platform-side rate-limit hit | Check `docker logs`; if you see `429`/`too many requests`, wait a minute and let backoff settle |
| `dial tcp: lookup tunnels.<host>: no such host` | DNS unavailable from the container | Verify the host has working DNS; for `--network host`, this almost always means the host's resolv.conf is broken |
| Status stays `pending` in UI after 1+ minute | agent never connected once | Check `docker logs`; common cause: outbound 443 is blocked by a corporate firewall |

## Image tags

- `:latest` — newest build from the platform's main branch
- `:<git-sha>` — pinned, immutable build (recommended for production home use)
- `:v<X.Y.Z>` — semver tag (post-1.0)

## Architecture / multi-arch

Image is built for `linux/amd64` and `linux/arm64`. Other architectures are
not currently published; the `Dockerfile` will fail-fast on unsupported
`TARGETARCH` values if you build it yourself.

## Provenance

The agent embeds a copy of [frp v0.62.1](https://github.com/fatedier/frp/releases/tag/v0.62.1)
(`frpc` only). The Dockerfile pins both the version and the per-architecture
SHA-256 sums against the upstream
[`frp_sha256_checksums.txt`](https://github.com/fatedier/frp/releases/download/v0.62.1/frp_sha256_checksums.txt).
When upgrading frp, update `FRP_VERSION` **and** both `FRP_SHA256_*` build
args in `Dockerfile` together — the build will fail if the hashes don't
match the downloaded tarballs.

## Reporting bugs

This image is part of the platform monorepo. File issues against the platform
repo and tag them with `area:private-worker`.
