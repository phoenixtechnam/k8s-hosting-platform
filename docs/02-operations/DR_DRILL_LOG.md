# DR Drill Log

Record each cold-restore drill here. One entry per drill. Oldest at the
bottom.

## Template

Copy-paste when starting a drill:

```markdown
### <YYYY-MM-DD> — <staging|production> drill

- **Operator:** <name / handle>
- **Source cluster:** <staging.phoenix-host.net / prod.phoenix-host.net>
- **Drill target VM:** <provider / spec / region>
- **Backup source:** s3://... or ssh://...
- **Backup age (newest artefact):** <age1...>
- **k3s version backed up / drill:** <vX / vY>

**Timing:**
- T+0    — VM provisioned
- T+?m   — bootstrap.sh complete
- T+?m   — dr-restore.sh start
- T+?m   — etcd restore done
- T+?m   — Postgres restore done
- T+?m   — secrets applied
- T+?m   — BackupTarget Available
- T+?m   — first tenant PVC restored
- T+?m   — smoke-test green
- **RTO total: ?m**

**Evidence:**
- [ ] `aws s3 ls` returns <N> backup artefacts for the day
- [ ] smoke-test.sh exits 0
- [ ] tenant `example.com` returns HTTP 200
- [ ] tenant data SHA256 matches pre-drill value
- [ ] mail round-trip: sent email visible post-restore
- [ ] Postgres row count (`clients`): <N> pre, <N> post

**Bugs found:**
- <short description — one line each>
- <open follow-up ticket with link>

**Verdict:** <PASS / PARTIAL / FAIL>

**Notes:**
<free-form observations, improvement ideas>
```

---

## Drill entries

<!-- Newest first. Paste the template above each new drill. -->

(No drills recorded yet. Phase M6 drill is the first — append when
completed.)
