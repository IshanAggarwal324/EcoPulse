import { ethers } from "ethers";

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

const ccAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) public"
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

export const approveTokens = async (amount) => {
    const provider = getProvider();
    if (!provider) throw new Error("No provider");
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
    const tx = await contract.approve(getEtAddress(), ethers.parseEther(amount.toString()));
    return await tx.wait();
};

export const listEnergy = async (amount, price) => {
    const provider = getProvider();
    if (!provider) throw new Error("No provider");
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.listEnergy(amount, ethers.parseEther(price.toString()));
    return await tx.wait();
};

export const purchaseEnergy = async (listingId) => {
    const provider = getProvider();
    if (!provider) throw new Error("No provider");
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.purchaseEnergy(listingId);
    return await tx.wait();
};

export const cancelListing = async (listingId) => {
    const provider = getProvider();
    if (!provider) throw new Error("No provider");
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(getEtAddress(), etAbi, signer);
    const tx = await contract.cancelListing(listingId);
    return await tx.wait();
};

export const fetchAllListings = async () => {
    const provider = getProvider();
    if (!provider) return [];
    const contract = new ethers.Contract(getEtAddress(), etAbi, provider);
    try {
        const nextId = await contract.nextListingId();
        const numListings = Number(nextId);
        let activeListings = [];
        
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
    } catch(err) {
        console.error("Error fetching listings:", err);
        return [];
    }
}

// Dev helper to mint tokens to oneself
export const mintDevTokens = async (amount) => {
    const provider = getProvider();
    if (!provider) throw new Error("No provider");
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(getCcAddress(), ccAbi, signer);
    // Assumes deployer is interacting, else it will revert if Ownable is active
    const tx = await contract.mint(await signer.getAddress(), ethers.parseEther(amount.toString()));
    return await tx.wait();
};
