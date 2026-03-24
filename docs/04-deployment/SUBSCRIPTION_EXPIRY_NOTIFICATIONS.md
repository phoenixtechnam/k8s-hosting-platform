# Subscription Expiry Notifications

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** DevOps engineers, backend developers, operations team

---

## Overview

The platform sends automated **admin notifications** when customer subscriptions are about to expire. This allows admins to proactively renew subscriptions or handle expired accounts.

**Key principles:**
- Notifications are **admin-only** (not sent to customers directly). Admins handle customer communication.
- The notification system works **regardless of billing mode** — whether the customer is on manual billing, has a payment gateway assigned, or uses recurring gateway subscriptions.
- Notification actions are tailored to the customer's billing mode (e.g., "Renew Manually" for manual customers, "Send Payment Link" for gateway customers).

---

## Notification Schedule

### Default Timeline

| Days Before Expiry | Action | Notification |
|-------------------|--------|--------------|
| **60 days** | First reminder | Slack + Email |
| **30 days** | Second reminder | Slack + Email |
| **7 days** | Final warning | Slack + Email + highlighted in admin dashboard |
| **0 days (expiry)** | Subscription expires | Alert + automatic action |
| **+7 days** | Escalation | Urgent alert if still not renewed |

### Example

Customer subscription expires on **2026-03-01**:
- **2025-12-01** — Day 60 alert: "Acme Corp subscription expires in 60 days"
- **2026-02-01** — Day 30 alert: "Acme Corp subscription expires in 30 days"
- **2026-02-22** — Day 7 alert: "FINAL WARNING: Acme Corp subscription expires in 7 days"
- **2026-03-01** — Expiry alert: "Acme Corp subscription HAS EXPIRED"
- **2026-03-08** — Escalation: "Acme Corp still expired, consider disabling"

---

## Notification Channels

### 1. Slack Notifications

**Default:** Sent to `#billing` or `#ops` channel

**Example message (Day 30, manual billing):**

```
🔔 Subscription Expiring Soon

Customer: Acme Corp (client_001)
Plan: Business
Expiry Date: 2026-03-01
Days Remaining: 30
Billing Mode: Manual

Action: Collect payment and renew manually in Admin Panel

Review: https://admin.platform.com/customers/client_001
Renew:  https://admin.platform.com/customers/client_001/subscription/renew
```

**Example message (Day 30, gateway assigned):**

```
🔔 Subscription Expiring Soon

Customer: Beta Ltd (client_002)
Plan: Business
Expiry Date: 2026-03-01
Days Remaining: 30
Billing Mode: Once-Off (DPO)

Actions:
  • Send Payment Link: https://admin.platform.com/customers/client_002/subscription/send-link
  • Renew Manually:   https://admin.platform.com/customers/client_002/subscription/renew
```

**Example message (Expiry):**

```
⚠️  SUBSCRIPTION EXPIRED

Customer: Acme Corp (client_001)
Plan: Business
Expiry Date: 2026-03-01
Days Overdue: 0

Status: EXPIRED — Service active for 7 more days (grace period)

Actions:
1. Renew manually in Admin Panel
2. Send payment link to customer (if gateway assigned)
3. Suspend if not renewing

Renew: https://admin.platform.com/customers/client_001/subscription/renew
```

### 2. Email Notifications

**Recipient:** Admin email(s) from OIDC/Dex

**Example email (Day 30):**

```
Subject: Subscription Expiring in 30 Days — Acme Corp

Dear Admin,

Customer Acme Corp's subscription will expire on 2026-03-01 (30 days from now).

Plan: Business ($19.99/month)
Expiry: 2026-03-01
Current Status: Active
Billing Mode: Manual

Action Required:
1. Contact customer to confirm renewal
2. Collect payment (EFT, invoice, or via payment gateway if assigned)
3. Renew in Admin Panel: set new expiry date and record payment

Renew manually:     https://admin.platform.com/customers/client_001/subscription/renew
Send payment link:  https://admin.platform.com/customers/client_001/subscription/send-link

Questions? Contact billing@company.com

— Platform Admin System
```

### 3. Admin Dashboard

**Alert badge:** Displayed in admin dashboard

```
┌─────────────────────────────────┐
│ Subscription Alerts              │
├─────────────────────────────────┤
│                                 │
│ 🔴 EXPIRED (1)                  │
│   • Acme Corp — 7 days overdue  │
│                                 │
│ 🟡 EXPIRING (3)                 │
│   • Beta Inc — 7 days           │
│   • Gamma LLC — 30 days         │
│   • Delta Corp — 60 days        │
│                                 │
│ View All → [Link]               │
└─────────────────────────────────┘
```

---

## Implementation

### CronJob Schedule

**Kubernetes CronJob runs daily at 2 AM UTC**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: subscription-expiry-check
  namespace: hosting
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: subscription-checker
          containers:
          - name: checker
            image: platform/subscription-checker:latest
            env:
            - name: SLACK_WEBHOOK
              valueFrom:
                secretKeyRef:
                  name: slack-webhooks
                  key: billing-channel
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: connection-string
          restartPolicy: OnFailure
```

### Notification Logic

```python
from datetime import datetime, timedelta
import requests

def check_subscription_expirations():
    """Run daily to check all subscriptions and send notifications"""
    
    customers = get_all_active_customers()
    
    for customer in customers:
        expiry_date = customer.subscription.expiry_date
        days_until = (expiry_date - datetime.now()).days
        
        # Determine notification tier
        notification_sent = customer.subscription.renewal_reminder_sent
        
        if days_until == 60 and not notification_sent:
            send_notification(customer, "day_60")
            mark_reminder_sent(customer, "day_60")
        
        elif days_until == 30 and not notification_sent:
            send_notification(customer, "day_30")
            mark_reminder_sent(customer, "day_30")
        
        elif days_until == 7 and not notification_sent:
            send_notification(customer, "day_7_final_warning")
            mark_reminder_sent(customer, "day_7")
        
        elif days_until <= 0 and customer.subscription.status == 'active':
            # Subscription expired
            customer.subscription.status = 'expired'
            customer.save()
            send_notification(customer, "expired")
        
        elif days_until < -7 and customer.subscription.status == 'expired':
            # Escalation: 7+ days overdue
            send_notification(customer, "escalation_overdue")
            log_escalation(customer)

def send_notification(customer, notification_type):
    """Send Slack + Email notification"""
    
    message = build_message(customer, notification_type)
    
    # Slack
    send_slack(message)
    
    # Email
    send_email(
        recipients=get_admin_emails(),
        subject=f"{notification_type.title()}: {customer.name}",
        body=message
    )
```

### Database Changes

**Add fields to subscription table:**

```sql
ALTER TABLE subscriptions ADD COLUMN (
  day_60_reminder_sent BOOLEAN DEFAULT FALSE,
  day_30_reminder_sent BOOLEAN DEFAULT FALSE,
  day_7_reminder_sent BOOLEAN DEFAULT FALSE,
  expiry_alert_sent BOOLEAN DEFAULT FALSE,
  last_notification_date TIMESTAMP
);
```

---

## Notification Templates

### Day 60 Reminder

**Slack:**
```
🔔 Subscription Expiring in 60 Days
Customer: {name} (ID: {id})
Plan: {plan}
Expiry: {expiry_date}
Action: Monitor
```

**Email:**
```
Subject: Upcoming Subscription Renewal — {name}

Subscription expires in 60 days.
No action required yet. Will send reminder at day 30.

Plan: {plan}
Expires: {expiry_date}
```

### Day 30 Reminder

**Slack:**
```
🟡 Subscription Expiring in 30 Days
Customer: {name} (ID: {id})
Plan: {plan}
Expiry: {expiry_date}
Action: Begin renewal process
```

**Email:**
```
Subject: Renew Subscription in 30 Days — {name}

Subscription expires in 30 days.
Consider contacting customer to renew.

Plan: {plan}
Expires: {expiry_date}

Renew: https://admin.platform.com/customers/{id}/subscription
```

### Day 7 Final Warning

**Slack:**
```
🔴 FINAL WARNING: Subscription Expires in 7 Days
Customer: {name} (ID: {id})
Plan: {plan}
Expiry: {expiry_date}
Action: Contact customer immediately
```

**Email:**
```
Subject: FINAL WARNING: Renew {name} in 7 Days

FINAL NOTICE: Subscription expires in 7 days.

If customer does not renew, service will be disabled on {expiry_date}.

Plan: {plan}
Expires: {expiry_date}

Actions:
1. Contact customer: {email}
2. Process renewal in billing platform
3. Update in admin panel

Renew: https://admin.platform.com/customers/{id}/subscription
```

### Expiry Alert

**Slack:**
```
🚨 SUBSCRIPTION EXPIRED
Customer: {name} (ID: {id})
Plan: {plan}
Expired: {expiry_date}
Status: EXPIRED — Service active until {grace_period_date}

Action: URGENT — Contact customer or disable service
```

**Email:**
```
Subject: URGENT: {name} Subscription Has Expired

SUBSCRIPTION EXPIRED

Service remains active for 7 more days.

Customer: {name}
Plan: {plan}
Expired: {expiry_date}
Grace Period Until: {grace_period_date}

Actions:
1. Contact customer immediately at {email}
2. Renew in external billing platform
3. If no renewal by {grace_period_date}, service will be disabled

Urgent: https://admin.platform.com/customers/{id}
```

### Escalation (7+ Days Overdue)

**Slack:**
```
🔴 ESCALATION: {name} Subscription Overdue 7+ Days
Customer: {name} (ID: {id})
Overdue Since: {expiry_date}
Days Overdue: {days_overdue}
Status: EXPIRED

Recommended Action: Disable service immediately
```

---

## Configuration

### Admin Email List

**Option 1: From OIDC/Dex**
```yaml
# All users with 'admin' role receive notifications
admins = get_users_by_role('admin')
email_list = [u.email for u in admins]
```

**Option 2: Explicit List**
```yaml
SUBSCRIPTION_ALERT_EMAILS:
  - billing@company.com
  - ops-lead@company.com
  - cto@company.com
```

### Slack Channel

```yaml
SLACK_WEBHOOK_BILLING: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX"
SLACK_CHANNEL: "#billing"  # or "#ops"
```

### Notification Thresholds (Configurable)

```yaml
SUBSCRIPTION_NOTIFICATION_SCHEDULE:
  day_60: true   # Send 60-day warning
  day_30: true   # Send 30-day warning
  day_7: true    # Send 7-day final warning
  day_0: true    # Send expiry alert
  day_minus_7: true  # Send escalation alert if overdue

GRACE_PERIOD_DAYS: 7  # Service remains active 7 days after expiry
```

---

## Edge Cases and Handling

### Case 1: Subscription Renewed Before Notification Sent

**Scenario:**
- Subscription day 30 alert scheduled
- Customer renews subscription overnight
- Next day, CronJob checks subscription

**Handling:**
```python
if days_until > 30:
    # Subscription was renewed, skip notification
    return

elif days_until <= 30 and not notification_sent:
    # Still within window, send notification
    send_notification(customer, "day_30")
```

### Case 2: Webhook Updates Subscription During CronJob

**Scenario:**
- CronJob runs at 2 AM
- Webhook updates subscription at 2:05 AM
- Notification already sent at 2:01 AM

**Handling:**
```python
# Mark reminder as sent before processing
mark_reminder_sent(customer, "day_30")

# If webhook arrives after, it resets the flag
def handle_billing_webhook():
    customer.subscription.renewal_reminder_sent = False
    # Next CronJob will check if still needed
```

### Case 3: Subscription Renewed (Manual or Gateway)

**Scenario:**
- Admin renews subscription manually in Admin Panel (or via API), OR
- Gateway webhook updates the subscription after a successful payment

**Handling:**
```python
# PATCH /api/v1/clients/{id}/subscription (manual)
# OR webhook handler (gateway payment)
def update_subscription():
    # Reset all reminder flags whenever subscription is extended
    customer.subscription.renewal_reminder_sent = False
    customer.subscription.day_60_reminder_sent = False
    customer.subscription.day_30_reminder_sent = False
    customer.subscription.day_7_reminder_sent = False
    # CronJob will not send further reminders until new expiry approaches
```

### Case 4: Multiple Notifications for Same Tier

**Prevention:**
```python
# Only send if specifically NOT sent yet
if days_until == 30 and not customer.subscription.day_30_reminder_sent:
    send_notification(...)
    customer.subscription.day_30_reminder_sent = True
    customer.save()

# Multiple CronJob runs won't duplicate
```

---

## Monitoring and Alerting

### CronJob Health

**Alert if CronJob fails 3 days in a row:**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: subscription-check-alerts
spec:
  groups:
  - name: subscriptions
    rules:
    - alert: SubscriptionCheckJobFailed
      expr: |
        increase(subscription_check_job_failures_total[3d]) >= 3
      annotations:
        summary: "Subscription check job has failed 3 days in a row"
```

### Notification Delivery

**Monitor Slack/email delivery:**

```
prometheus_metrics:
  - subscription_notifications_sent{channel="slack"}
  - subscription_notifications_sent{channel="email"}
  - subscription_notifications_failed{channel="slack"}
  - subscription_notifications_failed{channel="email"}
```

---

## Testing

### Unit Test: Notification Timing

```python
def test_day_30_notification():
    # Create customer, subscription expires in 30 days
    customer = create_test_customer(
        subscription_expiry = today + 30 days
    )
    
    check_subscription_expirations()
    
    assert customer.day_30_reminder_sent == True
    assert slack_message_sent('Expiring in 30 Days')
    assert email_sent(customer, 'day_30')
```

### Integration Test: CronJob Execution

```python
def test_cronjob_runs_daily():
    # Deploy CronJob
    # Wait 24 hours
    # Check:
    # - CronJob executed
    # - Database updated
    # - Notifications sent
    # - No errors in logs
```

### Manual Test: Send Test Notification

```bash
# Trigger notification manually for testing
kubectl exec -it deployment/management-api -- \
  python -c "from jobs import subscription_check; subscription_check.check_subscription_expirations()"
```

---

## Implementation Checklist

- [ ] Create subscription notification database schema
- [ ] Implement CronJob for daily subscription checks
- [ ] Set up Slack webhook integration
- [ ] Configure admin email list
- [ ] Create notification templates
- [ ] Implement edge case handling (renewal mid-notification)
- [ ] Add Prometheus metrics for job health
- [ ] Add dashboard widget showing expiring subscriptions
- [ ] Test notification delivery (Slack, email)
- [ ] Document notification configuration
- [ ] Train ops team on handling notifications

---

## Related Documents

- [`../01-core/EXTERNAL_BILLING_INTEGRATION.md`](../01-core/EXTERNAL_BILLING_INTEGRATION.md) — Gateway integration, webhook handlers, manual and once-off payment flows
- [`../01-core/BILLING_MODEL_CHANGES.md`](../01-core/BILLING_MODEL_CHANGES.md) — Billing model overview and changes
- [`./MANAGEMENT_API_SPEC.md`](./MANAGEMENT_API_SPEC.md) — Subscription update API
- [`../02-operations/ADMIN_PANEL_REQUIREMENTS.md`](../02-operations/ADMIN_PANEL_REQUIREMENTS.md) — Manual renewal UI, send payment link, gateway management
- [`../02-operations/MONITORING_OBSERVABILITY.md`](../02-operations/MONITORING_OBSERVABILITY.md) — CronJob health monitoring
- [`../04-deployment/INCIDENT_RESPONSE_RUNBOOK.md`](../04-deployment/INCIDENT_RESPONSE_RUNBOOK.md) — Handling billing system issues

---

**Status:** Ready for implementation  
**Estimated Development Time:** 1 week (CronJob + notifications + testing)  
**Note:** No external billing platform is required. Notification system works in all billing modes (manual, once-off, recurring).
