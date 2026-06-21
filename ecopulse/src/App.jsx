import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../../frontend/components/AppLayout';
import PageLoader from '../../frontend/components/ui/PageLoader';

import { AuthProvider } from '../../frontend/context/AuthContext';
import { ToastProvider } from '../../frontend/context/ToastContext';
import { WalletProvider } from '../../frontend/context/WalletContext';
import { SocketProvider } from '../../frontend/context/SocketContext';
import SessionBridge from '../../frontend/components/SessionBridge';
import ProtectedRoute from '../../frontend/components/ProtectedRoute';
import GuestRoute from '../../frontend/components/GuestRoute';
import Login from '../../frontend/pages/Login';
import Register from '../../frontend/pages/Register';
import VerifyEmail from '../../frontend/pages/VerifyEmail';

const AssistantChat = lazy(() => import('../../frontend/components/assistant/AssistantChat'));

const Dashboard = lazy(() => import('../../frontend/pages/Dashboard'));
const Trading = lazy(() => import('../../frontend/pages/Trading'));
const AutoTrading = lazy(() => import('../../frontend/pages/AutoTrading'));
const CarbonTransactions = lazy(() => import('../../frontend/pages/CarbonTransactions'));
const Forecasts = lazy(() => import('../../frontend/pages/Forecasts'));
const Credits = lazy(() => import('../../frontend/pages/Credits'));
const Settings = lazy(() => import('../../frontend/pages/Settings'));

const AdminHome = lazy(() => import('../../frontend/pages/admin/AdminHome'));
const AdminUsers = lazy(() => import('../../frontend/pages/admin/Users'));
const AdminNodes = lazy(() => import('../../frontend/pages/admin/Nodes'));
const AdminTrades = lazy(() => import('../../frontend/pages/admin/Trades'));
const AdminReportJobs = lazy(() => import('../../frontend/pages/admin/ReportJobs'));
const AdminSyncStatus = lazy(() => import('../../frontend/pages/admin/SyncStatus'));
const AdminAuditLogs = lazy(() => import('../../frontend/pages/admin/AuditLogs'));
const AdminHealth = lazy(() => import('../../frontend/pages/admin/Health'));
const AdminSimulator = lazy(() => import('../../frontend/pages/admin/Simulator'));
const AdminIngestion = lazy(() => import('../../frontend/pages/admin/Ingestion'));

import AdminLayout from '../../frontend/components/admin/AdminLayout';

function AuthenticatedApp() {
  return (
    <SocketProvider>
      <SessionBridge />
      <ProtectedRoute>
        <Routes>
          {/* Admin section — distinct layout, role-gated (admin / moderator) */}
          <Route
            element={
              <ProtectedRoute roles={['admin', 'moderator']}>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/admin" element={<AdminHome />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/nodes" element={<AdminNodes />} />
            <Route path="/admin/trades" element={<AdminTrades />} />
            <Route path="/admin/report-jobs" element={<AdminReportJobs />} />
            <Route path="/admin/sync" element={<AdminSyncStatus />} />
            <Route path="/admin/audit-logs" element={<AdminAuditLogs />} />
            <Route path="/admin/health" element={<AdminHealth />} />
            <Route path="/admin/simulator" element={<AdminSimulator />} />
            <Route path="/admin/ingestion" element={<AdminIngestion />} />
          </Route>

          {/* User section */}
          <Route
            path="/*"
            element={
              <>
                <AppLayout>
                  <Suspense fallback={<PageLoader message="Loading page..." />}>
                    <Routes>
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/trading" element={<Trading />} />
                      <Route path="/auto-trading" element={<AutoTrading />} />
                      <Route path="/transactions" element={<CarbonTransactions />} />
                      <Route path="/forecasts" element={<Forecasts />} />
                      <Route path="/credits" element={<Credits />} />
                      <Route path="/settings" element={<Settings />} />
                    </Routes>
                  </Suspense>
                </AppLayout>
                <Suspense fallback={null}>
                  <AssistantChat />
                </Suspense>
              </>
            }
          />
        </Routes>
      </ProtectedRoute>
    </SocketProvider>
  );
}

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<GuestRoute><Login /></GuestRoute>} />
            <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route
              path="/*"
              element={
                <WalletProvider>
                  <AuthenticatedApp />
                </WalletProvider>
              }
            />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
