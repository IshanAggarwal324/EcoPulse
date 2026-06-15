# Smart Contract Security

## CarbonCredit (`onlyOwner` mint)

- Minting is restricted to the contract **owner** (`onlyOwner`).
- Total supply is capped via `maxSupply` set at deployment (see `ignition/modules/EnergySystem.js`).
- **Production requirement:** deploy with a dedicated owner address secured by:
  - Hardware wallet (Ledger/Trezor), or
  - Multisig (e.g. Gnosis Safe), not a hot key on the application server.
- The backend `PRIVATE_KEY` is for operational minting/sync — use a separate limited-privilege wallet where possible; never reuse the Hardhat default account.

## EnergyTrading

- `purchaseEnergy` uses OpenZeppelin `ReentrancyGuard` (`nonReentrant`).
- Marketplace can be emergency-stopped via `pause()` / `unpause()` (owner only).
- Token transfers use `SafeERC20`.

## Before mainnet

1. Professional third-party audit.
2. Verify deployed `maxSupply` matches tokenomics.
3. Transfer ownership to multisig after deployment.
4. Test pause/unpause on testnet.
