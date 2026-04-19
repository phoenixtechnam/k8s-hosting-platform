import { useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import Footer from './Footer';
import UpdateBanner from '../UpdateBanner';
import SystemHealthBanner from '../SystemHealthBanner';
import { useTokenRefresh } from '@/hooks/use-token-refresh';
import { useDocumentTitle } from '@/hooks/use-system-info';

export default function Layout() {
  useTokenRefresh();
  // Keep <title> in sync with the platform name. Individual pages can still
  // call useDocumentTitle('Something') to prepend a page-specific prefix.
  useDocumentTitle();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900" data-testid="layout">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={openSidebar} />
        <SystemHealthBanner />
        <UpdateBanner />

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
