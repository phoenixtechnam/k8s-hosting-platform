/**
 * DR Drill tab — Phase 5.
 *
 * Self-service runbook view. The drill itself is operator-driven from
 * the CLI (`scripts/integration-system-dr-drill.sh`) because it
 * requires SSH access to a target VM, wipes that VM, and runs
 * bootstrap.sh end-to-end. Wiring it as an in-product action would
 * require giving the API SSH credentials to a target VM — out of
 * scope for the threat model.
 *
 * This tab documents the runbook and surfaces the four artifacts the
 * operator needs (current secrets-bundle export status + most recent
 * pg_dump per cluster). Click-through links to the relevant tabs.
 */

import { Activity, AlertCircle, ExternalLink, Terminal } from 'lucide-react';

export default function DrDrillTab() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Activity size={20} /> DR Drill
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Cold-restore the entire platform onto a fresh VM from System Backup
          artifacts. Runbook + harness validate that the Phase 1+2+4b chain
          actually recovers.
        </p>
      </header>

      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Recovery sources required
        </h3>
        <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1.5 list-disc pl-5">
          <li><strong>Secrets bundle</strong> (Phase 1) — age-encrypted tarball + the operator's age private key</li>
          <li><strong>Platform pg_dump</strong> (Phase 2) — most recent succeeded run for <code>platform/postgres</code></li>
          <li><strong>Mail pg_dump</strong> (Phase 2) — most recent succeeded run for <code>mail/mail-pg</code></li>
          <li><strong>WAL archive</strong> (Phase 4) — optional, for sub-snapshot RPO via PITR</li>
        </ul>
      </section>

      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Terminal size={14} /> Operator-driven runbook
        </h3>
        <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-2 list-decimal pl-5">
          <li>Fresh Debian/Ubuntu VM with SSH access; install <code>git</code></li>
          <li><code className="text-xs bg-gray-100 dark:bg-gray-900 px-1 py-0.5 rounded">git clone</code> the platform repo</li>
          <li>
            <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1 py-0.5 rounded">
              bash scripts/bootstrap.sh --join-as server --env staging --domain &lt;DOMAIN&gt; --secrets-bundle &lt;bundle&gt; --age-key &lt;key&gt;
            </code>
          </li>
          <li>Tag the node: <code className="text-xs">kubectl label nodes --all platform.phoenix-host.net/node-role=server --overwrite</code></li>
          <li>Tag Longhorn node: <code className="text-xs">kubectl -n longhorn-system patch nodes.longhorn.io/&lt;name&gt; --type=merge -p '{`{"spec":{"tags":["system"]}}`}'</code></li>
          <li>Wait for CNPG clusters to reach <code>Cluster in healthy state</code> (≤15 min)</li>
          <li>Restore platform: <code className="text-xs">kubectl -n platform exec postgres-1 -c postgres -- pg_restore --clean --if-exists -d hosting_platform &lt; platform.pgdump</code></li>
          <li>Restore mail: <code className="text-xs">kubectl -n mail exec mail-pg-1 -c postgres -- pg_restore --clean --if-exists -d stalwart_app &lt; mail.pgdump</code></li>
          <li>Rewrite system_settings to new domain: <code className="text-xs">bash scripts/admin-domain-rewrite.sh --domain &lt;new-apex&gt;</code> (bumps platform-api automatically)</li>
          <li>Verify admin login on the restored cluster</li>
        </ol>
        <p className="text-xs text-gray-500 dark:text-gray-400 pt-1">
          Automated harness: <code>scripts/integration-system-dr-drill.sh</code>
        </p>
      </section>

      <section className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/20 p-5 space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          <AlertCircle size={14} /> Verified caveats (from 2026-05-06 drill)
        </h3>
        <ul className="text-sm text-amber-800 dark:text-amber-300 space-y-1 list-disc pl-5">
          <li>The fresh VM needs <code>git</code> installed before bootstrap</li>
          <li>K8s + Longhorn node tags must be applied manually before CNPG provisions PVCs (otherwise <code>longhorn-system-local</code> SC has no eligible nodes)</li>
          <li>pg_dump runs from the platform-api image with pg_dump v17 (matches platform/postgres 17.5). It can EXPORT from mail-pg's 16.9 server, but the resulting archive's format isn't readable by pg_restore 16 — mail-pg in-place restore requires running <code>pg_restore</code> from inside the mail-pg pod (its own pg_restore is version-matched). The DR drill harness does this via <code>kubectl exec</code>.</li>
          <li>After pg_restore, run <code>scripts/admin-domain-rewrite.sh --domain &lt;new-apex&gt;</code> to rewrite <code>system_settings.admin_panel_url</code> et al. to your target domain (the dump carries the source's domain — without rewriting, the ingress-reconciler keeps reasserting it)</li>
        </ul>
      </section>

      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <ExternalLink size={14} /> Related tabs
        </h3>
        <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1 list-disc pl-5">
          <li>Secrets Bundle — export the bundle for step 3</li>
          <li>System Databases — trigger fresh pg_dumps + download the artifacts for steps 7-8</li>
          <li>WAL Archive — verify continuous archive is on for sub-snapshot RPO</li>
        </ul>
      </section>
    </div>
  );
}
