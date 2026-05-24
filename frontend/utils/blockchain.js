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

const etAbi = [
  "function listEnergy(uint256 _energyAmount, uint256 _price)",
  "function purchaseEnergy(uint256 _listingId)",
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, uint256 energyAmount, uint256 price, bool active)",
  "event EnergyListed(uint256 listingId, address seller, uint256 energyAmount, uint256 price)",
  "event EnergyPurchased(uint256 listingId, address buyer, address seller, uint256 energyAmount, uint256 price)"
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
            if (listing.active) {
                activeListings.push({
                    id: i,
                    seller: listing.seller,
                    energyAmount: listing.energyAmount.toString(),
                    price: ethers.formatEther(listing.price),
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
