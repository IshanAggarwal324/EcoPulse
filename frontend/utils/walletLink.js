import { ethers } from 'ethers';
import { getProvider } from './blockchain';

/**
 * Module 8.4 — client-side EIP-712 signing for wallet linking.
 *
 * The server returns the canonical typed data (domain + types + message); the
 * client MUST sign it verbatim. The server rebuilds the same digest from its
 * own stored values and verifies the recovered signer equals the wallet, so any
 * tampering with the payload here fails verification.
 *
 * @param {object} typedData { domain, types, primaryType, message } from the
 *   challenge endpoint (uints as strings — the EIP-712 JSON wire form).
 * @returns {Promise<{ signature: string, signer: string }>}
 */
export async function signWalletLink(typedData) {
  if (!typedData || !typedData.domain || !typedData.types || !typedData.message) {
    throw new Error('Invalid challenge payload');
  }

  const provider = getProvider();
  if (!provider) {
    throw new Error('MetaMask is not installed. Please install it to link a wallet.');
  }

  const signer = await provider.getSigner();

  // ethers v6 signTypedData(domain, types, value). The message carries uint256
  // fields as strings (standard EIP-712 JSON); ethers encodes them correctly.
  const signature = await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  );

  const signerAddress = (await signer.getAddress()).toLowerCase();
  return { signature, signer: signerAddress };
}
