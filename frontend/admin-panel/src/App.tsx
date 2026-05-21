import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TASK_CENTER_QUERY_KEY } from '@/hooks/use-task-center';
import Layout from '@/components/layout/Layout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import { NodeTerminalHost } from '@/components/NodeTerminalHost';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Tenants from '@/pages/Tenants';
import TenantDetail from '@/pages/TenantDetail';
import Domains from '@/pages/Domains';
import Monitoring from '@/pages/Monitoring';
import SystemBackups from '@/pages/SystemBackups';
import TenantBackups from '@/pages/TenantBackups';
import TenantBackupDetail from '@/pages/TenantBackupDetail';
import CronJobs from '@/pages/CronJobs';
import Settings from '@/pages/Settings';
import Applications from '@/pages/Applications';
import UserSettings from '@/pages/UserSettings';
import RedirectWithQuery from '@/components/RedirectWithQuery';
import DomainDetail from '@/pages/DomainDetail';
import OidcSettings from '@/pages/OidcSettings';
import DnsServers from '@/pages/DnsServers';
import PlanManagement from '@/pages/PlanManagement';
import BackupInfrastructure from '@/pages/BackupInfrastructure';
import RestoreCartPage from '@/pages/RestoreCart';
import AdminUsers from '@/pages/AdminUsers';
import HealthDashboard from '@/pages/HealthDashboard';
import ExportImport from '@/pages/ExportImport';
import EmailManagement from '@/pages/EmailManagement';
import TlsSettings from '@/pages/TlsSettings';
import SystemSettingsPage from '@/pages/SystemSettings';
import AuditLogs from '@/pages/AuditLogs';
import AiSettings from '@/pages/AiSettings';
import Placeholder from '@/pages/Placeholder';
import NodesAndStorage from '@/pages/NodesAndStorage';
import LoadBalancerSettings from '@/pages/LoadBalancerSettings';
import LifecycleHooksSettings from '@/pages/LifecycleHooksSettings';
import PrivateWorkerTunnelSettings from '@/pages/PrivateWorkerTunnelSettings';
import IdentityAndSessionsPage from '@/pages/IdentityAndSessionsPage';
import NetworkTrustPage from '@/pages/NetworkTrustPage';
import PosturePage from '@/pages/PosturePage';
import WebDefensePage from '@/pages/WebDefensePage';
import ErrorBoundary from '@/components/ErrorBoundary';

// MutationCache subscriber: refresh the Task Center chip after every
// successful mutation. Long-running ops register a `tasks` row inside
// their handler, so the chip needs to refetch right after the trigger
// resolves — without this, the row only appears on the next 3 s poll
// tick and the chip looks unresponsive. Per-mutation `onSuccess` opt-in
// would work too but is easy to forget; doing it once globally is the
// safer floor. The /me/tasks endpoint is small + per-user so the extra
// refetch is cheap.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      // Skip chip-internal mutations (clear/etc) to avoid refetch loops.
      const key = mutation.options.mutationKey;
      if (Array.isArray(key) && key[0] === 'task-center') return;
      void queryClient.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
    },
  }),
});

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                {/* App-level mount for the node-terminal host so its
                    modal + dock survive page navigation. Terminal
                    sessions started on one page stay alive when the
                    operator navigates elsewhere — the dock surfaces
                    them as restorable pills. */}
                <NodeTerminalHost />
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="tenants" element={<Tenants />} />
            <Route path="tenants/:id" element={<TenantDetail />} />
            <Route path="domains" element={<Domains />} />
            <Route path="tenants/:tenantId/domains/:domainId" element={<DomainDetail />} />
            <Route path="applications" element={<Applications />} />
            <Route path="backups/system" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><SystemBackups /></ProtectedRoute>} />
            <Route path="backups/tenants" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><TenantBackups /></ProtectedRoute>} />
            <Route path="backups/tenants/:tenantId" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><TenantBackupDetail /></ProtectedRoute>} />
            <Route path="cron-jobs" element={<CronJobs />} />
            {/* Security Hub (2026-05-21): /security top-level retired —
                the legacy mock page (hardcoded NETWORK_POLICIES array)
                is replaced by the new posture/network-trust/identity/
                web-defense sub-pages. Bare /security redirects to Posture. */}
            <Route path="security" element={<Navigate to="/security/posture" replace />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/system" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><SystemSettingsPage /></ProtectedRoute>} />
            <Route path="settings/oidc" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><OidcSettings /></ProtectedRoute>} />
            <Route path="settings/dns" element={<DnsServers />} />
            <Route path="settings/plans" element={<PlanManagement />} />
            <Route path="settings/tls" element={<TlsSettings />} />
            <Route path="settings/backup-infrastructure" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><BackupInfrastructure /></ProtectedRoute>} />
            {/* Restore Cart kept as drill-in flow off /backups/tenants/:id. */}
            <Route path="restore" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><RestoreCartPage /></ProtectedRoute>} />
            <Route path="nodes-and-storage" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><NodesAndStorage /></ProtectedRoute>} />
            {/* Legacy direct-link compatibility: redirect to the new top-level page with the matching tab pre-selected. */}
            <Route path="settings/nodes-and-storage" element={<Navigate to="/nodes-and-storage" replace />} />
            <Route path="settings/storage" element={<Navigate to="/nodes-and-storage?tab=storage" replace />} />
            <Route path="settings/nodes" element={<Navigate to="/nodes-and-storage?tab=nodes" replace />} />
            {/* Security Hub redirect (2026-05-21): admin users moved
                to /security/identity. */}
            <Route path="settings/users" element={<Navigate to="/security/identity" replace />} />
            <Route path="settings/export-import" element={<ProtectedRoute allowedRoles={['super_admin']}><ExportImport /></ProtectedRoute>} />
            <Route path="settings/load-balancer" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><LoadBalancerSettings /></ProtectedRoute>} />
            <Route path="monitoring/health" element={<HealthDashboard />} />
            <Route path="monitoring/audit-logs" element={<AuditLogs />} />
            <Route path="settings/email" element={<EmailManagement />} />
            <Route path="settings/ai" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><AiSettings /></ProtectedRoute>} />
            <Route path="settings/lifecycle-hooks" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><LifecycleHooksSettings /></ProtectedRoute>} />
            <Route path="system/private-worker-tunnels" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><PrivateWorkerTunnelSettings /></ProtectedRoute>} />
            {/* Security Hub redirects (2026-05-21): the legacy
                /settings/{cluster-network,security-hardening} URLs
                forward to the new canonical Hub paths, preserving
                ?tab=X via RedirectWithQuery for bookmarked sub-tabs.
                The WAF/Bans/Exclusions tabs moved off the legacy
                Security Hardening page onto /security/web-defense
                — for those three the query string semantics still
                match (same `tab` keys). */}
            <Route path="settings/cluster-network" element={<RedirectWithQuery to="/security/network-trust" />} />
            <Route path="settings/security-hardening" element={<RedirectWithQuery to="/security/posture" />} />
            {/* Canonical Security Hub routes. */}
            <Route path="security/posture" element={<ProtectedRoute allowedRoles={['super_admin']}><PosturePage /></ProtectedRoute>} />
            <Route path="security/network-trust" element={<ProtectedRoute allowedRoles={['super_admin']}><NetworkTrustPage /></ProtectedRoute>} />
            <Route path="security/identity" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><IdentityAndSessionsPage /></ProtectedRoute>} />
            <Route path="security/web-defense" element={<ProtectedRoute allowedRoles={['super_admin']}><WebDefensePage /></ProtectedRoute>} />
            <Route path="user-settings" element={<UserSettings />} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
