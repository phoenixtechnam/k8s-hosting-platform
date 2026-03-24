import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from '@/components/layout/Layout';
import Dashboard from '@/pages/Dashboard';
import Clients from '@/pages/Clients';
import ClientDetail from '@/pages/ClientDetail';
import Placeholder from '@/pages/Placeholder';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="clients" element={<Clients />} />
          <Route path="clients/:id" element={<ClientDetail />} />
          <Route path="domains" element={<Placeholder title="Domains" />} />
          <Route path="workloads" element={<Placeholder title="Workloads" />} />
          <Route path="storage" element={<Placeholder title="Storage & DB" />} />
          <Route path="security" element={<Placeholder title="Security" />} />
          <Route path="monitoring" element={<Placeholder title="Monitoring" />} />
          <Route path="settings" element={<Placeholder title="Settings" />} />
          <Route path="*" element={<Placeholder title="Page Not Found" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
