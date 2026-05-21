import React from 'react';
import { LayoutDashboard, ArrowRightLeft, TrendingUp, Award, Settings } from 'lucide-react';

export const NAV_LINKS = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={20} /> },
  { to: '/trading', label: 'Trading', icon: <ArrowRightLeft size={20} /> },
  { to: '/forecasts', label: 'Forecasts', icon: <TrendingUp size={20} /> },
  { to: '/credits', label: 'Credits', icon: <Award size={20} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={20} /> },
];
