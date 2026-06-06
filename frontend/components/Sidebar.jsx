import React, { memo } from 'react';
import { NavLink } from 'react-router-dom';
import { X, LogOut, User, Zap } from 'lucide-react';
import { NAV_LINKS } from '../utils/constants';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const Sidebar = memo(function Sidebar({ onClose }) {
  const { user, logout } = useAuth();
  const toast = useToast();

  return (
    <aside className="h-full flex flex-col bg-gradient-to-b from-slate-800/95 via-slate-850 to-slate-900/95 backdrop-blur-xl border-r border-slate-700/40 shadow-2xl shadow-black/20">
      <div className="p-6 flex items-center justify-between border-b border-slate-700/30">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap size={18} className="text-white" />
            </div>
            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full animate-pulse-glow" />
          </div>
          <h2 className="text-xl font-bold gradient-text tracking-tight">
            EcoPulse
          </h2>
        </div>
        <button
          onClick={onClose}
          className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 transition-all duration-200"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto custom-scrollbar">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500 px-3 mb-2">
          Navigation
        </p>
        {NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-3.5 px-3.5 py-3 min-h-[44px] rounded-xl transition-all duration-200 group relative ${
                isActive
                  ? 'bg-emerald-500/10 text-emerald-400 font-semibold before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-emerald-400 before:rounded-full'
                  : 'text-slate-400 hover:bg-slate-700/40 hover:text-slate-200'
              }`
            }
          >
            <div className={`transition-transform duration-200 group-hover:scale-110 ${''}`}>
              {link.icon}
            </div>
            <span className="text-sm tracking-wide">{link.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-700/30 space-y-3">
        {user && (
          <div className="bg-slate-900/60 rounded-xl p-3.5 border border-slate-700/40 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="bg-gradient-to-br from-emerald-400/20 to-cyan-400/10 p-2 rounded-lg text-emerald-400 flex-shrink-0">
                <User size={16} />
              </div>
              <div className="truncate">
                <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                logout();
                toast.info('Signed out successfully');
              }}
              className="touch-target p-2 text-slate-500 hover:text-red-400 hover:bg-slate-800/60 rounded-lg transition-colors flex-shrink-0"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}

        <div className="bg-slate-900/40 rounded-xl p-3.5 border border-slate-700/30">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">Network</p>
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-medium text-emerald-400">Online</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
});

export default Sidebar;
