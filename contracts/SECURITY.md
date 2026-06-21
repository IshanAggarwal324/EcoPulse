# Smart Contract Security

## Audit status (C8)

- **Status:** NOT formally audited — see [`AUDIT_MANIFEST.json`](AUDIT_MANIFEST.json).
- **On-chain marker:** `CarbonCredit.AUDIT_STATUS()` returns `"UNAUDITED"`.
- **Mainnet deploy gate:** run `node scripts/predeploy-check.js --mainnet` before any mainnet deploy.
  - Requires `MAINNET_AUDIT_ACK=confirmed`.
  - Requires manifest `status: "audited"` with `auditor` and `reportUrl` filled in.

### Before mainnet

1. Complete a professional third-party audit of `CarbonCredit.sol` and `EnergyTrading.sol`.
2. Resolve all critical/high findings; publish the audit report URL in `AUDIT_MANIFEST.json`.
3. Set `"status": "audited"` in the manifest.
4. Deploy via Ignition only after `predeploy-check` passes.
5. Verify contracts on the block explorer and link the audit in deployment docs.

---

## CarbonCredit mint governance (C9)

Minting is **not** a single-owner god mode anymore:

| Role | Purpose |
|------|---------|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke minters; hold on **multisig** (e.g. Gnosis Safe) |
| `MINTER_ROLE` | Operational minting only — grant to backend hot wallet |

Additional safeguards:

- **Uncapped deployment forbidden** — `maxSupply` must be > 0 (constructor reverts on `0`).
- **Per-transaction cap** — `maxMintPerTx` immutable at deploy (default 1M CC in Ignition).
- **Global cap** — `totalMinted` cannot exceed `maxSupply`.

### Recommended production setup

1. Deploy with explicit `maxSupply` matching tokenomics (Ignition parameter `maxSupply`).
2. Set `maxMintPerTx` to the largest legitimate single mint (Ignition parameter `maxMintPerTx`).
3. Pass `admin` = multisig address (Ignition parameter `admin`).
4. `grantMinter(operationalBackendWallet)` — backend `PRIVATE_KEY` wallet mints only.
5. `revokeMinter(multisig)` if multisig received initial minter at deploy.
6. Never use the Hardhat default account or app-server owner key as admin.

---

## EnergyTrading

- Uses **Ownable2Step** — ownership transfer requires `acceptOwnership()` on the pending owner (safer multisig handoff).
- `purchaseEnergy` / `purchaseEnergyPartial` use OpenZeppelin `ReentrancyGuard` (`nonReentrant`).
- Marketplace can be emergency-stopped via `pause()` / `unpause()` (owner only).
- Token transfers use `SafeERC20`.

---

## Deployment commands

```bash
# Testnet (after compile + tests)
node scripts/predeploy-check.js
npx hardhat ignition deploy ignition/modules/EnergySystem.js --network sepolia

# Mainnet (only after audit — will fail until manifest + ack are set)
MAINNET_AUDIT_ACK=confirmed node scripts/predeploy-check.js --mainnet
npx hardhat ignition deploy ignition/modules/EnergySystem.js --network mainnet
```
