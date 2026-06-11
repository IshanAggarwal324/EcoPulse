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
import AssistantChat from '../../frontend/components/assistant/AssistantChat';

const Dashboard = lazy(() => import('../../frontend/pages/Dashboard'));
const Trading = lazy(() => import('../../frontend/pages/Trading'));
const CarbonTransactions = lazy(() => import('../../frontend/pages/CarbonTransactions'));
const Forecasts = lazy(() => import('../../frontend/pages/Forecasts'));
const Credits = lazy(() => import('../../frontend/pages/Credits'));
const Settings = lazy(() => import('../../frontend/pages/Settings'));

function AuthenticatedApp() {
  return (
    <SocketProvider>
      <SessionBridge />
      <ProtectedRoute>
        <AppLayout>
          <Suspense fallback={<PageLoader message="Loading page..." />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/trading" element={<Trading />} />
              <Route path="/transactions" element={<CarbonTransactions />} />
              <Route path="/forecasts" element={<Forecasts />} />
              <Route path="/credits" element={<Credits />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Suspense>
        </AppLayout>
        <AssistantChat />
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
