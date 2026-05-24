import React from 'react';

const BlockchainStatus = ({ latestBlock, networkId }) => {
  return (
    <div className="blockchain-status p-4 border rounded shadow-sm bg-white dark:bg-gray-800 mt-4">
      <h3 className="text-lg font-bold mb-2">Blockchain Status</h3>
      <div className="flex flex-col space-y-1">
        <p><span className="font-semibold">Network:</span> {networkId ? `Chain ID ${networkId}` : 'Not Connected'}</p>
        <p><span className="font-semibold">Latest Block:</span> {latestBlock || 'N/A'}</p>
        <p className="text-sm text-gray-500 italic">Live transaction visualization coming soon...</p>
      </div>
    </div>
  );
};

export default BlockchainStatus;
