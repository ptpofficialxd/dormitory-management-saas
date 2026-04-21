# ADR-0003 — Bring-Your-Own LINE OA (per-tenant credentials)

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

The product is **LINE-first**. Each dormitory must reach its tenants through its own
brand on LINE, and most prospective customers already have a LINE OA. We can either:

1. Run **one central OA** for the SaaS and message all tenants from it.
2. Let each company **bring their own LINE OA** and we plug into it.

## Decision

**Each company brings its own LINE Official Account (BYO).**
Per-tenant we store: `channelId`, `channelSecret`, `channelAccessToken`, `liffId`.

Webhook URL pattern: `POST /line/webhook/:channelId`
- `:channelId` resolves the company → load its `channelSecret` → verify `X-Line-Signature` (HMAC-SHA256)
  → enqueue BullMQ `line.event` job → return 200 within < 1s.

## Rationale

- **Trust:** tenants already chat with the dorm's existing OA — no new app to install,
  no rebrand from "DormSaaS Bot".
- **Cost:** per-tenant message quotas and broadcast fees are paid by the customer,
  not by us — protects gross margin at scale.
- **Compliance:** if a customer churns, we don't hold their LINE relationship hostage.
- **Brand:** matches the brief's #1 differentiator (LINE-first, not just notification).

## Alternatives considered

- **Central OA** — operationally cheaper at first, but bills explode and brand is wrong.
- **Hybrid** (central OA for free tier, BYO above) — added complexity for marginal gain;
  defer until we actually have a free-tier signal.

## Consequences

- Onboarding wizard must walk a non-technical owner through creating a Messaging API
  channel + LIFF channel and pasting credentials. Must be ≤ 10 minutes with screenshots.
- We must store LINE channel secrets encrypted at rest (pgcrypto).
- Webhook signature verification is **per-tenant**, not global — wired before any handler.
- Rate limits are per-tenant; cap broadcast burst per OA.
