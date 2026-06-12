# EcoPulse Trading Guide

## How do I start trading energy?

To trade energy on EcoPulse you need two things: a MetaMask wallet connected to the correct blockchain network and some Carbon Credit (CC) tokens to pay for purchases. Connect your wallet on the Dashboard or Trading page, then navigate to the Trading page to browse the marketplace and create orders.

If you are testing on a local Hardhat network, use the "Mint 100 CC" dev tool button on the Trading page to get test tokens. On a live network, CC tokens must be minted by the contract owner or acquired from another user via a trade or direct transfer.

## How do I sell energy?

To sell energy, go to the Trading page and use the "Create Order" form. Enter the amount of energy (in kWh) you want to list and the total price in CC tokens. When you submit, MetaMask will prompt you to confirm the blockchain transaction. Once confirmed, your listing appears in the marketplace with status Active and is visible to all users.

You can view your active listings by switching the order book toggle to "My listings." To remove a listing before it is purchased, click the Cancel button on your order. MetaMask will again prompt for confirmation.

## How do I buy energy?

Browse the marketplace on the Trading page to see all active listings. Each listing shows the energy amount, total price in CC, unit price (CC per kWh), and the seller's wallet address. You can sort listings by newest, price, energy amount, or unit price.

To purchase, click the Buy button on a listing. This is a two-step process:

1. **Approve token spending**: MetaMask asks you to approve the EnergyTrading contract to spend the required CC tokens from your wallet. This is a one-time approval per amount.
2. **Confirm purchase**: MetaMask asks you to confirm the purchase transaction. Once confirmed on-chain, the CC tokens are transferred from your wallet to the seller, and the listing status changes to Sold.

Both steps require MetaMask confirmation. If you do not have enough CC tokens, the approval step will show your current balance so you can see the shortfall.

## How do I cancel a listing?

Only the seller can cancel an active listing. On the Trading page, switch to "My listings" view and click Cancel on the order you want to remove. MetaMask will prompt for confirmation. Once the transaction is confirmed on-chain, the listing status changes to Cancelled and it is removed from the active marketplace.

Listings that have already been purchased cannot be cancelled.

## What are Carbon Credit (CC) tokens?

Carbon Credits are ERC-20 tokens used as the currency for all energy trades on EcoPulse. Each token has the symbol "CC" and 18 decimal places. When you buy energy, you pay in CC. When you sell energy, you receive CC. You can also transfer CC directly to other wallets from the Carbon Transactions page.

Your CC balance is shown on the Credits page and updates in real time after each trade or transfer. The platform tracks your credit flow history: credits received from sales, credits spent on purchases, and your net flow over time.

## How do I get Carbon Credit tokens?

On a local Hardhat development network, use the "Mint 100 CC" dev tool on the Trading or Carbon Transactions page. This calls the contract's mint function and credits 100 CC to your connected wallet.

On a live network (such as Sepolia testnet), CC tokens are minted by the contract owner. You can acquire tokens by selling energy on the marketplace or by receiving a direct transfer from another user. There is no faucet on live networks.

## How do I send CC tokens to another wallet?

Go to the Carbon Transactions page and use the "Send CC" form. Enter the recipient's wallet address and the amount of CC to transfer. MetaMask will prompt you to confirm the transfer transaction. Once confirmed, the tokens are moved from your wallet to the recipient.

Direct transfers are separate from marketplace trades. They do not involve energy listings and are peer-to-peer ERC-20 transfers.

## How do I view my trade history?

The Trading page has a Transaction History section below the marketplace. It shows all trades involving your connected wallet with details including direction (bought or sold), energy amount, price in CC, listing ID, and block timestamp.

You can filter your history by direction (bought, sold, or all), time period (7 days, 30 days, 90 days, or all time), listing ID, and price range. Filters can be combined to narrow down specific trades.

The Carbon Transactions page provides a Credit Activity Ledger that maps all marketplace settlements to credit flows, showing credits received, credits spent, and net flow per transaction.

## How are prices determined?

Sellers set the price when creating a listing. The price is the total amount of CC tokens requested for the entire energy amount. The marketplace calculates and displays the unit price (CC per kWh) so buyers can compare listings.

There is no automatic pricing or auction mechanism. Sellers choose their price freely, and buyers decide whether to accept it. Sorting the order book by unit price helps find the best deals.

## How does the order book work?

The order book on the Trading page displays all active marketplace listings. Each entry shows the listing ID, seller address (truncated), energy amount in kWh, total price in CC, and unit price in CC/kWh.

You can sort the order book by newest listings, lowest price, largest energy amount, or best unit price. Toggle between "All orders" to see the full marketplace and "My listings" to see only your active and past orders.

The order book updates in real time via WebSocket. When a new listing is created, an order is purchased, or a listing is cancelled, the order book refreshes automatically without reloading the page.

## What happens on-chain when I trade?

Every trade action is a blockchain transaction processed by the EnergyTrading smart contract:

- **List energy**: Calls `listEnergy(energyAmount, price)`. The contract creates a new listing with status Active, assigns a listing ID, and records the seller's address and parameters.
- **Purchase energy**: Calls `purchaseEnergy(listingId)`. The contract verifies the listing is Active, uses `safeTransferFrom` to move CC tokens from the buyer to the seller, and updates the listing status to Sold.
- **Cancel listing**: Calls `cancelListing(listingId)`. The contract verifies the caller is the seller and the listing is Active, then updates the status to Cancelled.

All actions emit blockchain events (`EnergyListed`, `EnergyPurchased`, `ListingCancelled`) that the backend syncs to MongoDB for fast querying and analytics. Each event includes the transaction hash, block number, and relevant trade details.

## Why is MetaMask asking for approval?

When you purchase energy, the EnergyTrading contract needs to transfer CC tokens from your wallet to the seller. ERC-20 tokens require an explicit approval step before another contract can spend your tokens. This is a security feature that prevents unauthorized token transfers.

The approval transaction sets an allowance for the EnergyTrading contract up to the purchase amount. After approval, you can confirm the actual purchase. If you have previously approved a sufficient amount, the approval step may be skipped.

## What if my transaction fails?

Common reasons for transaction failures include:

- **Insufficient CC balance**: You do not have enough CC tokens to cover the purchase price. Check your balance on the Credits page.
- **Insufficient allowance**: The approval step was not completed or the allowance is too low. Try the purchase again and approve when prompted.
- **Listing no longer active**: Another user purchased or the seller cancelled the listing before your transaction was confirmed. The order book will update to reflect the current state.
- **Wrong network**: Your MetaMask is connected to a different blockchain network than the one EcoPulse is deployed on. The platform will prompt you to switch networks.
- **Gas issues**: The transaction ran out of gas. This is rare on test networks but can happen on congested mainnets. Try again with a higher gas limit.

Failed transactions do not consume CC tokens but may consume a small amount of gas (on paid networks).

## Can I trade without a wallet?

No. All energy trades require a connected MetaMask wallet because trades are executed as blockchain transactions through the EnergyTrading smart contract. Without a wallet, you cannot create listings, purchase energy, or cancel orders.

However, you can browse the marketplace order book and view the transaction history without connecting a wallet. You can also view platform-wide analytics, energy data, forecasts, and grid information.

## How does the marketplace sync with the blockchain?

The backend runs a blockchain sync service that incrementally scans blocks for EnergyTrading contract events. It tracks the last synced block in a SyncState document in MongoDB, so it only scans new blocks on each sync cycle.

When events are detected (`EnergyListed`, `EnergyPurchased`, `ListingCancelled`), they are parsed and stored in the `trades` collection with full details including transaction hash, block number, seller, buyer, energy amount, and price. The sync service also subscribes to real-time contract events and broadcasts them to connected frontend clients via WebSocket, so the order book and trade history update instantly.

If the local Hardhat node is restarted, the sync service detects the chain reset and clears stale trade history to prevent data inconsistencies.
