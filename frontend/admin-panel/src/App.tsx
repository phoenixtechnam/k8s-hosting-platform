import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from '@/components/layout/Layout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Clients from '@/pages/Clients';
import ClientDetail from '@/pages/ClientDetail';
import Domains from '@/pages/Domains';
import Monitoring from '@/pages/Monitoring';
import Storage from '@/pages/Storage';
import CronJobs from '@/pages/CronJobs';
import Settings from '@/pages/Settings';
import Applications from '@/pages/Applications';
import Security from '@/pages/Security';
import UserSettings from '@/pages/UserSettings';
import DomainDetail from '@/pages/DomainDetail';
import OidcSettings from '@/pages/OidcSettings';
import DnsServers from '@/pages/DnsServers';
import PlanManagement from '@/pages/PlanManagement';
import BackupSettings from '@/pages/BackupSettings';
import AdminUsers from '@/pages/AdminUsers';
import HealthDashboard from '@/pages/HealthDashboard';
import ExportImport from '@/pages/ExportImport';
import EmailManagement from '@/pages/EmailManagement';
import TlsSettings from '@/pages/TlsSettings';
import AuditLogs from '@/pages/AuditLogs';
import Placeholder from '@/pages/Placeholder';
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
            <Route index element={<Dashboard />} />
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientDetail />} />
            <Route path="domains" element={<Domains />} />
            <Route path="clients/:clientId/domains/:domainId" element={<DomainDetail />} />
            <Route path="applications" element={<Applications />} />
            <Route path="storage" element={<Storage />} />
            <Route path="cron-jobs" element={<CronJobs />} />
            <Route path="security" element={<Security />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/oidc" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><OidcSettings /></ProtectedRoute>} />
            <Route path="settings/dns" element={<DnsServers />} />
            <Route path="settings/plans" element={<PlanManagement />} />
            <Route path="settings/tls" element={<TlsSettings />} />
            <Route path="settings/backups" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><BackupSettings /></ProtectedRoute>} />
            <Route path="settings/users" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><AdminUsers /></ProtectedRoute>} />
            <Route path="settings/export-import" element={<ProtectedRoute allowedRoles={['super_admin']}><ExportImport /></ProtectedRoute>} />
            <Route path="monitoring/health" element={<HealthDashboard />} />
            <Route path="monitoring/audit-logs" element={<AuditLogs />} />
            <Route path="settings/email" element={<EmailManagement />} />
            <Route path="user-settings" element={<UserSettings />} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
