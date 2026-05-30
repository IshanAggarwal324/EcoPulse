import React, { memo } from 'react';
import { NavLink } from 'react-router-dom';
import { X, LogOut, User } from 'lucide-react';
import { NAV_LINKS } from '../utils/constants';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const Sidebar = memo(function Sidebar({ onClose }) {
  const { user, logout } = useAuth();
  const toast = useToast();

  return (
    <aside className="h-full flex flex-col bg-slate-800 border-r border-slate-700 shadow-2xl">
      <div className="p-6 flex items-center justify-between border-b border-slate-700/50">
        <h2 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-blue-500 bg-clip-text text-transparent tracking-tight">
          EcoPulse
        </h2>
        {/* Mobile close button */}
        <button 
          onClick={onClose}
          className="lg:hidden p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
        >
          <X size={20} />
        </button>
      </div>
      
      <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
        {NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-4 px-4 py-3.5 min-h-[48px] rounded-xl transition-all duration-300 group ${
                isActive 
                  ? 'bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]' 
                  : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
              }`
            }
          >
            <div className={`transition-transform duration-300 group-hover:scale-110`}>
              {link.icon}
            </div>
            <span className="text-[15px] tracking-wide">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      
      <div className="p-4 border-t border-slate-700/50 space-y-4">
        {user && (
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="bg-emerald-500/20 p-2 rounded-full text-emerald-400 flex-shrink-0">
                <User size={18} />
              </div>
              <div className="truncate">
                <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                <p className="text-xs text-slate-400 truncate">{user.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                logout();
                toast.info('Signed out successfully');
              }}
              className="touch-target p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors flex-shrink-0"
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          </div>
        )}

        <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700">
          <p className="text-xs text-slate-400 mb-1">Network Status</p>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="text-sm font-medium text-emerald-400">Connected</span>
          </div>
        </div>
      </div>
    </aside>
  );
});

export default Sidebar;
