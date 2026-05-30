import React, { memo } from 'react';
import WalletConnect from '../WalletConnect';
import BlockchainStatus from '../BlockchainStatus';

/** Isolated from dashboard data updates (summary / live readings). */
const DashboardWalletSection = memo(function DashboardWalletSection() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <WalletConnect />
      <BlockchainStatus />
    </div>
  );
});

export default DashboardWalletSection;
