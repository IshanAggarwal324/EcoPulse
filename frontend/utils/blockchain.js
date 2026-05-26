import { ethers } from "ethers";

export const EXPECTED_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || "31337");

export const getProvider = () => {
  if (window.ethereum) {
    return new ethers.BrowserProvider(window.ethereum);
  }
  return null;
};

export const getNetwork = async () => {
  const provider = getProvider();
  if (!provider) return null;
  const network = await provider.getNetwork();
  return network;
};

export const ensureCorrectNetwork = async () => {
  if (!window.ethereum) {
    throw new Error("MetaMask is not installed");
  }

  const chainIdHex = `0x${EXPECTED_CHAIN_ID.toString(16)}`;
  const currentChainId = await window.ethereum.request({ method: "eth_chainId" });

  if (currentChainId === chainIdHex) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainIdHex,
          chainName: "Hardhat Local",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545"],
        }],
      });
    } else {
      throw switchError;
    }
  }
};

const ccAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) public",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const LISTING_STATUS = {
  Active: 0,
  Sold: 1,
  Cancelled: 2,
};

const etAbi = [
  "function listEnergy(uint256 energyAmount, uint256 price)",
  "function purchaseEnergy(uint256 listingId)",
  "function cancelListing(uint256 listingId)",
  "function isListingActive(uint256 listingId) view returns (bool)",
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 energyAmount, uint256 price, uint8 status, uint256 createdAt)",
  "event EnergyListed(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price)",
  "event EnergyPurchased(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 energyAmount, uint256 price)",
  "event ListingCancelled(uint256 indexed listingId, address indexed seller)",
];

const getCcAddress = () => import.meta.env.VITE_CARBON_CREDIT_ADDRESS;
const getEtAddress = () => import.meta.env.VITE_ENERGY_TRADING_ADDRESS;

export const getCarbonCreditBalance = async (address) => {
  const provider = getProvider();
  if (!provider) return "0";
  const tokenAddress = getCcAddress();
  try {
    const contract = new ethers.Contract(tokenAddress, ccAbi, provider);
    const balance = await contract.balanceOf(address);
    return ethers.formatEther(balance);
  } catch (error) {
    console.error("Error fetching balance:", error);
    return "0";
  }
};

export const getTokenAllowance = async (owner) => {
  const provider = getProvider();
  if (!provider) return 0n;
  const contract = new ethers.Contract(getCcAddress(), ccAbi, provider);
  return contract.allowance(owner, getEtAddress());
};

export const approveTokensIfNeeded = async (amount) => {
  const provider = getProvider();
  if (!provider) throw new Error("No provider");
  const signer = await provider.getSigner();
  const owner = await signer.getAddress();
  const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
  const needed = ethers.parseEther(amount.toString());
  const current = await contract.allowance(owner, getEtAddress());

  if (current >= needed) return null;

  const tx = await contract.approve(getEtAddress(), needed);
  return tx.wait();
};

/** @deprecated Use approveTokensIfNeeded for allowance-aware approval */
export const approveTokens = async (amount) => {
  const provider = getProvider();
  if (!provider) throw new Error("No provider");
  const signer = await provider.getSigner();
  const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
  const tx = await contract.approve(getEtAddress(), ethers.parseEther(amount.toString()));
  return tx.wait();
};

const executeSignedTx = async (txFn) => {
  await ensureCorrectNetwork();
  const provider = getProvider();
  if (!provider) throw new Error("No provider");
  const signer = await provider.getSigner();
  const receipt = await txFn(signer);
  return receipt;
};

export const listEnergy = async (amount, price) =>
  executeSignedTx(async (signer) => {
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.listEnergy(amount, ethers.parseEther(price.toString()));
    return tx.wait();
  });

export const purchaseEnergy = async (listingId) =>
  executeSignedTx(async (signer) => {
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.purchaseEnergy(listingId);
    return tx.wait();
  });

export const cancelListing = async (listingId) =>
  executeSignedTx(async (signer) => {
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.cancelListing(listingId);
    return tx.wait();
  });

export const fetchAllListings = async () => {
  const provider = getProvider();
  if (!provider) return [];
  const contract = new ethers.Contract(getEtAddress(), etAbi, provider);
  try {
    const nextId = await contract.nextListingId();
    const numListings = Number(nextId);
    const activeListings = [];

    for (let i = 0; i < numListings; i++) {
      const listing = await contract.listings(i);
      const status = Number(listing.status ?? listing[3]);
      if (status === LISTING_STATUS.Active) {
        activeListings.push({
          id: i,
          seller: listing.seller,
          energyAmount: listing.energyAmount.toString(),
          price: ethers.formatEther(listing.price),
          createdAt: Number(listing.createdAt ?? listing[4]),
        });
      }
    }
    return activeListings;
  } catch (err) {
    console.error("Error fetching listings:", err);
    return [];
  }
};

export const mintDevTokens = async (amount) =>
  executeSignedTx(async (signer) => {
    const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const tx = await contract.mint(
      await signer.getAddress(),
      ethers.parseEther(amount.toString()),
    );
    return tx.wait();
  });

/**
 * Subscribe to EnergyTrading contract events. Returns an unsubscribe function.
 * @param {{ onListed?, onPurchased?, onCancelled? }} handlers
 */
export const subscribeEnergyTradingEvents = (handlers = {}) => {
  const provider = getProvider();
  const address = getEtAddress();
  if (!provider || !address) return () => {};

  const contract = new ethers.Contract(address, etAbi, provider);

  const onListed = (listingId, seller, energyAmount, price) => {
    handlers.onListed?.({
      listingId: Number(listingId),
      seller,
      energyAmount: energyAmount.toString(),
      price: ethers.formatEther(price),
    });
  };

  const onPurchased = (listingId, buyer, seller, energyAmount, price) => {
    handlers.onPurchased?.({
      listingId: Number(listingId),
      buyer,
      seller,
      energyAmount: energyAmount.toString(),
      price: ethers.formatEther(price),
    });
  };

  const onCancelled = (listingId, seller) => {
    handlers.onCancelled?.({
      listingId: Number(listingId),
      seller,
    });
  };

  contract.on("EnergyListed", onListed);
  contract.on("EnergyPurchased", onPurchased);
  contract.on("ListingCancelled", onCancelled);

  return () => {
    contract.off("EnergyListed", onListed);
    contract.off("EnergyPurchased", onPurchased);
    contract.off("ListingCancelled", onCancelled);
  };
};

/**
 * Subscribe to CarbonCredit Transfer events for a wallet. Returns unsubscribe.
 */
export const subscribeCarbonCreditTransfers = (walletAddress, onTransfer) => {
  const provider = getProvider();
  const address = getCcAddress();
  if (!provider || !address || !walletAddress) return () => {};

  const contract = new ethers.Contract(address, ccAbi, provider);
  const normalized = walletAddress.toLowerCase();

  const handler = (from, to) => {
    if (
      from.toLowerCase() === normalized ||
      to.toLowerCase() === normalized
    ) {
      onTransfer?.({ from, to });
    }
  };

  contract.on("Transfer", handler);

  return () => {
    contract.off("Transfer", handler);
  };
};
