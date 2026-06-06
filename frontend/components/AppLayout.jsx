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
    <div className="flex h-[100dvh] bg-slate-950 overflow-hidden font-sans">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
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

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden ambient-bg">
        <header
          className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl z-30 shrink-0"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center">
              <Menu size={14} className="text-white" />
            </div>
            <h2 className="text-lg font-bold gradient-text truncate">
              EcoPulse
            </h2>
          </div>
          <button
            type="button"
            onClick={openSidebar}
            className="touch-target p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
            aria-label="Open menu"
          >
            <Menu size={22} />
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
