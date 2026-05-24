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

// Assuming CarbonCredit ABI is simple:
const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)"
];

export const getCarbonCreditBalance = async (address) => {
  const provider = getProvider();
  if (!provider) return "0";
  
  // Use a placeholder address or env variable
  const tokenAddress = import.meta.env.VITE_CARBON_CREDIT_ADDRESS || "0x0000000000000000000000000000000000000000"; 
  if (tokenAddress === "0x0000000000000000000000000000000000000000") return "0";

  try {
    const contract = new ethers.Contract(tokenAddress, erc20Abi, provider);
    const balance = await contract.balanceOf(address);
    return ethers.formatEther(balance);
  } catch (error) {
    console.error("Error fetching balance:", error);
    return "0";
  }
};
