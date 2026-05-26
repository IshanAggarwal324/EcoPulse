import React from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loader2, ShieldAlert } from 'lucide-react';

const ProtectedRoute = ({ children, roles }) => {
  const { user, loading, isAuthenticated, accessToken } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-slate-900 gap-3 px-4">
        <Loader2 className="h-8 w-8 text-emerald-500 animate-spin" />
        <p className="text-slate-400 text-sm">Verifying session...</p>
      </div>
    );
  }

  if (!isAuthenticated || !accessToken || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (roles?.length && !roles.includes(user.role)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 gap-4 px-4">
        <ShieldAlert className="h-12 w-12 text-amber-400" />
        <h2 className="text-xl font-bold text-white">Access denied</h2>
        <p className="text-slate-400 text-center max-w-md">
          Your account does not have permission to view this page.
        </p>
        <Link
          to="/"
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return children;
};

export default ProtectedRoute;
