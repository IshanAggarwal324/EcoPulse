---
tags: [troubleshooting, errors, wallet, connection, readings]
audience: user
---

# EcoPulse Troubleshooting

## My wallet won't connect

If MetaMask does not connect, first check that your browser extension is unlocked and that you are on the correct network for your EcoPulse deployment. Refresh the page after switching networks. If MetaMask prompts repeatedly without completing, revoke the site connection inside MetaMask and reconnect from the Dashboard or Trading page. A stale connection from a previous network is the most common cause.

## My trade or listing failed

Trades require two on-chain steps: approving token spending and confirming the purchase. If only the approval completed, the purchase did not go through and no CC tokens were spent. Check that you have enough Carbon Credit (CC) tokens to cover the price plus gas, and that the listing is still Active — another buyer may have purchased it first. Re-submitting the purchase will start a fresh approval if needed.

## My readings are not showing up

Readings can be delayed if a device is offline, if the ingestion pipeline is backfilling, or if your node is in simulator mode and has not produced a new sample yet. Check that your node status shows online. The platform records every reading with its source, so if data is genuinely missing the assistant will say so rather than showing a blank or stale number.

## The assistant gave me a generic answer

The assistant only answers from your recorded data and the documentation. If it could not find relevant data for your question, it will say it does not have that information. Try mentioning a specific node, a specific time period, or asking about a topic covered in these docs. Numbers are never invented.

## My numbers look wrong or inconsistent

If a total seems off, it may be because readings are missing for part of the period, a node was added or removed mid-period, or you are comparing windows of different length. The assistant surfaces period-over-period comparisons and anomaly flags precisely so these situations are visible rather than hidden behind a single confident-looking number.
