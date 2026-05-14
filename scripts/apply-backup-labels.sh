#!/usr/bin/env bash
# One-shot: label every Longhorn PVC that isn't already in the default
# recurring-job group. Safe to run repeatedly — kubectl label with
# --overwrite is idempotent and skips PVCs already opted in.
#
# Context: until the N2 backend fix landed, tenant PVCs were created
# without the recurring-job-group.longhorn.io/default=enabled label
# and Longhorn's daily backup schedule silently skipped them. New PVCs
# now get the label at creation; this script catches the ones from
# before the fix.
#
# Usage:
#   ./scripts/apply-backup-labels.sh            # label all Longhorn PVCs
#   ./scripts/apply-backup-labels.sh --dry-run  # list what would change

set -euo pipefail

DRY_RUN=${DRY_RUN:-false}
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=true; fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "error: kubectl not on PATH" >&2
  exit 1
fi

# Opt-out annotation lets operators intentionally exclude a PVC from
# the default group (e.g. a pay-tier client who declined backups). The
# audit CronJob in Phase N6 honours the same annotation.
OPT_OUT_ANNOTATION='platform.phoenix-host.net/backup-excluded'
TARGET_LABEL='recurring-job-group.longhorn.io/default=enabled'

mapfile -t rows < <(kubectl get pvc -A -o json \
  | jq -r --arg opt_out "$OPT_OUT_ANNOTATION" '.items[]
           | select(.spec.storageClassName=="longhorn")
           | [
               .metadata.namespace,
               .metadata.name,
               (.metadata.labels["recurring-job-group.longhorn.io/default"] // "none"),
               (.metadata.annotations[$opt_out] // "false")
             ]
           | @tsv')

changed=0
skipped=0
opted_out=0
for row in "${rows[@]}"; do
  [[ -z "$row" ]] && continue
  IFS=$'\t' read -r ns name group excluded <<< "$row"
  if [[ "$excluded" == "true" ]]; then
    echo "skip [opted-out] ${ns}/${name}"
    opted_out=$((opted_out + 1))
    continue
  fi
  if [[ "$group" == "enabled" ]]; then
    echo "skip [already labeled] ${ns}/${name}"
    skipped=$((skipped + 1))
    continue
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "would label ${ns}/${name}"
  else
    echo "labeling ${ns}/${name}"
    kubectl label pvc "$name" -n "$ns" "$TARGET_LABEL" --overwrite
  fi
  changed=$((changed + 1))
done

echo
echo "Summary: changed=${changed} skipped=${skipped} opted-out=${opted_out}"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "(dry run — no changes applied; re-run without --dry-run to apply)"
fi
