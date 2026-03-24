# Billing Model: Changes and Current Design

**Document Version:** 2.0  
**Last Updated:** 2026-03-07  
**Status:** REFERENCE — Summary of all billing model changes  
**Audience:** All teams (technical and business)

---

## Summary

The billing model has evolved through two major changes:

1. **v1.0 (original):** Self-service SaaS — customers registered and paid themselves
2. **v1.1:** Admin-managed with required external billing platform (Stripe/Chargebee)
3. **v2.0 (current):** Admin-managed, **manual by default**, external gateways optional and per-customer

---

## Current Model (v2.0): Manual-First, Gateway-Optional

### Core Principle

**Billing integration is optional.** The platform operates fully without any payment gateway configured. Admins renew subscriptions directly in the Admin Panel. Payment gateways (Stripe, PayPal, DPO, etc.) can be added and assigned to individual customers as needed.

### How It Works

```
Default (no gateway):
  Admin → Admin Panel → Set expiry date → Done
  (Payment collected offline: EFT, cash, invoice, etc.)

With gateway assigned to customer:
  Option A: Admin records payment + sets expiry manually
  Option B: Admin sends payment link → customer pays online → webhook updates expiry
  Option C: Customer clicks "Renew Now" in client panel → pays online → webhook updates expiry
```

### Key Facts

| Aspect | Detail |
|--------|--------|
| **Default mode** | Fully manual — no gateway required |
| **Gateway assignment** | Per-customer; each customer can have a different gateway or none |
| **Payment types** | Once-off payments (primary) + recurring gateway subscriptions (optional) |
| **Who manages billing** | Admin only — customers cannot change their plan or initiate billing |
| **Customer self-service** | Customers can pay renewal via client panel **if** a gateway is assigned |
| **Supported gateways** | Stripe, PayPal, DPO (Africa), Chargebee, Paddle, 2Checkout, Adyen |

---

## What Changed in v2.0

### Added

| Feature | Purpose |
|---------|---------|
| **Fully manual renewal** | Admin sets expiry date directly — no gateway, no external system required |
| **Per-customer gateway assignment** | Each customer can use a different gateway, or none |
| **Once-off payment support** | Renewals via single payment — not relying on recurring subscriptions |
| **"Send Payment Link" flow** | Admin generates a payment link and emails it to the customer |
| **Client panel "Renew Now" flow** | Customer can pay renewal online when their subscription is expiring |
| **PayPal support** | Added as a supported gateway (global) |
| **DPO support** | Added as a supported gateway (Africa — ZAR, KES, NGN, and 20+ currencies) |
| **Payment history log** | All payments (manual and gateway) recorded with reference and method |
| **`billing_mode` field** | Per-customer: `manual`, `once_off`, or `recurring` |
| **`renewal_amount` / `renewal_currency`** | Stored per customer for payment link and client panel checkout |

### Changed

| Aspect | v1.1 | v2.0 |
|--------|------|------|
| **Billing required?** | Yes — external platform always needed | No — fully optional |
| **Gateway model** | Single global gateway | Per-customer gateway assignment |
| **Payment types** | Recurring subscriptions only | Once-off (primary) + recurring (optional) |
| **Supported gateways** | Stripe, Chargebee, Paddle | + PayPal, DPO, 2Checkout, Adyen |
| **Manual renewal** | Admin updates expiry via API only | Admin has dedicated UI in Admin Panel |
| **Client panel billing** | Not available | "Renew Now" button when gateway assigned |
| **Reconciliation** | All customers | Only customers with `recurring` gateway billing |

### Removed

| Feature | Reason |
|---------|--------|
| Requirement to configure a billing platform before creating customers | Replaced by manual-first model |
| Single global gateway assumption | Replaced by per-customer gateway assignment |
| Assumption that all renewals come from webhooks | Manual renewal is now the primary path |

---

## Billing Mode Reference

| Mode | Gateway Required? | How Renewal Works |
|------|-------------------|-------------------|
| `manual` | No | Admin sets expiry date directly; payment tracked offline |
| `once_off` | Yes | Each renewal is a separate payment (link or client panel checkout) |
| `recurring` | Yes | Gateway subscription renews automatically; webhook updates platform |

All three modes can coexist — each customer has their own `billing_mode`.

---

## Subscription Lifecycle (Current)

| Status | Meaning | Service | Grace Period |
|--------|---------|---------|---|
| `active` | Valid subscription | ✅ Enabled | — |
| `expired` | Past expiry date | ⚠️ Running | 7 days (configurable) before auto/manual suspend |
| `suspended` | Admin-suspended | ❌ Blocked | Non-payment, dispute, abuse |
| `cancelled` | Cancelled | ❌ Blocked | Data archived; delete after 30 days |

---

## Architecture: Before vs. Now

### v1.1: Admin-Managed, Required External Platform

```
Admin
  ↓
Creates subscription in Stripe/Chargebee (required first step)
  ↓
Creates customer in platform with subscription ID
  ↓
Platform tracks expiry via webhooks
  ↓
Admin notified → renews in external platform
  ↓
Webhook syncs back
```

### v2.0: Manual-First, Optional Gateway

```
Admin
  ↓
Creates customer in platform with expiry date
(No external system required)
  ↓
Platform tracks expiry, sends admin alerts
  ↓
Admin renews — three options:

  A) Set new expiry manually (no gateway)
       ↓ done

  B) Send payment link to customer
       ↓ customer pays online
       ↓ gateway webhook updates platform

  C) Customer clicks "Renew Now" in client panel
       ↓ customer pays online
       ↓ gateway webhook updates platform
```

---

## Document Changes (v2.0)

### Updated

| Document | What Changed |
|----------|-------------|
| `EXTERNAL_BILLING_INTEGRATION.md` | Full rewrite — manual-first model, PayPal, DPO, once-off payments, all three renewal flows, per-customer gateway assignment |
| `ADMIN_PANEL_REQUIREMENTS.md` | Added manual renewal UI, "Send Payment Link", "Record Payment", gateway management, per-customer gateway assignment |
| `SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md` | Removed assumption that external billing platform is always present; notifications work in all modes |
| `CLIENT_PANEL_FEATURES.md` | Added "Renew Now" button (visible when gateway is assigned and subscription is expiring) |

### No Longer Applicable

- The assumption that a billing platform must be configured before the platform can be used is removed entirely.

---

## Why This Model?

| Reason | Detail |
|--------|--------|
| **Operational flexibility** | Many small hosting businesses collect payment by EFT or invoice — the platform must support this without requiring Stripe |
| **Regional payment support** | Customers in Africa pay via DPO (mobile money, local cards); customers elsewhere via PayPal or Stripe. Per-customer assignment supports this naturally |
| **Simplicity for small teams** | 1–2 engineer teams don't want mandatory billing infrastructure on Day 1 |
| **Once-off payments are simpler** | Recurring gateway subscriptions are complex to manage and cancel; once-off payments per renewal cycle are easier for both admin and customer |
| **Proven Plesk pattern** | Plesk/cPanel style: admin controls everything, gateway is a convenience tool not a requirement |

---

## Related Documents

- [`./EXTERNAL_BILLING_INTEGRATION.md`](./EXTERNAL_BILLING_INTEGRATION.md) — Full integration guide (gateways, webhooks, payment flows)
- [`../04-deployment/SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md`](../04-deployment/SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md) — Admin alert system
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel subscription features
- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Client panel renewal flow

---

**Status:** Reference document complete  
**Next Step:** Implement manual renewal API, then add gateway support incrementally
