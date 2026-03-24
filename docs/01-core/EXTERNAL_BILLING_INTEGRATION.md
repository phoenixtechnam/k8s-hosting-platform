# External Billing Integration Guide

**Document Version:** 2.0  
**Last Updated:** 2026-03-07  
**Status:** DRAFT — Ready for implementation  
**Audience:** Backend developers, DevOps engineers, billing system integrators

---

## Overview

The platform uses a **manual-first, gateway-optional** billing model. Billing integration is **not required** to operate the platform. By default, admins manage all subscription renewals directly in the Admin Panel. Payment gateways can be configured globally and assigned to individual customers as needed.

**Key principles:**
- **Manual by default:** Admins can renew any subscription by simply setting a new expiry date — no payment gateway required.
- **Optional gateways:** One or more payment gateways (Stripe, PayPal, DPO, Chargebee, etc.) can be configured and assigned per customer.
- **Flexible payment modes:** Both recurring subscription billing and once-off payments are supported.
- **Admin-managed:** No customer self-service plan upgrades. Customers can pay via a payment link or client panel checkout, but the admin controls what they're paying for.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Admin Panel                                                        │
│  ├─ Manual Renewal: Set expiry date directly (no gateway needed)    │
│  ├─ Record Payment: Mark as paid, enter reference, set expiry       │
│  ├─ Send Payment Link: Generate link via configured gateway         │
│  └─ Assign Gateway: Choose which gateway a customer uses            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ (optional)
                ┌──────────────────▼──────────────────┐
                │  Payment Gateway (per customer)      │
                │  ├─ Stripe                           │
                │  ├─ PayPal                           │
                │  ├─ DPO (Direct Pay Online)          │
                │  ├─ Chargebee                        │
                │  ├─ Paddle                           │
                │  └─ Any webhook-capable gateway      │
                └──────────────────┬──────────────────┘
                                   │ Webhooks / once-off payment events
                ┌──────────────────▼──────────────────┐
                │  Management API                      │
                │  ├─ Receives payment confirmation    │
                │  ├─ Updates subscription expiry      │
                │  └─ Notifies admin                   │
                └─────────────────────────────────────┘
```

---

## Billing Modes

### Mode 1: Fully Manual (Default — No Gateway Required)

No payment gateway is configured for the customer. Admin manages renewals entirely within the Admin Panel.

**When to use:**
- Customers who pay by EFT, cash, bank transfer, or invoice
- Customers in regions where supported gateways are unavailable
- Any situation where the admin prefers manual control

**Admin workflow:**
1. Receive payment offline (EFT, cash, invoice, etc.)
2. In Admin Panel → Client → Subscription → **Record Payment** (or **Renew Manually**)
3. Enter payment reference (optional), set new expiry date
4. Save — subscription is immediately extended

### Mode 2: Gateway-Assisted Renewal

A payment gateway is assigned to the customer. The admin can use the gateway to take payment in one of three ways:

#### 2a. Admin Records Payment (Gateway Reference)
Admin processes payment in the external gateway and records the result in the platform.

#### 2b. Admin Sends Payment Link
Admin clicks **Send Payment Link** in the Admin Panel. The platform generates a once-off payment link via the assigned gateway and sends it to the customer by email. On successful payment, a webhook updates the subscription automatically.

#### 2c. Customer Pays via Client Panel
Customer sees a **Renew Now** button in their client panel when their subscription is expiring (or expired, within the grace period). Customer clicks, is redirected to the gateway checkout, pays the once-off renewal amount, and the subscription is updated via webhook.

> **Note:** Once-off (single payment) checkout is used for all gateway-based renewals. Recurring/automatic subscription billing via the gateway is also supported where desired, but is not required.

---

## Supported Payment Gateways

| Gateway | Region Focus | Webhook Support | Once-Off | Recurring | Setup Time |
|---------|-------------|-----------------|----------|-----------|------------|
| **Stripe** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 1–2 hours |
| **PayPal** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 1–2 hours |
| **DPO (Direct Pay Online)** | Africa | ✅ Yes | ✅ Yes | ✅ Yes | 2–3 hours |
| **Chargebee** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 1–2 hours |
| **Paddle** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 2 hours |
| **2Checkout / Verifone** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 2–3 hours |
| **Adyen** | Global | ✅ Yes | ✅ Yes | ✅ Yes | 2–3 hours |

### Gateway Notes

**Stripe**
- Industry-standard REST API and webhooks
- Supports Payment Links (once-off), Subscriptions (recurring), and manual payment recording
- Store webhook secret in Kubernetes Secret

**PayPal**
- Widely used globally, strong in consumer markets
- Supports PayPal Checkout (once-off), PayPal Subscriptions (recurring)
- Webhook events: `PAYMENT.CAPTURE.COMPLETED`, `BILLING.SUBSCRIPTION.RENEWED`, `BILLING.SUBSCRIPTION.CANCELLED`
- Requires PayPal Business account; sandbox available for testing

**DPO (Direct Pay Online)**
- Primary payment gateway for Africa (South Africa, Kenya, Nigeria, Tanzania, Uganda, Zimbabwe, and 20+ more countries)
- Supports local payment methods: credit/debit cards, mobile money (M-Pesa, MTN Mobile Money, Airtel Money), bank transfers
- Supports multiple African currencies (ZAR, KES, NGN, TZS, UGX, USD, etc.)
- Once-off transaction flow: create token → redirect customer → receive payment notification callback
- Webhook/IPN: DPO sends payment confirmation to platform callback URL on success
- Recurring billing: Supported via DPO's subscription/tokenisation API
- API endpoint: `https://secure.3gdirectpay.com/API/v6/`

**Chargebee**
- Full subscription lifecycle management (SaaS-oriented)
- Webhooks cover full subscription lifecycle

**Paddle**
- Merchant of record model (handles tax/VAT compliance)
- Good for international SaaS

---

## Gateway Configuration

### Global Gateway Setup (Admin Panel → Settings → Payment Gateways)

Each gateway is configured once at the platform level and can then be assigned to individual customers.

```json
{
  "gateway_id": "stripe_main",
  "provider": "stripe",
  "display_name": "Stripe (Primary)",
  "enabled": true,
  "config": {
    "secret_key": "sk_live_...",       // stored as Kubernetes Secret
    "publishable_key": "pk_live_...",
    "webhook_secret": "whsec_..."      // stored as Kubernetes Secret
  }
}
```

```json
{
  "gateway_id": "paypal_main",
  "provider": "paypal",
  "display_name": "PayPal",
  "enabled": true,
  "config": {
    "client_id": "...",                // stored as Kubernetes Secret
    "client_secret": "...",            // stored as Kubernetes Secret
    "mode": "live"                     // "sandbox" or "live"
  }
}
```

```json
{
  "gateway_id": "dpo_africa",
  "provider": "dpo",
  "display_name": "DPO Pay (Africa)",
  "enabled": true,
  "config": {
    "company_token": "...",            // stored as Kubernetes Secret
    "service_type": "...",             // DPO service/product type code
    "currency": "USD",                 // default currency
    "callback_url": "https://api.platform.com/webhooks/dpo",
    "back_url": "https://admin.platform.com/payment/return"
  }
}
```

### Store Gateway Credentials in Kubernetes

```bash
kubectl create secret generic gateway-stripe \
  --from-literal=secret_key=sk_live_... \
  --from-literal=webhook_secret=whsec_... \
  -n platform

kubectl create secret generic gateway-paypal \
  --from-literal=client_id=... \
  --from-literal=client_secret=... \
  -n platform

kubectl create secret generic gateway-dpo \
  --from-literal=company_token=... \
  -n platform
```

### Per-Customer Gateway Assignment

Each customer can have a gateway assigned (or none at all):

```json
{
  "customer_id": "client_001",
  "subscription": {
    "expiry_date": "2026-03-01",
    "status": "active",
    "gateway_id": "dpo_africa",      // null = manual only
    "external_billing_id": null,     // ID in gateway system (if applicable)
    "billing_mode": "once_off",      // "once_off" | "recurring" | "manual"
    "renewal_amount": 19.99,
    "renewal_currency": "USD"
  }
}
```

---

## Subscription Lifecycle

### Scenario A: Fully Manual (No Gateway)

```
Admin creates customer
  → Enters expiry date manually
  → No gateway required

Expiry approaches (Day 30 alert)
  → Admin collects payment offline (EFT, cash, invoice)
  → Admin opens client in Admin Panel
  → Clicks "Renew Manually"
  → Enters new expiry date + optional payment reference
  → Subscription extended immediately
```

**API:**
```bash
PATCH /api/v1/clients/{id}/subscription
{
  "expiry_date": "2027-03-01",
  "status": "active",
  "payment_reference": "EFT-20260301-ACME",   // optional
  "notes": "Annual renewal, paid via EFT"
}
```

### Scenario B: Admin Sends Payment Link

```
Expiry approaches (Day 7 alert)
  → Admin clicks "Send Payment Link" in Admin Panel
  → Platform creates once-off payment via assigned gateway
    (Stripe Payment Link / PayPal order / DPO token)
  → Platform emails link to customer
  → Customer clicks link, pays
  → Gateway sends webhook to platform
  → Platform updates subscription expiry automatically
  → Admin notified of successful renewal
```

**API:**
```bash
POST /api/v1/clients/{id}/subscription/send-payment-link
{
  "amount": 19.99,
  "currency": "USD",
  "renewal_period_months": 12,
  "gateway_id": "stripe_main",        // override customer default
  "notify_customer_email": true
}

// Response:
{
  "payment_link": "https://pay.stripe.com/...",
  "expires_at": "2026-03-14T00:00:00Z",
  "gateway_reference": "plink_abc123"
}
```

### Scenario C: Customer Pays via Client Panel

```
Customer logs into Client Panel
  → Sees "Subscription expires in 7 days — Renew Now"
  → Clicks "Renew Now"
  → Shown renewal amount and currency
  → Redirected to gateway checkout (Stripe / PayPal / DPO)
  → Customer pays
  → Gateway webhook → platform updates subscription
  → Customer sees "Subscription renewed until [new date]"
```

**Client Panel API:**
```bash
POST /api/v1/client/subscription/initiate-payment
{
  "renewal_period_months": 12
}

// Response:
{
  "checkout_url": "https://secure.3gdirectpay.com/payv2.php?ID=...",
  "expires_at": "2026-03-08T02:00:00Z"
}
```

### Scenario D: Recurring Gateway Subscription (Optional)

When `billing_mode` is set to `recurring`, the gateway manages the renewal schedule automatically. The platform listens for renewal webhook events and updates the expiry date accordingly.

```
Gateway subscription renews automatically
  → Gateway sends webhook: payment.succeeded / subscription.renewed
  → Platform extends expiry date by billing cycle
  → Admin notified
```

---

## Webhook Integration

### Webhook Endpoint

All gateways post to a single webhook endpoint, identified by gateway type:

```
POST /webhooks/billing/{gateway_type}

Examples:
  POST /webhooks/billing/stripe
  POST /webhooks/billing/paypal
  POST /webhooks/billing/dpo
  POST /webhooks/billing/chargebee
```

### Webhook Verification Requirements

All webhook handlers must:
1. Verify cryptographic signature (gateway-specific method)
2. Validate timestamp is recent (< 5 minutes, prevents replay attacks)
3. Handle idempotency (same event delivered multiple times must not double-renew)
4. Return `200 OK` immediately; process asynchronously if needed

### Stripe Webhook Handler

```typescript
// POST /webhooks/billing/stripe
app.post('/webhooks/billing/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'payment_intent.succeeded':
    case 'customer.subscription.updated':
    case 'invoice.payment_succeeded': {
      const customerId = event.data.object.metadata?.platform_customer_id;
      const periodEnd = event.data.object.current_period_end
        ?? event.data.object.metadata?.period_end;
      await extendSubscription(customerId, periodEnd, event.id);
      break;
    }
    case 'customer.subscription.deleted': {
      const customerId = event.data.object.metadata?.platform_customer_id;
      await markSubscriptionExpired(customerId, event.id);
      break;
    }
  }

  res.json({ received: true });
});
```

### PayPal Webhook Handler

```typescript
// POST /webhooks/billing/paypal
app.post('/webhooks/billing/paypal', async (req, res) => {
  // Verify PayPal webhook signature
  const isValid = await paypal.verifyWebhookSignature({
    webhookId: PAYPAL_WEBHOOK_ID,
    headers: req.headers,
    body: req.body,
  });

  if (!isValid) return res.status(400).json({ error: 'Invalid signature' });

  const event = req.body;

  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const customerId = event.resource.custom_id; // platform_customer_id
      const renewalMonths = parseInt(event.resource.purchase_units?.[0]
        ?.custom_id?.split(':')[1] ?? '12');
      await extendSubscriptionByMonths(customerId, renewalMonths, event.id);
      break;
    }
    case 'BILLING.SUBSCRIPTION.RENEWED': {
      const customerId = event.resource.custom_id;
      const nextBillingDate = event.resource.billing_info?.next_billing_time;
      await extendSubscription(customerId, nextBillingDate, event.id);
      break;
    }
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const customerId = event.resource.custom_id;
      await markSubscriptionExpired(customerId, event.id);
      break;
    }
  }

  res.json({ received: true });
});
```

### DPO Webhook Handler (IPN Callback)

DPO sends payment confirmation to the `callback_url` configured in the company token settings. The platform verifies the payment status directly with the DPO API before updating the subscription.

```typescript
// POST /webhooks/billing/dpo
app.post('/webhooks/billing/dpo', async (req, res) => {
  const { TransactionToken, CompanyRef } = req.body;

  // CompanyRef = platform_customer_id set when creating DPO token
  // Verify payment with DPO API (do not trust the callback alone)
  const verification = await dpoClient.verifyToken({
    companyToken: DPO_COMPANY_TOKEN,
    transactionToken: TransactionToken,
  });

  // DPO verify response: <Result>000</Result> = success
  if (verification.Result !== '000') {
    return res.status(200).send('FAILED'); // DPO expects 200 even on failure
  }

  const customerId = CompanyRef;
  const renewalMonths = parseInt(verification.CompanyRefUnique?.split(':')[1] ?? '12');

  await extendSubscriptionByMonths(customerId, renewalMonths, TransactionToken);

  // DPO expects specific response body
  res.status(200).send('OK');
});
```

**DPO Token Creation (for Payment Link / Client Panel Checkout):**

```typescript
async function createDpoPaymentToken(customer: Customer, months: number): Promise<string> {
  const amount = (customer.subscription.renewal_amount * months).toFixed(2);
  const currency = customer.subscription.renewal_currency ?? 'USD';

  const xml = `
    <?xml version="1.0" encoding="utf-8"?>
    <API3G>
      <CompanyToken>${DPO_COMPANY_TOKEN}</CompanyToken>
      <Request>createToken</Request>
      <Transaction>
        <PaymentAmount>${amount}</PaymentAmount>
        <PaymentCurrency>${currency}</PaymentCurrency>
        <CompanyRef>${customer.id}</CompanyRef>
        <CompanyRefUnique>${customer.id}:${months}</CompanyRefUnique>
        <RedirectURL>${DPO_BACK_URL}</RedirectURL>
        <BackURL>${DPO_BACK_URL}</BackURL>
        <customerEmail>${customer.email}</customerEmail>
        <customerFirstName>${customer.first_name}</customerFirstName>
        <customerLastName>${customer.last_name}</customerLastName>
      </Transaction>
      <Services>
        <Service>
          <ServiceType>${DPO_SERVICE_TYPE}</ServiceType>
          <ServiceDescription>Hosting Renewal - ${months} month(s)</ServiceDescription>
          <ServiceDate>${new Date().toISOString().split('T')[0]} 00:00</ServiceDate>
        </Service>
      </Services>
    </API3G>`;

  const response = await axios.post('https://secure.3gdirectpay.com/API/v6/', xml, {
    headers: { 'Content-Type': 'application/xml' },
  });

  // Parse <TransToken> from response XML
  const token = parseXml(response.data).API3G.TransToken;
  return `https://secure.3gdirectpay.com/payv2.php?ID=${token}`;
}
```

---

## Subscription Object

```json
{
  "plan": "business",
  "expiry_date": "2026-03-01",
  "status": "active",
  "days_until_expiry": 365,

  "gateway_id": "dpo_africa",         // null = manual only
  "external_billing_id": null,        // recurring subscription ID in gateway (if applicable)
  "billing_mode": "once_off",         // "once_off" | "recurring" | "manual"
  "renewal_amount": 19.99,
  "renewal_currency": "USD",

  "last_payment_date": "2025-03-01",
  "last_payment_reference": "TXN-DPO-2025-001",
  "last_payment_method": "dpo",

  "renewal_reminder_sent": false,
  "notes": "Client in Kenya, uses DPO"
}
```

### Status Values

| Status | Meaning | Service | Action |
|--------|---------|---------|--------|
| `active` | Valid subscription | Enabled | Normal operation |
| `expired` | Past expiry, within grace period | Running (grace) | Alert admin — renew or suspend |
| `suspended` | Admin-suspended | Blocked | Non-payment, dispute, or abuse |
| `cancelled` | Cancelled | Blocked | Data archived; delete after 30 days |

### Grace Period

Default grace period after expiry: **7 days** (configurable in platform settings). During the grace period:
- Service continues to run
- Admin receives escalating alerts
- Customer sees renewal banner in client panel (if gateway is assigned)
- After grace period expires, admin must manually suspend or the platform auto-suspends (configurable)

---

## Admin Workflows

### Workflow 1: Create Customer (Manual — No Gateway)

```bash
POST /api/v1/clients
{
  "name": "Acme Corp",
  "email": "admin@acme.com",
  "plan": "business",
  "subscription": {
    "expiry_date": "2026-03-01",
    "billing_mode": "manual",
    "notes": "Pays by monthly EFT"
  }
}
```

### Workflow 2: Create Customer (With Gateway)

```bash
POST /api/v1/clients
{
  "name": "Beta Ltd",
  "email": "admin@beta.co.ke",
  "plan": "business",
  "subscription": {
    "expiry_date": "2026-03-01",
    "gateway_id": "dpo_africa",
    "billing_mode": "once_off",
    "renewal_amount": 19.99,
    "renewal_currency": "USD",
    "notes": "Kenya client, pays via DPO"
  }
}
```

### Workflow 3: Manual Renewal (Admin Panel)

```bash
PATCH /api/v1/clients/{id}/subscription
{
  "expiry_date": "2027-03-01",
  "status": "active",
  "payment_reference": "EFT-REF-20260301",
  "notes": "Renewed for 12 months, paid via EFT"
}
```

### Workflow 4: Send Payment Link to Customer

```bash
POST /api/v1/clients/{id}/subscription/send-payment-link
{
  "amount": 19.99,
  "currency": "USD",
  "renewal_period_months": 12,
  "gateway_id": "dpo_africa",
  "notify_customer_email": true,
  "email_message": "Please renew your hosting subscription using the link below."
}
```

### Workflow 5: Handle Expired Subscription

```bash
# Option A: Renew manually
PATCH /api/v1/clients/{id}/subscription
{ "expiry_date": "2027-03-01", "status": "active" }

# Option B: Send payment link (customer pays online)
POST /api/v1/clients/{id}/subscription/send-payment-link
{ "amount": 19.99, "currency": "USD", "renewal_period_months": 12 }

# Option C: Suspend
PATCH /api/v1/clients/{id}
{ "status": "suspended" }

# Option D: Cancel
PATCH /api/v1/clients/{id}
{ "status": "cancelled" }
```

---

## Daily Reconciliation Job

For customers with `billing_mode: recurring` and a gateway configured, a daily job reconciles subscription state with the billing platform:

```bash
#!/bin/bash
# Runs at 2 AM UTC daily
# Only reconciles customers with recurring gateway billing

for customer in $(get_customers_with_recurring_billing); do
  billing_sub=$(gateway_api_get_subscription \
    $customer.gateway_id \
    $customer.external_billing_id)

  if billing_sub.expiry != customer.subscription.expiry_date \
    OR billing_sub.status != customer.subscription.status; then

    PATCH /api/v1/clients/$customer.id/subscription \
      --data "{
        'expiry_date': '$billing_sub.expiry',
        'status': '$billing_sub.status',
        'notes': 'Auto-synced from gateway'
      }"
  fi
done
```

For `manual` and `once_off` customers, no reconciliation is needed — the platform is the source of truth.

---

## Payment History

All payment events (manual records, gateway webhooks, payment links) are logged to `payment_history`:

```sql
CREATE TABLE payment_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  amount         DECIMAL(10,2),
  currency       VARCHAR(3),
  payment_method VARCHAR(50),      -- 'manual', 'stripe', 'paypal', 'dpo', etc.
  gateway_id     VARCHAR(100),
  gateway_ref    VARCHAR(255),     -- transaction ID from gateway
  period_months  INT,
  new_expiry     DATE,
  recorded_by    UUID,             -- admin user ID (null if webhook)
  recorded_at    TIMESTAMP DEFAULT NOW(),
  notes          TEXT
);
```

---

## Database Schema Changes

```sql
-- Add gateway and payment fields to subscriptions table
ALTER TABLE subscriptions ADD COLUMN
  gateway_id          VARCHAR(100),      -- FK to gateway_configs table
  external_billing_id VARCHAR(255),      -- recurring subscription ID in gateway
  billing_mode        VARCHAR(20) DEFAULT 'manual',  -- 'manual'|'once_off'|'recurring'
  renewal_amount      DECIMAL(10,2),
  renewal_currency    VARCHAR(3) DEFAULT 'USD',
  last_payment_date   DATE,
  last_payment_ref    VARCHAR(255);

-- Payment gateway configurations
CREATE TABLE gateway_configs (
  id           VARCHAR(100) PRIMARY KEY,  -- e.g. "stripe_main", "dpo_africa"
  provider     VARCHAR(50) NOT NULL,      -- 'stripe'|'paypal'|'dpo'|'chargebee'|'paddle'
  display_name VARCHAR(100) NOT NULL,
  enabled      BOOLEAN DEFAULT TRUE,
  config       JSONB NOT NULL,            -- encrypted credentials
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);
```

---

## Implementation Checklist

### Phase 1 — Manual + Basic Gateway

- [ ] Implement manual renewal API (`PATCH /subscription` with `expiry_date`)
- [ ] Implement payment history logging
- [ ] Implement gateway_configs table + admin UI to add/edit gateways
- [ ] Implement per-customer gateway assignment
- [ ] Implement Stripe webhook handler + signature verification
- [ ] Implement PayPal webhook handler + signature verification
- [ ] Implement DPO webhook handler + token verification
- [ ] Implement "Send Payment Link" API + email delivery
- [ ] Implement client panel "Renew Now" flow (redirect to gateway checkout)
- [ ] Test all webhook handlers with sandbox/test mode

### Phase 2 — Recurring Billing + Reconciliation

- [ ] Implement recurring subscription support (Stripe Subscriptions, PayPal Subscriptions, DPO tokenisation)
- [ ] Implement daily reconciliation CronJob (recurring customers only)
- [ ] Add Chargebee, Paddle webhook handlers
- [ ] Add webhook delivery status monitoring

### Testing

- [ ] Test manual renewal (no gateway) — admin sets expiry directly
- [ ] Test payment link flow (all 3 gateways) — end-to-end with sandbox
- [ ] Test client panel checkout flow
- [ ] Test webhook signature verification (valid + invalid)
- [ ] Test idempotency — same webhook delivered twice does not double-renew
- [ ] Test grace period — service continues 7 days after expiry
- [ ] Test auto-suspend after grace period (if configured)
- [ ] Test reconciliation job — mismatched state is corrected

---

## Related Documents

- [`./BILLING_MODEL_CHANGES.md`](./BILLING_MODEL_CHANGES.md) — Summary of billing model changes
- [`../04-deployment/SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md`](../04-deployment/SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md) — Admin alerts for expiring subscriptions
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Admin panel subscription management UI
- [`../02-operations/CLIENT_PANEL_FEATURES.md`](../02-operations/CLIENT_PANEL_FEATURES.md) — Client panel renewal flow

---

**Status:** Ready for implementation  
**Estimated Development Time:** 2–3 weeks (manual + 3 gateways + client panel flow + testing)  
**Next Step:** Implement manual renewal API first, then add gateway support incrementally
