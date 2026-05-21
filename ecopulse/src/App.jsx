import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../../frontend/components/AppLayout';
import Dashboard from '../../frontend/pages/Dashboard';
import Trading from '../../frontend/pages/Trading';
import Forecasts from '../../frontend/pages/Forecasts';
import Credits from '../../frontend/pages/Credits';
import Settings from '../../frontend/pages/Settings';

function App() {
  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/trading" element={<Trading />} />
          <Route path="/forecasts" element={<Forecasts />} />
          <Route path="/credits" element={<Credits />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}

export default App;
