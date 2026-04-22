# Operator Age Key Setup

> TL;DR — On first bootstrap, `scripts/bootstrap.sh` generates an age keypair
> and prints the private key to stderr **exactly once**. Save it. It is the
> only key that can decrypt the backups this cluster produces. Lose it =
> backups unrecoverable. Leak it = anyone can decrypt the backups.

## What this key unlocks

Every backup artefact produced by the platform is encrypted with the
operator's age **public recipient** (`age1…`):

- `secrets-backup-cronjob` — daily age-encrypted tarballs of every
  platform + tenant Secret
- `hostpath-snapshot-cronjob` — age-encrypted snapshots of
  `/var/lib/platform/snapshots/`

The private half (`AGE-SECRET-KEY-1…`) is **never stored on the cluster**.
Only the public recipient lives in the `platform-operator-recipient`
ConfigMap. Restoring from backup requires the operator to bring the
private key back, typically during the DR drill.

## Choosing a strategy

| Option | Who holds the private key | When to pick |
|---|---|---|
| Single-key, single-operator | One person | Small teams, one owner-operator |
| Multi-recipient (team) | Two or more people, each with their own full age private key | Bus-factor safety, multiple on-call admins |
| Multi-recipient + escrow | As above + offline paper in a safe | Production, regulated environments |

Multi-recipient is transparent on the encryption side — `age` can encrypt
to a list of recipients in one pass, so pass a comma-separated list to
`--operator-age-recipient=ageA,ageB`.

## Bootstrap flows

### First-time install, generate a fresh keypair

```bash
./scripts/bootstrap.sh --domain phoenix-host.net --env production
```

The script will emit:

```
╔════════════════════════════════════════════════════════════════╗
║  OPERATOR AGE PRIVATE KEY — SAVE THIS NOW                      ║
║  ...                                                           ║
║  Public recipient (safe to share):                             ║
║    age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ║
║                                                                ║
║  Private key (SECRET — save and delete from terminal scroll):  ║
║    AGE-SECRET-KEY-1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX  ║
╚════════════════════════════════════════════════════════════════╝
```

Do **NOT** copy both halves into the same chat window, Slack message,
or email. Save the private key to your password manager immediately,
then confirm you can read it back before doing anything else.

### Non-interactive install with an existing recipient

If you already generated a key elsewhere (e.g. on your workstation with
`age-keygen -o ~/operator.key` and extracted the public half):

```bash
./scripts/bootstrap.sh --domain phoenix-host.net --env production \
  --operator-age-recipient age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Team setup (multiple recipients):

```bash
./scripts/bootstrap.sh --domain phoenix-host.net --env production \
  --operator-age-recipient age1aaaaaaaaaaaa,age1bbbbbbbbbbbb
```

### Re-bootstrap (idempotent)

Re-running `./scripts/bootstrap.sh` does **not** regenerate the key.
The script checks for the existing `platform-operator-recipient`
ConfigMap and skips the generation step if present. To rotate, see
below.

## Rotating the key

Rotating the operator key invalidates all previously-written backups —
they were encrypted to the old recipient. Plan accordingly:

1. Produce a fresh post-rotation backup **before** destroying the old
   private key. Age-decrypt an old artefact to verify the old key still
   works end-to-end.
2. Run bootstrap with `--force-rotate-operator-key`:
   ```bash
   ./scripts/bootstrap.sh --domain phoenix-host.net --env production \
     --force-rotate-operator-key
   ```
3. Save the new private key (same banner as first-time install).
4. Wait for the next scheduled `secrets-backup` CronJob (03:15 daily)
   or trigger manually:
   ```bash
   kubectl create job --from=cronjob/secrets-backup \
     secrets-backup-rotation-$(date +%s) -n platform
   ```
5. Decrypt the new artefact with the **new** private key to confirm.
6. You may now destroy the old private key. Optionally keep it in cold
   storage until the retention window (30 days) has elapsed, so old
   artefacts remain readable if needed.

## Storing the private key safely

Choose at least two of:

- **Password manager** — 1Password / Bitwarden / Vaultwarden. Tag as
  `operator-backup-key:<cluster-name>`.
- **Offline paper backup** — print the key on paper, seal in a tamper-
  evident envelope, store in a safe. Recommended for production.
- **Metal backup** — stamp on a titanium seed-phrase plate for physical
  robustness. Nice-to-have, not required.
- **Hardware-protected** — if your team uses YubiKey age support, encrypt
  the key with an age-plugin-yubikey recipient stored on-device. This is
  advanced and out of scope here.

Do **not**:

- Commit the private key to git (even a private repo).
- Paste the private key into Slack, email, or a chat LLM.
- Put the private key in `~/.age/keys.txt` on a shared workstation.
- Back up the private key alongside the encrypted backups (that defeats
  the purpose — the point is that the private key lives OUTSIDE the
  cluster's blast radius).

## Using the private key during DR restore

The `scripts/dr-restore.sh` script expects the private key at
`--age-key-file <path>`, typically `~/operator.key` on the restore
workstation. It:

1. Reads the key file.
2. Does a decrypt-smoke-test on the first backup artefact listed at the
   S3/SSH target before doing anything destructive. If the key and the
   artefact don't match, it fails fast with a clear error.
3. Streams each encrypted artefact through `age -d -i <key-file>` as it
   pulls from the backup target.

The key file format is the native `age-keygen` output — a single line
starting with `AGE-SECRET-KEY-1`. You can also use a multi-recipient
identity file (one key per line).

## Verifying the recipient on-cluster

To check which recipient is currently active:

```bash
kubectl get configmap platform-operator-recipient -n platform \
  -o jsonpath='{.data.recipient}'
```

Expected output: `age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
(comma-separated if multi-recipient).

If the ConfigMap is missing, the `secrets-backup` CronJob will fail
with `OPERATOR_RECIPIENT empty` and no tarballs will be uploaded —
bootstrap needs to run (or needs to complete its `generate_operator_recipient`
step).

## Emergency: key lost, no backup of the key itself

Without the private key, existing backup artefacts are **unrecoverable**.
Treat the cluster as the last source of truth, immediately:

1. Do NOT shut down any pods — the live Secrets + PVC data are still
   reachable.
2. Export everything off the live cluster with a fresh keypair:
   ```bash
   age-keygen -o new-operator.key
   # record the new public recipient
   kubectl create configmap platform-operator-recipient \
     --from-literal=recipient="$(grep -E '^# public key:' new-operator.key | awk '{print $NF}')" \
     -n platform \
     -o yaml --dry-run=client | kubectl apply -f -
   # trigger a fresh secrets-backup with the new recipient
   kubectl create job --from=cronjob/secrets-backup recovery-$(date +%s) -n platform
   ```
3. The old ciphertexts can be deleted (or kept as dead freight for
   forensics — they cannot be decrypted).
4. File a post-mortem. The improvement item is always: "store the new
   private key in N places this time."
