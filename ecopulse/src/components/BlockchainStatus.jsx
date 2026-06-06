import { useState, useEffect } from 'react';
import { getNetwork, getProvider } from '../utils/blockchain';

const BlockchainStatus = ({ account }) => {
  const [networkId, setNetworkId] = useState(null);
  const [blockNumber, setBlockNumber] = useState(null);

  useEffect(() => {
    const fetchNetworkInfo = async () => {
      const network = await getNetwork();
      if (network) {
        setNetworkId(network.chainId.toString());
      }
      const provider = getProvider();
      if (provider) {
        const block = await provider.getBlockNumber();
        setBlockNumber(block.toString());
      }
    };

    if (account) {
      fetchNetworkInfo();
      // Optional: poll block number every 5 seconds
      const interval = setInterval(fetchNetworkInfo, 5000);
      return () => clearInterval(interval);
    }
  }, [account]);

  if (!account) return null;

  return (
    <div className="p-4 border rounded shadow-md bg-gray-50 mt-4">
      <h3 className="text-lg font-bold mb-2">Blockchain Status</h3>
      <p><strong>Network Chain ID:</strong> {networkId || 'Loading...'}</p>
      <p><strong>Latest Block:</strong> {blockNumber || 'Loading...'}</p>
      {networkId === "31337" && <p className="text-green-600 font-semibold mt-2">Connected to Local Hardhat Node</p>}
      {networkId && networkId !== "31337" && <p className="text-yellow-600 font-semibold mt-2">Warning: Not connected to Hardhat localhost.</p>}
    </div>
  );
};

export default BlockchainStatus;
