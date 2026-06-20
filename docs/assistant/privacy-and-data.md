---
tags: [privacy, data, security, sharing, retention]
audience: user
---

# EcoPulse Privacy & Data

## What data does EcoPulse collect?

EcoPulse collects the energy readings from the nodes and devices you connect, your wallet address so it can attribute trades, and the information needed to run the assistant and reports. Each reading carries metadata such as which node and source it came from. Readings are stored in a dedicated time-series collection so they can be aggregated efficiently.

## How is my data scoped?

Your data is scoped to you. The assistant only ever sees your own readings, trades, and nodes — it filters every retrieval by your identity so that one user's data is never surfaced to another. Cross-tenant access is blocked at the retrieval layer, not just at the interface.

## What is shared when I use the assistant?

When you ask a question, the assistant gathers a small structured snapshot relevant to your question — for example a recent-usage summary or a bill comparison — and passes it to the language model to phrase the answer. Raw secrets, API keys, JWTs, and full wallet histories are never included. Internal identifiers and email addresses are redacted, and only node display names are used in context.

## How large is the data passed to the model?

The context block is capped at a fixed size, and document excerpts are limited to the top few most relevant chunks. This keeps the assistant fast and prevents large dumps of personal data from being sent unnecessarily.

## Who can reindex or change the knowledge base?

The assistant's document knowledge base is curated by platform administrators. Only admins can trigger a reindex, and only the curated docs directory is ever indexed — never the repository root, environment files, or user uploads.

## Can documents trick the assistant?

Document content is treated as untrusted data. The assistant is instructed to ignore any instructions embedded inside document excerpts or user messages that try to override its rules, and it is told to answer only from the provided data.
