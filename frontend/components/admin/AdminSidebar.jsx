import React, { memo } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { X, LogOut, ArrowLeft, ShieldCheck, Zap } from 'lucide-react';
import { ADMIN_NAV_LINKS } from '../../utils/adminNav';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import RoleBadge from './RoleBadge';

const AdminSidebar = memo(function AdminSidebar({ onClose }) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    toast.info('Signed out successfully');
  };

  return (
    <aside className="h-full flex flex-col bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 backdrop-blur-xl border-r border-slate-700/40 shadow-2xl shadow-black/30">
      <div className="p-6 flex items-center justify-between border-b border-slate-700/30">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center shadow-lg ring-1 ring-emerald-500/30">
              <ShieldCheck size={18} className="text-emerald-400" />
            </div>
            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full animate-pulse-glow" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-bold gradient-text tracking-tight leading-none">
              Admin Console
            </h2>
            <span className="text-[11px] text-slate-500 mt-1">EcoPulse Ops</span>
          </div>
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
          Operations
        </p>
        {ADMIN_NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-3.5 px-3.5 py-3 min-h-[44px] rounded-xl transition-all duration-200 group relative ${
                isActive
                  ? 'bg-emerald-500/10 text-emerald-400 font-semibold before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-emerald-400 before:rounded-full'
                  : 'text-slate-400 hover:bg-slate-700/40 hover:text-slate-200'
              }`
            }
          >
            <div className="transition-transform duration-200 group-hover:scale-110">
              {link.icon}
            </div>
            <span className="text-sm tracking-wide">{link.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-700/30 space-y-3">
        <button
          type="button"
          onClick={() => {
            onClose?.();
            navigate('/');
          }}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-slate-400 hover:bg-slate-700/40 hover:text-slate-200 transition-all duration-200 group"
        >
          <div className="transition-transform duration-200 group-hover:scale-110">
            <ArrowLeft size={20} />
          </div>
          <span className="text-sm tracking-wide">Back to app</span>
        </button>

        {user && (
          <div className="bg-slate-800/60 rounded-xl p-3.5 border border-slate-700/40 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="bg-gradient-to-br from-emerald-400/20 to-cyan-400/10 p-2 rounded-lg text-emerald-400 flex-shrink-0">
                <Zap size={16} />
              </div>
              <div className="truncate">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                  <RoleBadge role={user.role} />
                </div>
                <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="touch-target p-2 text-slate-500 hover:text-red-400 hover:bg-slate-800/60 rounded-lg transition-colors flex-shrink-0"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
});

export default AdminSidebar;
