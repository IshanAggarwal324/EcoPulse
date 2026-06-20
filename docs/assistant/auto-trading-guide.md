---
tags: [auto-trading, automation, listings, trading, policy]
audience: user
---

# EcoPulse Auto-Trading Guide

## What is auto-trading?

Auto-trading lets EcoPulse create energy listings on your behalf automatically, based on a policy you configure. Instead of manually posting a sale every time you have surplus energy, an Auto Listing Policy watches your surplus and posts listings according to rules you set. In its first version auto-trading runs in notify-only mode: it proposes listings and alerts you, but does not execute trades without your confirmation.

## How do I set up an Auto Listing Policy?

Each policy is tied to one of your nodes. You choose a minimum surplus threshold in kWh (so listings are only proposed when you actually have spare energy), a maximum number of listings per day to avoid flooding the marketplace, and a pricing strategy. The two supported strategies are forecast-derived, where the suggested price follows the surplus forecast, and fixed-discount, where your listing is priced at a set discount to the going rate.

## What does notify-only mode mean?

Because auto-trading is new, the default behavior is notify-only. This means the system will surface proposed listings to you for review rather than placing them on-chain itself. This keeps you in control of every transaction until you are comfortable enabling fully automated execution.

## How is surplus calculated?

Surplus is the difference between the energy your node generates and the energy it consumes over the same window. When your measured surplus exceeds the minimum threshold on your policy, a listing can be proposed for the surplus amount. Forecast data is used to anticipate near-term surplus so listings can be timed sensibly.

## Can I turn auto-trading off?

Yes. Each policy has an enabled toggle, and there is an administrator-level kill switch for the auto-trading subsystem. Disabling a policy stops new listings from being proposed; existing manual listings are unaffected.

## Is auto-trading safe?

Auto-trading only acts on your owned nodes and only within the limits you set. It never trades energy you do not have, and in notify-only mode it never moves tokens without your confirmation. All proposed and executed actions are logged for review.
