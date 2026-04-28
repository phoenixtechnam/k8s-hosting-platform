import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from '@/components/layout/Layout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Domains from '@/pages/Domains';
import Applications from '@/pages/Applications';
import CronJobs from '@/pages/CronJobs';
import Backups from '@/pages/Backups';
import Email from '@/pages/Email';
import Files from '@/pages/Files';
import Settings from '@/pages/Settings';
import OidcProviders from '@/pages/settings/OidcProviders';
import MtlsProviders from '@/pages/settings/MtlsProviders';
import OpenZitiProviders from '@/pages/settings/OpenZitiProviders';
import ZrokProviders from '@/pages/settings/ZrokProviders';
import UserSettings from '@/pages/UserSettings';
import DomainDetail from '@/pages/DomainDetail';
import RouteDetail from '@/pages/RouteDetail';
import SubUsers from '@/pages/SubUsers';
import DatabaseManager from '@/pages/DatabaseManager';
import SshKeys from '@/pages/SshKeys';
import SftpUsers from '@/pages/SftpUsers';
import ResourceUsage from '@/pages/ResourceUsage';
import Notifications from '@/pages/Notifications';
import Placeholder from '@/pages/Placeholder';
import LifecycleGate from '@/components/LifecycleGate';
import ErrorBoundary from '@/components/ErrorBoundary';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
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
                <Layout />
              </ProtectedRoute>
            }
          >
            {/* Always-allowed routes (admin/user-facing account info that stays
                visible during suspension):
                  Dashboard — overall state summary
                  settings — subscription details
                  notifications — account notifications
                  user-settings — profile/password
                  resource-usage — read-only metrics  */}
            <Route index element={<Dashboard />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/oidc-providers" element={<OidcProviders />} />
            <Route path="settings/mtls-providers" element={<MtlsProviders />} />
            <Route path="settings/openziti-providers" element={<OpenZitiProviders />} />
            <Route path="settings/zrok-providers" element={<ZrokProviders />} />
            <Route path="resource-usage" element={<ResourceUsage />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="user-settings" element={<UserSettings />} />

            {/* Gated routes (blocked on suspend/archived, or during any
                non-idle storage lifecycle op). */}
            <Route path="domains" element={<LifecycleGate><Domains /></LifecycleGate>} />
            <Route path="domains/:domainId" element={<LifecycleGate><DomainDetail /></LifecycleGate>} />
            <Route path="domains/:domainId/routes/:routeId" element={<LifecycleGate><RouteDetail /></LifecycleGate>} />
            <Route path="applications" element={<LifecycleGate><Applications /></LifecycleGate>} />
            <Route path="cron-jobs" element={<LifecycleGate><CronJobs /></LifecycleGate>} />
            <Route path="files" element={<LifecycleGate><Files /></LifecycleGate>} />
            <Route path="email" element={<LifecycleGate><Email /></LifecycleGate>} />
            <Route path="backups" element={<LifecycleGate><Backups /></LifecycleGate>} />
            <Route path="users" element={<LifecycleGate><SubUsers /></LifecycleGate>} />
            <Route path="ssh-keys" element={<LifecycleGate><SshKeys /></LifecycleGate>} />
            <Route path="sftp" element={<LifecycleGate><SftpUsers /></LifecycleGate>} />
            <Route path="database-manager" element={<LifecycleGate><DatabaseManager /></LifecycleGate>} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
