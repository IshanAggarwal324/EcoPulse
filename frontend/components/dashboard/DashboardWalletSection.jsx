import React, { memo } from 'react';
import WalletConnect from '../WalletConnect';
import BlockchainStatus from '../BlockchainStatus';

const DashboardWalletSection = memo(function DashboardWalletSection() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <WalletConnect />
      <BlockchainStatus />
    </div>
  );
});

export default DashboardWalletSection;
