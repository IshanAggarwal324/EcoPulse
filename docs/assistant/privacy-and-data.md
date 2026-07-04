---
tags: [privacy, data, security, sharing, retention]
audience: user
---

# EcoPulse Privacy & Data

## What data does EcoPulse collect?

EcoPulse collects the energy readings from the nodes and devices you connect, your wallet address so it can attribute trades, and the information needed to run the assistant and reports. Each reading carries metadata such as which node and source it came from. Readings are stored in a dedicated time-series collection so they can be aggregated efficiently.

## How is my data scoped?

Your data is scoped to you. The assistant only ever sees your own readings, trades, and nodes — it filters every retrieval by your identity so that one user's data is never surfaced to another. Cross-tenant access is blocked at the retrieval layer, not just at the interface.

## Roles, zones and data isolation

EcoPulse is **user-scoped**: every node, reading, trade and carbon balance belongs to a single user. There are no shared organizations. Your account has one of five domain roles, and that role decides what you can see and do:

| Role | What they can see | What they can do |
|------|-------------------|------------------|
| `consumer` | Only their own nodes, readings, trades and wallet | Buy energy, retire credits, manage their own consumer nodes |
| `prosumer` | Only their own nodes, readings, trades and wallet | Produce and consume, sell and buy, manage their own nodes |
| `grid_operator` | Their own nodes **plus** read-only visibility into nodes in the grid zones an admin assigned to them | Read zone topology and aggregates; cannot create, edit, delete or trade |
| `moderator` | Platform-wide read access for support | Moderate content; no access to your raw meter data beyond support needs |
| `admin` | Platform-wide access | Full platform administration |

A few important boundaries:

- **You own your nodes.** Only you (or an admin) can create, edit or delete your nodes. Another user can never claim or move your node, even by guessing its identifier — attempts return "not found" so the existence of your node is never leaked.
- **Delegation is explicit and revocable.** You may delegate `read` or `write` access on a specific node to another user. A `write` delegate can update node fields but can **never** add further delegates or change the node's zone — that would let them escalate their own privileges, so it is blocked. Only you and an admin manage a node's access list.
- **A grid operator's view is operational, not personal.** A `grid_operator` can see the *metadata and topology* (type, status, zone, aggregates) of nodes inside their assigned zones, but they do **not** receive your raw per-node meter readings, your wallet address, or the node's operator roster. That data is stripped before it reaches them.
- **Zones can be revoked instantly.** If an admin deactivates or deletes a zone, operators assigned to it lose visibility on the very next request — they cannot keep reading "stale" zone data.
- **Your wallet is cryptographically yours.** A wallet address is bound to your account only through a signed (EIP-712) challenge, never a typed field. No two accounts can claim the same address, and unbinding requires re-authentication.

## What is shared when I use the assistant?

When you ask a question, the assistant gathers a small structured snapshot relevant to your question — for example a recent-usage summary or a bill comparison — and passes it to the language model to phrase the answer. Raw secrets, API keys, JWTs, and full wallet histories are never included. Internal identifiers and email addresses are redacted, and only node display names are used in context.

## How large is the data passed to the model?

The context block is capped at a fixed size, and document excerpts are limited to the top few most relevant chunks. This keeps the assistant fast and prevents large dumps of personal data from being sent unnecessarily.

## Who can reindex or change the knowledge base?

The assistant's document knowledge base is curated by platform administrators. Only admins can trigger a reindex, and only the curated docs directory is ever indexed — never the repository root, environment files, or user uploads.

## Can documents trick the assistant?

Document content is treated as untrusted data. The assistant is instructed to ignore any instructions embedded inside document excerpts or user messages that try to override its rules, and it is told to answer only from the provided data.
