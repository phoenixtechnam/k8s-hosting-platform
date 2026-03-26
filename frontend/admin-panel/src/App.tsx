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
import Workloads from '@/pages/Workloads';
import Security from '@/pages/Security';
import UserSettings from '@/pages/UserSettings';
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
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientDetail />} />
            <Route path="domains" element={<Domains />} />
            <Route path="workloads" element={<Workloads />} />
            <Route path="storage" element={<Storage />} />
            <Route path="cron-jobs" element={<CronJobs />} />
            <Route path="security" element={<Security />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="settings" element={<Settings />} />
            <Route path="user-settings" element={<UserSettings />} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
