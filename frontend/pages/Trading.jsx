import React, { useState, useEffect } from 'react';
import { fetchAllListings, listEnergy, purchaseEnergy, approveTokens, mintDevTokens, getProvider } from '../utils/blockchain';
import SectionTitle from '../components/ui/SectionTitle';
import { useToast } from '../context/ToastContext';

const Trading = () => {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState(null);
  
  // Form State
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  
  // Status State
  const toast = useToast();

  useEffect(() => {
    const init = async () => {
        const provider = getProvider();
        if(provider) {
            const accounts = await provider.send("eth_accounts", []);
            if(accounts.length > 0) setAccount(accounts[0]);
        }
        loadListings();
    };
    init();
  }, []);

  const loadListings = async () => {
    const activeListings = await fetchAllListings();
    setListings(activeListings);
  };

  const handleListEnergy = async (e) => {
    e.preventDefault();
    if(!account) {
      toast.error('Connect your wallet on the Dashboard first');
      return;
    }
    if(!amount || !price) return;
    
    setLoading(true);
    toast.info('Confirm transaction in MetaMask...');
    
    try {
        await listEnergy(amount, price);
        toast.success('Energy listed successfully!');
        loadListings();
        setAmount('');
        setPrice('');
    } catch (err) {
        toast.error(err.message || 'Transaction failed');
    } finally {
        setLoading(false);
    }
  };

  const handlePurchase = async (id, priceStr) => {
    if(!account) {
      toast.error('Connect your wallet on the Dashboard first');
      return;
    }
    
    setLoading(true);
    try {
        toast.info('Step 1/2: Approving carbon credits...');
        await approveTokens(priceStr);
        
        toast.info('Step 2/2: Confirm purchase in MetaMask...');
        await purchaseEnergy(id);
        
        toast.success('Energy purchased successfully!');
        loadListings();
    } catch (err) {
        toast.error(err.message || 'Purchase failed');
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      <SectionTitle
        title="Peer-to-Peer Energy Trading"
        subtitle="List and purchase energy using carbon credits on-chain"
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Create Listing */}
        <div className="lg:col-span-1 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl h-fit">
            <h3 className="text-xl font-bold text-white mb-4">List Energy for Sale</h3>
            <form onSubmit={handleListEnergy} className="space-y-4">
                <div>
                    <label className="block text-slate-400 text-sm mb-1">Energy Amount (Units)</label>
                    <input 
                        type="number" 
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500" 
                        placeholder="e.g. 100"
                        required
                    />
                </div>
                <div>
                    <label className="block text-slate-400 text-sm mb-1">Price (in CC)</label>
                    <input 
                        type="number" 
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500" 
                        placeholder="e.g. 10"
                        required
                    />
                </div>
                <button 
                    type="submit" 
                    disabled={loading || !account}
                    className="touch-target w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
                >
                    {loading ? 'Processing...' : 'Create Listing'}
                </button>
            </form>

            {/* Dev Helper */}
            <div className="mt-8 pt-4 border-t border-slate-700/50">
                <p className="text-xs text-slate-500 mb-2">Dev Tools (Hardhat Local Only)</p>
                <button 
                    onClick={() => mintDevTokens(100).then(() => toast.success('Minted 100 CC!')).catch((e) => toast.error(e.message))}
                    className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm py-2 rounded-lg"
                >
                    Mint 100 CC to Self
                </button>
            </div>
        </div>

        {/* Market Listings */}
        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl min-w-0">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
                <h3 className="text-lg sm:text-xl font-bold text-white">Active Market Listings</h3>
                <button type="button" onClick={() => { loadListings(); toast.info('Listings refreshed'); }} className="touch-target text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2">Refresh</button>
            </div>
            
            {listings.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-slate-700 rounded-xl">
                    <p className="text-slate-400">No active energy listings found.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {listings.map((listing) => (
                        <div key={listing.id} className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded-md">ID: {listing.id}</span>
                                    <span className="text-sm text-slate-400 font-mono">Seller: {listing.seller.slice(0,6)}...{listing.seller.slice(-4)}</span>
                                </div>
                                <p className="text-white font-medium text-lg">{listing.energyAmount} Energy Units</p>
                            </div>
                            <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
                                <div className="text-right">
                                    <p className="text-xs text-slate-500 uppercase tracking-wider">Price</p>
                                    <p className="text-emerald-400 font-bold">{listing.price} CC</p>
                                </div>
                                {account && account.toLowerCase() === listing.seller.toLowerCase() ? (
                                    <button disabled className="bg-slate-700 text-slate-400 px-4 py-2 rounded-lg font-medium cursor-not-allowed">Your Listing</button>
                                ) : (
                                    <button 
                                        onClick={() => handlePurchase(listing.id, listing.price)}
                                        disabled={loading}
                                        className="touch-target bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white px-4 py-3 rounded-lg font-medium transition-colors w-full sm:w-auto"
                                    >
                                        Buy Energy
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default Trading;
