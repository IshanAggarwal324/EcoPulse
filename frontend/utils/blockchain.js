import { ethers } from "ethers";
import { logClientError } from "./clientLogger";

const isProd = import.meta.env.PROD;
const envChainId = import.meta.env.VITE_CHAIN_ID;
const envRpcUrl = import.meta.env.VITE_RPC_URL;

if (isProd && !envChainId) {
  throw new Error("VITE_CHAIN_ID must be configured in production");
}

export const EXPECTED_CHAIN_ID = Number(envChainId || "31337");
export const DEV_MINT_ENABLED = import.meta.env.DEV && EXPECTED_CHAIN_ID === 31337;

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
      const rpcUrl = envRpcUrl || "";
      if (isProd && !rpcUrl) {
        throw new Error("VITE_RPC_URL must be configured in production");
      }

      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainIdHex,
          chainName: import.meta.env.VITE_CHAIN_NAME || "EVM Network",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [rpcUrl || "http://127.0.0.1:8545"],
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
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount) public",
  "function retire(uint256 amount, string certificateUri) public returns (uint256)",
  "function retireFrom(address account, uint256 amount, string certificateUri) public returns (uint256)",
  "function totalRetired() view returns (uint256)",
  "function retiredByAccount(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Retired(address indexed account, uint256 amount, uint256 indexed retirementId, string certificateUri, address indexed initiator)",
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
const getEscrowAddress = () => import.meta.env.VITE_ENERGY_ESCROW_ADDRESS;
const getDisputeAddress = () => import.meta.env.VITE_DISPUTE_RESOLUTION_ADDRESS;
const getBridgeAddress = () => import.meta.env.VITE_CARBON_CREDIT_BRIDGE_ADDRESS;

// Module 5.3.3 — CarbonCreditBridge client ABI (lock outbound).
const bridgeAbi = [
  "function lock(uint256 amount, uint256 targetChainId, address recipient)",
  "function supportedChains(uint256) view returns (bool)",
  "function maxPerTx() view returns (uint256)",
  "function dailyRemaining() view returns (uint256)",
  "event Locked(uint256 indexed lockId, address indexed sender, address recipient, uint256 amount, uint256 indexed targetChainId)",
];

// Module 5.1 — EnergyEscrow conditional settlement ABI.
const escrowAbi = [
  "function createEscrow(uint256 listingId, address seller, uint256 amount)",
  "function confirmDelivery(uint256 escrowId)",
  "function release(uint256 escrowId)",
  "function openDispute(uint256 escrowId, bytes32 evidenceHash)",
  "function claimTimeoutRefund(uint256 escrowId)",
  "function getEscrow(uint256) view returns (address buyer, address seller, uint256 amount, uint8 state, uint256 createdAt, uint256 deliveredAt)",
  "function disputeWindow() view returns (uint256)",
  "event EscrowCreated(uint256 indexed escrowId, uint256 indexed listingId, address indexed buyer, address seller, uint256 amount)",
  "event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount)",
  "event DisputeOpened(uint256 indexed escrowId, uint256 indexed disputeId, bytes32 evidenceHash)",
];

export const ESCROW_STATES = ["funded", "delivered", "released", "disputed", "refunded"];

export const getEscrow = async (escrowId) => {
  const provider = getProvider();
  const address = getEscrowAddress();
  if (!provider || !address) return null;
  try {
    const contract = new ethers.Contract(address, escrowAbi, provider);
    const e = await contract.getEscrow(escrowId);
    const stateIndex = Number(e.state ?? e[3]);
    return {
      buyer: e.buyer ?? e[0],
      seller: e.seller ?? e[1],
      amount: (e.amount ?? e[2]).toString(),
      state: ESCROW_STATES[stateIndex] ?? "unknown",
      createdAt: Number(e.createdAt ?? e[4]) * 1000,
      deliveredAt: Number(e.deliveredAt ?? e[5] ?? 0) * 1000 || null,
    };
  } catch (error) {
    logClientError("blockchain", error, { operation: "getEscrow" });
    return null;
  }
};

/**
 * Fund an escrow for a marketplace listing instead of an instant purchase.
 * The buyer must approve the escrow contract to spend `amount` CC first.
 * @param {number|string} listingId EnergyTrading listing reference.
 * @param {string} seller Seller wallet address.
 * @param {string} amount CC amount in ether (string), e.g. "100".
 */
export const createEscrow = async (listingId, seller, amount) =>
  executeSignedTx(async (signer) => {
    if (!ethers.isAddress(seller)) throw new Error("Invalid seller address");
    const amountWei = ethers.parseEther(String(amount));
    const escrowAddr = getEscrowAddress();
    // Approve the escrow contract to pull the funds.
    const cc = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const owner = await signer.getAddress();
    const current = await cc.allowance(owner, escrowAddr);
    if (current < amountWei) {
      const approveTx = await cc.approve(escrowAddr, amountWei);
      await approveTx.wait();
    }
    const escrow = new ethers.Contract(escrowAddr, escrowAbi, signer);
    const tx = await escrow.createEscrow(listingId, seller, amountWei);
    return tx.wait();
  });

export const confirmDelivery = async (escrowId) =>
  executeSignedTx(async (signer) => {
    const escrow = new ethers.Contract(getEscrowAddress(), escrowAbi, signer);
    const tx = await escrow.confirmDelivery(escrowId);
    return tx.wait();
  });

export const releaseEscrow = async (escrowId) =>
  executeSignedTx(async (signer) => {
    const escrow = new ethers.Contract(getEscrowAddress(), escrowAbi, signer);
    const tx = await escrow.release(escrowId);
    return tx.wait();
  });

export const claimTimeoutRefund = async (escrowId) =>
  executeSignedTx(async (signer) => {
    const escrow = new ethers.Contract(getEscrowAddress(), escrowAbi, signer);
    const tx = await escrow.claimTimeoutRefund(escrowId);
    return tx.wait();
  });

/**
 * Open a dispute on-chain. `evidenceHash` should be a bytes32 (e.g. keccak256 of
 * an off-chain evidence CID). If a plain string CID is passed it is hashed.
 */
export const openDispute = async (escrowId, evidence) =>
  executeSignedTx(async (signer) => {
    const escrow = new ethers.Contract(getEscrowAddress(), escrowAbi, signer);
    const evidenceHash =
      typeof evidence === "string" && evidence.startsWith("0x") && evidence.length === 66
        ? evidence
        : ethers.id(String(evidence ?? ""));
    const tx = await escrow.openDispute(escrowId, evidenceHash);
    return tx.wait();
  });

export const getTokenAllowance = async (owner) => {
  const provider = getProvider();
  const address = getCcAddress();
  if (!provider || !address) return 0n;
  try {
    const contract = new ethers.Contract(address, ccAbi, provider);
    return contract.allowance(owner, getEtAddress());
  } catch (err) {
    logClientError("blockchain", err, { operation: "getTokenAllowance" });
    return 0n;
  }
};

export const getMarketplaceAllowance = async (owner) => {
  const allowance = await getTokenAllowance(owner);
  return ethers.formatEther(allowance);
};

export const getCarbonCreditBalance = async (walletAddress) => {
  const provider = getProvider();
  const address = getCcAddress();
  if (!provider || !address || !walletAddress) return "0";
  try {
    const contract = new ethers.Contract(address, ccAbi, provider);
    const value = await contract.balanceOf(walletAddress);
    return ethers.formatEther(value);
  } catch (err) {
    logClientError("blockchain", err, { operation: "getCarbonCreditBalance" });
    return "0";
  }
};

export const transferCarbonCredits = async (to, amount) =>
  executeSignedTx(async (signer) => {
    if (!ethers.isAddress(to)) {
      throw new Error("Invalid recipient address");
    }
    const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const tx = await contract.transfer(to, ethers.parseEther(amount.toString()));
    return tx.wait();
  });

/**
 * Module 5.3.1/5.3.8 — Retire (burn) the caller's own credits, issuing an
 * on-chain retirement certificate. The holder signs; the backend only indexes
 * the resulting tx, so no user keys ever leave the wallet.
 * @param {number|string} amount CC to retire.
 * @param {string} certificateUri Off-chain certificate URI (≤256 bytes).
 */
export const retireCredits = async (amount, certificateUri = "") =>
  executeSignedTx(async (signer) => {
    const uri = String(certificateUri ?? "");
    if (Buffer.byteLength(uri, "utf8") > 256) {
      throw new Error("Certificate URI must be 256 bytes or fewer");
    }
    const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const tx = await contract.retire(ethers.parseEther(amount.toString()), uri);
    return tx.wait();
  });

/** Read-only: cumulative CC retired by a wallet (or platform total). */
export const getRetiredAmount = async (walletAddress) => {
  const provider = getProvider();
  const address = getCcAddress();
  if (!provider || !address) return null;
  try {
    const contract = new ethers.Contract(address, ccAbi, provider);
    const value = walletAddress
      ? await contract.retiredByAccount(walletAddress)
      : await contract.totalRetired();
    return ethers.formatEther(value);
  } catch (err) {
    logClientError("blockchain", err, { operation: "getRetiredAmount" });
    return null;
  }
};

/**
 * Module 5.3.3/5.3.8 — Initiate an outbound bridge lock (client signs). The
 * caller must have approved the bridge contract to spend `amount` CC.
 */
export const initiateBridgeLock = async (amount, targetChainId, recipient) =>
  executeSignedTx(async (signer) => {
    if (!ethers.isAddress(recipient)) throw new Error("Invalid recipient address");
    const bridgeAddr = getBridgeAddress();
    if (!bridgeAddr) throw new Error("Bridge contract not configured");
    const amountWei = ethers.parseEther(amount.toString());
    const cc = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const owner = await signer.getAddress();
    const current = await cc.allowance(owner, bridgeAddr);
    if (current < amountWei) {
      const approveTx = await cc.approve(bridgeAddr, amountWei);
      await approveTx.wait();
    }
    const bridge = new ethers.Contract(bridgeAddr, bridgeAbi, signer);
    const tx = await bridge.lock(amountWei, Number(targetChainId), recipient);
    return tx.wait();
  });

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
    const amountInput = String(amount).trim();
    if (!/^\d+$/.test(amountInput)) {
      throw new Error("Energy amount must be a whole number of units");
    }
    const amountUnits = BigInt(amountInput);
    if (amountUnits < 1n) {
      throw new Error("Energy amount must be at least 1 unit");
    }

    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.listEnergy(amountUnits, ethers.parseEther(price.toString()));
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

// TODO(L7): Replace O(n) on-chain listing scan with a GraphQL indexer (The Graph).
// See P2P_Trading_Production_Readiness.md §2 — Event Indexing.
export const fetchAllListings = async () => {
  const provider = getProvider();
  if (!provider) return [];
  const contract = new ethers.Contract(getEtAddress(), etAbi, provider);
  try {
    const nextId = await contract.nextListingId();
    const numListings = Number(nextId);
    const activeListings = [];
    const chunkSize = 16;

    for (let start = 0; start < numListings; start += chunkSize) {
      const end = Math.min(start + chunkSize, numListings);
      const batch = await Promise.all(
        Array.from({ length: end - start }, (_, offset) => contract.listings(start + offset)),
      );

      batch.forEach((listing, offset) => {
        const i = start + offset;
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
      });
    }

    return activeListings;
  } catch (err) {
    logClientError("blockchain", err, { operation: "fetchAllListings" });
    return [];
  }
};

export const mintDevTokens = async (amount) =>
  executeSignedTx(async (signer) => {
    if (!DEV_MINT_ENABLED) {
      throw new Error("Dev mint is disabled outside local development");
    }
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
