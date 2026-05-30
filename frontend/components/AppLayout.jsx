import React, { useState, useEffect, memo } from 'react';
import Sidebar from './Sidebar';
import { Menu } from 'lucide-react';

const AppLayout = memo(function AppLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [sidebarOpen]);

  const closeSidebar = () => setSidebarOpen(false);
  const openSidebar = () => setSidebarOpen(true);

  return (
    <div className="flex h-[100dvh] bg-slate-900 overflow-hidden font-sans">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 w-[min(18rem,85vw)] transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 lg:w-72 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar onClose={closeSidebar} />
      </div>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-900">
        <header
          className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md z-30 shrink-0"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <h2 className="text-lg sm:text-xl font-bold bg-gradient-to-r from-emerald-400 to-blue-500 bg-clip-text text-transparent truncate">
            EcoPulse
          </h2>
          <button
            type="button"
            onClick={openSidebar}
            className="touch-target p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Open menu"
          >
            <Menu size={24} />
          </button>
        </header>

        <main
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 custom-scrollbar"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-7xl mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
});

export default AppLayout;
