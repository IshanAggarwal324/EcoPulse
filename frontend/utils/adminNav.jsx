import React from 'react';
import {
  LayoutDashboard,
  Users as UsersIcon,
  Server,
  ArrowRightLeft,
  FileText,
  RefreshCw,
  ScrollText,
  Activity,
} from 'lucide-react';

export const ADMIN_ROLES = ['admin', 'moderator'];

export const ADMIN_NAV_LINKS = [
  { to: '/admin', label: 'Overview', icon: <LayoutDashboard size={20} />, end: true },
  { to: '/admin/users', label: 'Users', icon: <UsersIcon size={20} /> },
  { to: '/admin/nodes', label: 'Nodes', icon: <Server size={20} /> },
  { to: '/admin/trades', label: 'Trades', icon: <ArrowRightLeft size={20} /> },
  { to: '/admin/report-jobs', label: 'Report Jobs', icon: <FileText size={20} /> },
  { to: '/admin/sync', label: 'Sync Status', icon: <RefreshCw size={20} /> },
  { to: '/admin/audit-logs', label: 'Audit Logs', icon: <ScrollText size={20} /> },
  { to: '/admin/health', label: 'System Health', icon: <Activity size={20} /> },
];

export const hasAdminAccess = (user) =>
  !!user && ADMIN_ROLES.includes(user.role);

export const canMutate = (user) => !!user && user.role === 'admin';
