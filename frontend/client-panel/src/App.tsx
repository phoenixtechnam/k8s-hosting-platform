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
import UserSettings from '@/pages/UserSettings';
import DomainDetail from '@/pages/DomainDetail';
import SubUsers from '@/pages/SubUsers';
import Placeholder from '@/pages/Placeholder';

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
            <Route path="domains" element={<Domains />} />
            <Route path="domains/:domainId" element={<DomainDetail />} />
            <Route path="applications" element={<Applications />} />
            <Route path="cron-jobs" element={<CronJobs />} />
            <Route path="files" element={<Files />} />
            <Route path="email" element={<Email />} />
            <Route path="backups" element={<Backups />} />
            <Route path="users" element={<SubUsers />} />
            <Route path="settings" element={<Settings />} />
            <Route path="user-settings" element={<UserSettings />} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
