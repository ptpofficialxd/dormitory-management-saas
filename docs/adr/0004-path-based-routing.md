# ADR-0004 — Path-based routing `/c/{companySlug}/...`

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Multi-tenant SaaS needs a tenant-scoping mechanism in URLs. The two standard options
are **subdomain-per-tenant** (`acme.dormsaas.app`) and **path-per-tenant**
(`dormsaas.app/c/acme/...`). Solo-dev MVP timeline is 1 month; we also need LIFF to
work without per-tenant LINE redirect URI entries.

## Decision

**Path-based routing:** `https://<app>/c/{companySlug}/...`

- `companySlug` is `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` (kebab-case, unique per row).
- Next.js Admin Web uses a dynamic segment `/c/[slug]/...` that resolves the company
  in middleware and injects `companyId` into the request context.
- LIFF Tenant app reads the slug from the URL on boot (LIFF `liff.init` runs first,
  then routes by slug pulled from query or path).
- API accepts the slug via path **or** via `X-Company-Slug` header — the guard
  resolves to `companyId` and calls `SET LOCAL app.company_id = ...` (per ADR-0002).

## Rationale

- **One SSL cert, one DNS record** — no wildcard cert ceremony, no Let's Encrypt
  DNS-01 challenge automation for dozens of tenants.
- **One LIFF endpoint URL** — LINE only lets you register a fixed set of endpoint
  URLs per channel; path-based means we register once.
- **Copy-paste friendly URLs** for non-technical dorm owners sharing links in
  LINE chat with their tenants.
- **No cookie scoping surprises** — subdomain cookies require `Domain=.app` tricks
  and leak across tenants if misconfigured.
- **Future path** to per-tenant custom domains (enterprise add-on) is clear:
  Cloudflare SaaS custom hostnames → reverse-proxy to `/c/{slug}/...`.

## Alternatives considered

- **Subdomain-per-tenant** — nicer brand vibe but: wildcard cert, per-tenant LIFF
  redirect URIs, CORS config explosion, and tenant-admins would have to trust us
  to delete their subdomain on churn. Rejected for MVP.
- **Query param `?company=slug`** — ugly, cacheable in proxies in unwanted ways,
  hostile to React Router patterns. Rejected.
- **Header-only tenancy (no URL segment)** — breaks deep links, breaks browser
  history, breaks "send this link to the manager" UX. Rejected.

## Consequences

- Slug reservation: must block `admin`, `api`, `c`, `auth`, `_next`, `static`,
  `webhook`, `health` on signup.
- Slug is **not** secret; it's a public identifier. Never rely on it for auth.
- Rename path: if a company changes its slug, we keep the old slug as a 301
  redirect row for 90 days.
- Server Components in Next.js Admin Web must read slug from `params` and pass
  `companyId` down explicitly — no globals.
- LIFF must handle the case where LINE's in-app browser strips the path on some
  entry flows; we fallback to reading slug from a LIFF `state` query param.
