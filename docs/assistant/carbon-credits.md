# EcoPulse Carbon Credits Guide

## What are Carbon Credits?

Carbon Credits (CC) are ERC-20 blockchain tokens that serve as the settlement currency for all energy trades on EcoPulse. Each token has the symbol "CC" and uses 18 decimal places, following the standard ERC-20 interface. Carbon Credits represent the environmental value of renewable energy exchanged on the platform. When you sell energy, you receive CC from the buyer. When you buy energy, you pay in CC.

## How do I get Carbon Credits?

There are several ways to acquire CC tokens:

- **Sell energy on the marketplace**: List your surplus energy for sale. When another user purchases it, CC tokens are transferred from their wallet to yours.
- **Receive a direct transfer**: Another user can send you CC tokens from the Carbon Transactions page using the "Send CC" form.
- **Mint test tokens (dev only)**: On a local Hardhat network, use the "Mint 100 CC" button on the Trading or Carbon Transactions page. This calls the contract's owner-restricted mint function.

On live networks (such as Sepolia testnet), only the contract owner can mint new CC tokens. Most users acquire CC by selling energy or receiving transfers.

## How do I check my CC balance?

Your CC balance is displayed in several places:

- **Credits page**: Shows your current balance, allowance, unapproved balance, and net flow. A credit flow chart visualizes daily received vs spent credits with cumulative net over your selected period.
- **Dashboard**: The wallet section shows your connected balance when MetaMask is linked.
- **Trading page**: Your balance is visible when creating or purchasing orders.

Balances update in real time after trades, transfers, and mints via WebSocket event listeners that watch for ERC-20 Transfer events on the CarbonCredit contract.

## What is CC allowance?

Allowance is the amount of CC tokens you have approved the EnergyTrading smart contract to spend on your behalf. When you purchase energy, the contract needs to transfer CC from your wallet to the seller. ERC-20 tokens require an explicit approval before another address can move your tokens.

The approval happens automatically during the two-step purchase flow on the Trading page. First you approve the spending, then you confirm the purchase. Your current allowance is displayed on the Carbon Transactions page. If your allowance is insufficient for a purchase, the platform will prompt you to approve the required amount.

## What is net flow?

Net flow is the difference between credits you have received and credits you have spent over a given period. A positive net flow means you have earned more from selling energy than you spent buying it. A negative net flow means you have spent more on purchases than you earned from sales.

The Credits page shows your net flow along with a breakdown of credits received and credits spent. The credit flow chart plots daily received and spent amounts with a cumulative net line, giving you a visual history of your credit activity.

## How do I view my credit activity?

The Carbon Transactions page provides a Credit Activity Ledger that maps all marketplace settlements to your credit flows. Each entry shows the direction (received or sent), the amount in CC, the counterparty wallet address, the associated listing ID, and the block timestamp.

You can filter the ledger by direction (received, sent, or all), time period (7, 30, or 90 days), listing ID, and price range. Filters can be combined to narrow results. Clicking a transaction opens a detail panel with full event information including the transaction hash and block number.

## How do I transfer CC to another wallet?

Go to the Carbon Transactions page and use the "Send CC" form. Enter the recipient's wallet address and the amount to transfer. MetaMask will prompt you to confirm the transaction. Once confirmed on-chain, the tokens move directly from your wallet to the recipient.

Direct transfers are separate from marketplace trades. They are standard ERC-20 `transfer()` calls and do not involve energy listings or the EnergyTrading contract.

## What is the credit flow chart?

The credit flow chart on the Credits page visualizes your CC token activity over time. It shows two bar series (daily credits received and daily credits spent) and a line showing your cumulative net flow.

You can select a period of 7, 30, or 90 days. The chart helps you understand patterns in your trading activity, identify your most active trading days, and track whether you are accumulating or spending credits over time.

## What are platform-wide credit metrics?

When no wallet is connected, the Credits page shows platform-wide metrics instead of personal data:

- **Credits traded**: Total CC volume across all completed trades on the platform.
- **Total supply**: The total number of CC tokens that have been minted.
- **Active traders**: The number of unique wallet addresses that have participated in trades.
- **Grid credit estimate**: An aggregate metric combining total CC traded with energy volume (`totalVolumeCredits + totalEnergyTraded * 0.1`).

These metrics give a broad view of the platform's trading activity and carbon credit economy.

## How are carbon credits different from energy?

Energy (measured in kWh) represents actual electricity generated or consumed on the grid. Carbon Credits (CC) are tokens that represent the economic and environmental value of trading that energy. They are separate concepts:

- Energy readings are recorded by nodes and stored in MongoDB. They track generation and consumption in real time.
- Carbon Credits are blockchain tokens used for payment. They exist on-chain and are transferred between wallets during trades.

When you sell 100 kWh of energy for 50 CC, the energy amount is a property of the marketplace listing while the 50 CC is the payment transferred on-chain.

## What is the CarbonCredit smart contract?

The CarbonCredit contract is an ERC-20 token deployed on the blockchain. It is built using OpenZeppelin libraries for security. Key functions:

- `mint(address, amount)`: Creates new CC tokens and assigns them to an address. Restricted to the contract owner.
- `transfer(to, amount)`: Sends CC tokens from the caller to another address. Standard ERC-20.
- `approve(spender, amount)`: Allows another address (like the EnergyTrading contract) to spend tokens on your behalf.
- `transferFrom(from, to, amount)`: Moves tokens between addresses when an allowance has been set. Used by the EnergyTrading contract during purchases.
- `balanceOf(address)`: Returns the CC balance of an address.
- `totalSupply()`: Returns the total number of CC tokens in existence.

The contract uses 18 decimal places, which is standard for ERC-20 tokens. All amounts in the UI are displayed in whole CC units.

## How does the carbon balance sync work?

CC balances and credit flows are queried directly from the blockchain in real time. The backend's carbon analytics service reads on-chain data including balances, allowances, total supply, and historical transfer events.

For trade history, the blockchain sync service incrementally scans blocks for EnergyTrading events and stores them in MongoDB. This indexed data powers the credit flow analytics, allowing fast queries for daily volumes, wallet-specific flows, and platform-wide metrics without querying the blockchain for every request.

You can manually trigger a blockchain sync from the Carbon Transactions page using the sync button if you suspect the data is out of date.
