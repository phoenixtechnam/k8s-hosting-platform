# ADR-041 follow-up: P0 spike — exec re-attach semantics

**Date:** 2026-05-20
**Spike status:** PASS — proceed to P1/P2.

## Question

When a SECOND `Exec.exec()` call is made into a TTY container while a
FIRST exec stream is still active, what does the kubelet do?

The DB-backed session refactor (Option B from the
`/plan` for reconnect+stickiness) depends on this answer: any
platform-api replica must be able to attach to a still-running
privileged Pod by issuing its own `exec.exec()`, regardless of which
replica created the original exec stream.

## Method

Two concurrent `kubectl exec -i spike-reattach -- /bin/sh` calls
against a single alpine Pod in the local DinD cluster, each with its
own stdin/stdout. Sent `echo HELLO_FROM_A_PID_$$` on stream A and
`echo HELLO_FROM_B_PID_$$` on stream B. Captured each stream's output
separately.

## Result

```
=== A captured stdout ===
HELLO_FROM_A_PID_7
TAG_A_12613

=== B captured stdout ===
HELLO_FROM_B_PID_13
TAG_B_30821
```

- **Independent PIDs** — stream A's bash was PID 7, stream B's was
  PID 13. Each exec creates a fresh process group inside the
  container.
- **Independent PTYs** — no stdout cross-contamination; A's stream
  saw zero bytes from B, and vice-versa.
- **No rejection** — kubelet happily granted both concurrent execs.

## Verdict

Sequential `exec.exec()` calls into the same Pod/container yield
completely isolated bash processes with their own PTYs. The implication
for our use case:

1. **Re-attach on a different replica works "for free."** When a
   platform-api replica fetches a session row from the DB and runs
   `exec.exec()` against the recorded `podName`, it gets a brand-new
   bash. The user sees a fresh prompt — *shell state from the prior
   replica's exec stream is NOT preserved* (cwd, env, foreground
   process belong to the dead-or-still-running other bash).

2. **Scrollback IS preserved** — but only because xterm scrollback
   lives in the browser, not on the server.

3. **Original stream survives.** If the original platform-api replica
   is still alive (e.g. operator hits Reconnect after a transient
   WS drop, not a replica failure), the original bash keeps running
   in parallel. This is harmless — when the old WS handle is closed
   by the replica's `finalize()`, its bash gets SIGHUP and exits.

4. **No "kill prior stream first" step needed in P2.** The fresh
   exec is independent; no coordination required.

## Communication to operator (UX note)

When the operator clicks Reconnect, the title bar will show "Reconnecting…"
briefly, then the terminal will write a one-line yellow banner:

```
[reconnected — shell state may be fresh; scrollback preserved]
```

so they know not to expect their previous `cd /var/log/foo` to still
be in effect.

## Decision

**Proceed to P1/P2 as planned.** No fallback strategy needed — the
naive "open a fresh exec" path is exactly what we want.
