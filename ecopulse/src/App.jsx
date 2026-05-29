import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../../frontend/components/AppLayout';
import Dashboard from '../../frontend/pages/Dashboard';
import Trading from '../../frontend/pages/Trading';
import CarbonTransactions from '../../frontend/pages/CarbonTransactions';
import Forecasts from '../../frontend/pages/Forecasts';
import Credits from '../../frontend/pages/Credits';
import Settings from '../../frontend/pages/Settings';

import { AuthProvider } from '../../frontend/context/AuthContext';
import { ToastProvider } from '../../frontend/context/ToastContext';
import { WalletProvider } from '../../frontend/context/WalletContext';
import SessionBridge from '../../frontend/components/SessionBridge';
import ProtectedRoute from '../../frontend/components/ProtectedRoute';
import GuestRoute from '../../frontend/components/GuestRoute';
import Login from '../../frontend/pages/Login';
import Register from '../../frontend/pages/Register';

function App() {
  return (
    <ToastProvider>
    <AuthProvider>
    <WalletProvider>
      <SessionBridge />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<GuestRoute><Login /></GuestRoute>} />
          <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/trading" element={<Trading />} />
                    <Route path="/transactions" element={<CarbonTransactions />} />
                    <Route path="/forecasts" element={<Forecasts />} />
                    <Route path="/credits" element={<Credits />} />
                    <Route path="/settings" element={<Settings />} />
                  </Routes>
                </AppLayout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </WalletProvider>
    </AuthProvider>
    </ToastProvider>
  );
}

export default App;
