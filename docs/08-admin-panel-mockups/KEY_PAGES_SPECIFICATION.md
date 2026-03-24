# Key Admin Panel Pages Specification

## Overview

This document details the layout, components, and interactions for the most critical admin panel pages based on the ADMIN_PANEL_REQUIREMENTS.md specifications.

---

## Table of Contents

1. [Dashboard Page](#dashboard-page)
2. [Clients Management Page](#clients-management-page)
3. [Client Details Page](#client-details-page)
4. [Clusters Management Page](#clusters-management-page)
5. [Cluster Details Page](#cluster-details-page)
6. [Workloads Management Page](#workloads-management-page)
7. [Applications Catalog Page](#applications-catalog-page)
8. [Application Instances Page](#application-instances-page)
9. [Storage & Database Page](#storage--database-page)
10. [Monitoring & Alerts Page](#monitoring--alerts-page)

---

## Dashboard Page

**URL:** `/admin/dashboard`  
**Role:** All Admin Users  
**Refresh Rate:** 30 seconds

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Dashboard                                                   [AD] │
├─────────────────────────────────────────────────────────────────┤
│ Home / Dashboard                                                 │
│                                                                  │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐│
│ │ Total Clients│ │Active Subs   │ │Cluster Health│ │ Storage  ││
│ │     248      │ │     235      │ │    99.8%     │ │ 4.2TB    ││
│ │ ↑ 12 /month │ │ 98.8% retain │ │ ✓ Normal     │ │ of 10TB  ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
│                                                                  │
│ Cluster Status                                    [+ Add Cluster]│
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Region    │Status│Nodes│CPU│Memory│Storage    │Uptime │Actn│
│ ├────────────────────────────────────────────────────────────┤  │
│ │ US East   │  ✓  │  6  │68%│ 54%  │2.1/4 TB   │98.2%  │Mgn│
│ │ EU West   │  ✓  │  4  │45%│ 38%  │1.8/3 TB   │99.5%  │Mgn│
│ │ Asia-Pac  │  ⚠  │  3  │82%│ 71%  │2.8/3 TB   │97.3%  │Mgn│
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Recent Clients                                   [+ Add Client]  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Client Name     │Email       │Plan     │Status  │Storage │Acn│
│ ├────────────────────────────────────────────────────────────┤  │
│ │ Tech Startup    │...         │Premium  │Active  │180/500 │Vie│
│ │ Design Agency   │...         │Business │Active  │32/50   │Vie│
│ │ Local Services  │...         │Starter  │Active  │2.8/5   │Vie│
│ │ Enterprise Corp │...         │Premium  │Suspend │450/500 │Vie│
│ │ Web Solutions   │...         │Business │Expiring│38/50   │Vie│
│ └────────────────────────────────────────────────────────────┘  │
│ [1] [2] [3] ... [24] [Next]                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Key Metrics (Stats Cards)

| Metric | Label | Format | Update |
|--------|-------|--------|--------|
| Total Clients | Total Clients | # (248) | Daily |
| Active Subscriptions | Active Subscriptions | # (235) | Real-time |
| Cluster Health | Cluster Health | % (99.8%) | 5 min |
| Storage Used | Storage Used | GB (4.2TB of 10TB) | 5 min |

### Additional Cards (Phase 2)

| Metric | Label | Format |
|--------|-------|--------|
| Revenue this Month | Monthly Revenue | $ |
| New Signups | New Clients | # |
| Alerts | System Alerts | # |
| Expiring Soon | Expiring Subscriptions | # |

### Table Interactions

- Click "Manage" → Go to Cluster Details
- Click "+ Add Cluster" → Show Add Cluster modal
- Click "View" in Recent Clients → Go to Client Details
- Click "+ Add Client" → Show Add Client modal

---

## Clients Management Page

**URL:** `/admin/clients`  
**Role:** Admin, Billing Admin, Support Admin  
**Permissions:** View all, Create, Edit, Suspend, Delete

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Clients                                                    [AD]   │
├─────────────────────────────────────────────────────────────────┤
│ Home / Clients                                                   │
│                                                                  │
│ Search [───────────────────────] [Filter ▼] [Add Client ✓]    │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Client Name    │Email           │Plan      │Status  │Subs  │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ [x] Tech Start │...@tech.com    │Premium   │Active  │12d   │  │
│ │ [x] Design Ag  │...@design.com  │Business  │Active  │45d   │  │
│ │ [x] Local Svc  │...@local.com   │Starter   │Active  │19d   │  │
│ │ [x] Enterprise │...@enter.com   │Premium   │Suspend │EXP   │  │
│ │ [x] Web Sol    │...@web.com     │Business  │Warning │3d    │  │
│ │ [x] Start Up 2 │...@startup2.com│Starter   │Active  │150d  │  │
│ │ [x] Agency Pro │...@agency.com  │Business  │Active  │60d   │  │
│ │ [x] Corp Ltd   │...@corp.com    │Premium   │Active  │200d  │  │
│ │ [x] SaaS Co    │...@saas.com    │Premium   │Active  │90d   │  │
│ │ [x] Shop Co    │...@shop.com    │Business  │Active  │30d   │  │
│ └────────────────────────────────────────────────────────────┘  │
│ [1] [2] [3] ... [25] [Next] | Showing 10-20 of 248            │
└─────────────────────────────────────────────────────────────────┘
```

### Filter Options

**Dropdowns:**
- Plan: All / Starter / Business / Premium
- Status: All / Active / Suspended / Cancelled
- Subscription Status: All / Active / Expiring Soon / Expired
- Sort By: Name / Created Date / Expiry Date / Storage Used

### Table Columns

| Column | Width | Sortable | Filterable | Actions |
|--------|-------|----------|-----------|---------|
| Checkbox | 40px | No | No | Select all |
| Client Name | 200px | Yes | No | Link → Details |
| Email | 250px | No | No | Contact link |
| Plan | 100px | Yes | Yes | Show plan details |
| Status | 100px | Yes | Yes | Badge color |
| Days Until Expiry | 80px | Yes | Yes | Show count + date |
| Storage Usage | 120px | Yes | No | Show bar + % |
| Actions | 120px | No | No | View, Edit, More |

### Action Menu (Right-click or "...">)

- View Details
- Edit Information
- Change Plan
- Renew Subscription
- Suspend Account
- Send Message
- View Backups
- View Activity Log
- Delete Account (Dangerous)

### Bulk Actions (When checkboxes selected)

- Suspend Selected
- Delete Selected
- Send Email
- Renew Subscription
- Change Plan

### Search Behavior

- Searches: Name, Email, Domain
- Displays results as you type
- Shows result count
- Can refine with filters

---

## Client Details Page

**URL:** `/admin/clients/:clientId`  
**Role:** Admin, Support Admin  
**Permissions:** View, Edit, Manage Resources

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Tech Startup Inc                              [Edit] [...]      │
├─────────────────────────────────────────────────────────────────┤
│ Home / Clients / Tech Startup Inc                                │
│                                                                  │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐  │
│ │ Overview         │  │ Account Information                  │  │
│ │ Workloads        │  │ ┌──────────────────────────────────┐│  │
│ │ Applications     │  │ │ Name: Tech Startup Inc          ││  │
│ │ Backups          │  │ │ Email: admin@techstartup.com    ││  │
│ │ Billing          │  │ │ Plan: Premium                   ││  │
│ │ Activity Log     │  │ │ Status: Active                  ││  │
│ │ Settings         │  │ │ Created: Jan 15, 2023           ││  │
│ │                  │  │ │ Country: United States          ││  │
│ │                  │  │ └──────────────────────────────────┘│  │
│ │                  │  │ ┌──────────────────────────────────┐│  │
│ │                  │  │ │ Subscription Information         ││  │
│ │                  │  │ │ Plan: Premium ($49.99/mo)      ││  │
│ │                  │  │ │ Status: Active ✓                ││  │
│ │                  │  │ │ Expires: Dec 15, 2024 (12 days) ││  │
│ │                  │  │ │ Auto Renew: Yes                 ││  │
│ │                  │  │ │ Next Billing: Dec 15, 2024      ││  │
│ │                  │  │ │ [Renew] [Change Plan] [Cancel]  ││  │
│ │                  │  │ └──────────────────────────────────┘│  │
│ │                  │  │ ┌──────────────────────────────────┐│  │
│ │                  │  │ │ Resource Usage                   ││  │
│ │                  │  │ │ Storage: 180GB / 500GB (36%)     ││  │
│ │                  │  │ │ Domains: 8 / Unlimited          ││  │
│ │                  │  │ │ Databases: 5 / 10                ││  │
│ │                  │  │ │ Email Accounts: 12 / Unlimited   ││  │
│ │                  │  │ │ Backups: 45 (Last: 2h ago)      ││  │
│ │                  │  │ └──────────────────────────────────┘│  │
│ └──────────────────┘  └──────────────────────────────────────┘  │
│                                                                  │
│ [Rest of page shows detailed content for selected section]      │
└─────────────────────────────────────────────────────────────────┘
```

### Left Sidebar Tabs

1. **Overview** (Current)
   - Account info
   - Subscription status
   - Resource usage
   - Quick actions

2. **Workloads**
   - List of deployed workloads (PHP, Node, Python, etc.)
   - Status, resources, actions
   - Deploy new workload

3. **Applications**
   - List of installed applications (Nextcloud, Gitea, etc.)
   - Status, version, actions
   - Install new app

4. **Backups**
   - Backup history
   - Restore options
   - Manual backup button

5. **Billing**
   - Invoice history
   - Payment method
   - Usage-based charges

6. **Activity Log**
   - All actions on this account
   - Date, user, action, result
   - Search and filter

7. **Settings**
   - Account preferences
   - Notification settings
   - API keys
   - Security options

### Overview Tab - Sections

#### Account Information
- Name (editable)
- Email (editable)
- Plan (dropd own to change)
- Status (Active/Suspended/Cancelled)
- Created Date
- Location/Country

#### Subscription Information
- Plan Name + Price
- Status (Active/Expiring/Expired)
- Expiry Date + countdown
- Auto-renewal toggle
- Next billing date
- [Renew Subscription] [Change Plan] [Cancel Subscription]

#### Resource Usage
- Storage: bar chart + percentage + GB
- Domains: count / limit
- Databases: count / limit
- Email accounts: count / limit
- Backups: count + last backup timestamp

#### Quick Actions
- Send Message
- Generate Report
- Suspend Account
- Force Resync
- Manage API Keys
- View Security Log

---

## Clusters Management Page

**URL:** `/admin/clusters`  
**Role:** Admin, DevOps Admin  
**Permissions:** View all, Add, Manage

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Kubernetes Clusters                                       [AD]   │
├─────────────────────────────────────────────────────────────────┤
│ Home / Clusters                                                  │
│                                                                  │
│ Search [───────────────────────] [Add Cluster ✓]               │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Cluster   │Region    │Status │Nodes │CPU  │Mem │Storage  │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ prod-us   │US East   │  ✓   │  6   │68%  │54% │2.1/4 TB │  │
│ │ prod-eu   │EU West   │  ✓   │  4   │45%  │38% │1.8/3 TB │  │
│ │ prod-apac │Asia Pac  │  ⚠   │  3   │82%  │71% │2.8/3 TB │  │
│ │ staging   │US East   │  ✓   │  2   │25%  │20% │0.5/1 TB │  │
│ └────────────────────────────────────────────────────────────┘  │
│ [1] [2] [Next]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Table Details

| Column | Spec |
|--------|------|
| Cluster Name | Link → Cluster Details |
| Region | AWS region or location |
| Status | Health indicator (✓/⚠/✗) + text |
| Node Count | Total k8s nodes |
| CPU Usage | % with bar |
| Memory Usage | % with bar |
| Storage Usage | Used / Total |
| Uptime | % this month |
| Actions | Manage, Details, Edit, Settings |

### Action Modal Options

- View Cluster Details
- Manage Nodes
- View Metrics
- Cluster Settings
- Add Node
- Remove Cluster
- Scale Cluster

---

## Cluster Details Page

**URL:** `/admin/clusters/:clusterId`  
**Role:** Admin, DevOps Admin  
**Permissions:** View, Manage

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ prod-us (US East)                          [Settings] [...] [<-]│
├─────────────────────────────────────────────────────────────────┤
│ Home / Clusters / prod-us                                        │
│                                                                  │
│ ┌──────────────────┐  ┌────────────────────────────────────────┐│
│ │ Overview         │  │ Cluster Status                         ││
│ │ Nodes            │  │ ┌──────────────────────────────────────┐│
│ │ Namespaces       │  │ │ Status: Healthy ✓                    ││
│ │ Storage          │  │ │ K8s Version: v1.28.4                ││
│ │ Networking       │  │ │ Uptime: 99.8% this month            ││
│ │ Monitoring       │  │ │ Created: Jan 1, 2023                ││
│ │ Logs             │  │ │ Control Plane: 3 nodes              ││
│ │ Settings         │  │ │ Worker Nodes: 6 nodes               ││
│ │                  │  │ │                                      ││
│ │                  │  │ │ CPU: 68% (24 of 35 cores)           ││
│ │                  │  │ │ Memory: 54% (54 of 100 Gi)          ││
│ │                  │  │ │ Storage: 2.1TB / 4TB                ││
│ │                  │  │ │ Pods: 345 running / 358 total       ││
│ │                  │  │ │                                      ││
│ │                  │  │ │ [Scale Cluster] [Add Node] [Upgrade]││
│ │                  │  │ └──────────────────────────────────────┘│
│ │                  │  │                                         │
│ │                  │  │ Cluster Metrics (24h)                 ││
│ │                  │  │ ┌──────────────────────────────────────┐│
│ │                  │  │ │ [CPU Graph]  [Memory Graph]          ││
│ │                  │  │ │ [Network In/Out]                     ││
│ │                  │  │ └──────────────────────────────────────┘│
│ └──────────────────┘  └────────────────────────────────────────┘│
│                                                                  │
│ [Details for selected tab shown below]                          │
└─────────────────────────────────────────────────────────────────┘
```

### Tabs

1. **Overview** - Cluster status, metrics
2. **Nodes** - Worker node list, manage
3. **Namespaces** - K8s namespaces (one per client)
4. **Storage** - Block storage (Longhorn), Backup storage (offsite server)
5. **Networking** - Ingress, load balancer, DNS
6. **Monitoring** - Prometheus metrics, Grafana dashboards
7. **Logs** - Cluster logs, audit logs, container logs
8. **Settings** - Cluster configuration, upgrades, maintenance

### Nodes Table (Nodes Tab)

| Column | Spec |
|--------|------|
| Node Name | Link → Node Details |
| IP Address | Internal IP |
| Status | Ready/NotReady |
| CPU | cores used / total |
| Memory | Gi used / total |
| Storage | Gi used / total |
| Pods | count running / allocated |
| Uptime | days |
| Actions | Details, Drain, Delete |

---

## Workloads Management Page

**URL:** `/admin/workloads`  
**Role:** Admin, DevOps Admin  
**Permissions:** View, Manage, Publish

### Workload Types

- Apache + PHP (7.4, 8.0, 8.1, 8.2, 8.3, 8.4)
- Node.js (20, 22)
- Python (3.11, 3.12)
- Ruby (3.4)
- .NET (9.0)
- Java (21)
- Static (HTML/CSS/JS)

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Workload Container Images                               [AD]    │
├─────────────────────────────────────────────────────────────────┤
│ Home / Workloads                                                 │
│                                                                  │
│ Search [───────────────────────] [Add Workload ✓]              │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Workload         │Version │Status │Usage  │Clients │Action │  │
│ ├────────────────────────────────────────────────────────────┤  │
│ │ Apache + PHP     │8.2     │Active │1,247  │   45   │Manage │  │
│ │ Apache + PHP     │8.3     │Active │ 892   │   28   │Manage │  │
│ │ Apache + PHP     │8.4     │Active │ 456   │   15   │Manage │  │
│ │ Apache + PHP     │7.4     │Deprecated  │ 78   │    3   │Deprec │  │
│ │ Node.js          │20      │Active │ 234   │    8   │Manage │  │
│ │ Node.js          │22      │Active │ 156   │    5   │Manage │  │
│ │ Python           │3.12    │Active │ 123   │    4   │Manage │  │
│ │ Ruby             │3.4     │Active │  45   │    2   │Manage │  │
│ │ Static           │Latest  │Active │ 678   │   22   │Manage │  │
│ └────────────────────────────────────────────────────────────┘  │
```

### Table Columns

| Column | Spec |
|--------|------|
| Workload Type | Name of language/runtime |
| Version | Specific version |
| Status | Active / Deprecated / Maintenance |
| Usage | # pods running with this workload |
| Clients | # clients using this workload |
| Last Updated | When image was updated |
| Actions | View Details, Edit, Deprecate, Delete |

### Workload Details Card

- Workload Type & Version
- Base Image SHA256
- Installed Extensions (PHP, Node packages, Python modules)
- Dependencies
- Last Updated
- Build Info
- Security Scan Status (Trivy)
- Vulnerabilities (if any)
- Actions:
  - Publish New Version
  - Enable/Disable
  - Deprecate
  - Force Migration (move clients to new version)

---

## Applications Catalog Page

**URL:** `/admin/applications/catalog`  
**Role:** Admin  
**Permissions:** View, Manage Availability

### Application List

Available applications include:
- Nextcloud
- Gitea
- Mattermost
- Jitsi Meet
- BigBlueButton
- WordPress
- Drupal
- Magento
- PrestaShop
- WooCommerce
- Ghost
- Plone
- DokuWiki
- MediaWiki
- Mastodon
- Lemmy
- PeerTube
- Matrix Synapse
- Moodle LMS
- Gibbon LMS
- Keycloak
- And more...

### Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Application Catalog                                      [AD]    │
├─────────────────────────────────────────────────────────────────┤
│ Home / Applications / Catalog                                    │
│                                                                  │
│ Search [───────────────────────] [Filter: Available ▼]         │
│                                                                  │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐│
│ │ Nextcloud    │ │ Gitea        │ │ Mattermost   │ │ Jitsi    ││
│ │ ✓ Available  │ │ ✓ Available  │ │ ✓ Available  │ │ ⚠ Beta   ││
│ │ v28.0        │ │ v1.21        │ │ v9.4         │ │ v23.2    ││
│ │ 45 clients   │ │ 23 clients   │ │ 12 clients   │ │ 4 clients││
│ │ [Manage]     │ │ [Manage]     │ │ [Manage]     │ │ [Manage] ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
│                                                                  │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐│
│ │ BigBlueButton│ │ WordPress    │ │ Drupal       │ │ Magento  ││
│ │ ✓ Available  │ │ ✓ Available  │ │ ✓ Available  │ │ ✗ Disabled││
│ │ v3.0         │ │ v6.6         │ │ v10.2        │ │ v2.4.7   ││
│ │ 8 clients    │ │ 92 clients   │ │ 34 clients   │ │ 0 clients││
│ │ [Manage]     │ │ [Manage]     │ │ [Manage]     │ │ [Manage] ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
│                                                                  │
│ [More application cards...]                                     │
│                                                                  │
│ [1] [2] [3] ... [Next]                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Application Card Details

- App Icon/Logo
- App Name
- Current Version
- Status Badge (Available / Beta / Deprecated / Disabled)
- # of Clients Using
- Brief Description
- [Manage] button → App Management Page

### App Management Page

**URL:** `/admin/applications/:appId`

Content includes:
- App Details & Information
- Deployment Settings (defaults)
- Available Versions
- Tier Availability (Starter/Business/Premium)
- Pricing Model
- Resource Requirements
- Security Status
- Deployment Logs
- [Enable/Disable] [Publish Version] [Configure] buttons

---

## Application Instances Page

**URL:** `/admin/clients/:clientId/applications`  
**Role:** Admin, Support  
**Permissions:** View, Manage

### Instance Table

| Column | Spec |
|--------|------|
| Application | App name (Nextcloud, Gitea, etc.) |
| Version | Current version |
| URL | Access URL (link) |
| Status | Running / Stopped / Error |
| CPU | Current usage % |
| Memory | Current usage % |
| Storage | Used / Limit |
| Uptime | % or days |
| Last Backup | Date/time |
| Actions | View, Configure, Update, Backup, Delete |

### Instance Actions

- View Instance Details
- Configure Settings
- Update to New Version
- Manual Backup
- Restore from Backup
- View Logs
- Scale Resources
- Stop/Start
- Delete Instance

---

## Storage & Database Page

**URL:** `/admin/storage`  
**Role:** Admin, DevOps Admin  
**Permissions:** View, Manage

### Sections

#### 1. Storage Overview
- Total Used: X TB
- Total Capacity: Y TB
- Percentage Used
- Trend (7 day/30 day)
- Usage by Client (top 10)
- Usage by Type (Databases, Backups, Files, etc.)

#### 2. Longhorn (Block Storage)
- Volume List
- Replica Status
- Snapshot Management
- Offsite Backup Status
- Add Volume
- Configure Backup Schedule

#### 3. Offsite Backup Storage
- Backup Directory Status
- Used Space (offsite server)
- Last Backup Timestamp
- Retention Policy Settings
- Cleanup Status
- Connection Health (SSHFS / NetBird mesh)

#### 4. Databases
- MariaDB Instances
  - Size, Replicas, Backups
  - Performance Metrics
  - User Management
  
- PostgreSQL Instances
  - Size, Replicas, Backups
  - Performance Metrics
  - Extension Management

#### 5. Redis Cache
- Instances List
- Memory Usage
- Hit/Miss Ratio
- Configuration
- Sentinel Status (HA)

#### 6. Backups
- Backup Status
- Schedule Management
- Retention Policies
- Restore Operations
- Storage Used by Backups

---

## Monitoring & Alerts Page

**URL:** `/admin/monitoring`  
**Role:** Admin, DevOps Admin  
**Permissions:** View, Manage Alerts

### Sections

#### 1. System Health
- Cluster Health: CPU, Memory, Storage
- Network Health: Bandwidth, Latency
- Application Health: # healthy / total pods
- Database Health: Connection pool, query latency
- Storage Health: Disk I/O, replication lag

#### 2. Alerts
- Active Alerts (sorted by severity)
- Alert History
- Alert Rules Management
- Alert Routing/Escalation
- Alert Silencing

#### 3. Metrics Dashboards
- Prometheus Metrics
- Custom Dashboards (via Grafana)
- Query Builder
- Export/Share Dashboards

#### 4. Logs
- Log Aggregation (via Loki)
- Log Search & Filtering
- Log Export
- Log Retention Policies

#### 5. Performance Analytics
- Request Latency (p50, p95, p99)
- Error Rates
- Throughput
- Resource Usage Trends
- Capacity Planning

---

## Data Models & Structures

### Client Object

```json
{
  "id": "client-12345",
  "name": "Tech Startup Inc",
  "email": "admin@techstartup.com",
  "phone": "555-0123",
  "plan": "Premium",
  "status": "active",
  "created_at": "2023-01-15T10:30:00Z",
  "subscription": {
    "plan_id": "premium-plan",
    "status": "active",
    "expires_at": "2024-12-15T23:59:59Z",
    "auto_renew": true,
    "billing_cycle": "monthly"
  },
  "usage": {
    "storage_gb": 180,
    "domains": 8,
    "databases": 5,
    "email_accounts": 12,
    "backups": 45
  },
  "limits": {
    "storage_gb": 500,
    "domains": null,
    "databases": 10,
    "email_accounts": null
  },
  "namespace": "client-12345",
  "tags": ["vip", "paying"]
}
```

### Cluster Object

```json
{
  "id": "prod-us",
  "name": "prod-us",
  "region": "us-east-1",
  "status": "healthy",
  "k8s_version": "1.28.4",
  "created_at": "2023-01-01T00:00:00Z",
  "nodes": {
    "control_plane": 3,
    "workers": 6,
    "total": 9
  },
  "capacity": {
    "cpu_cores": 35,
    "memory_gi": 100,
    "storage_tb": 4
  },
  "usage": {
    "cpu_cores": 24,
    "memory_gi": 54,
    "storage_tb": 2.1
  },
  "pods": {
    "running": 345,
    "total": 358
  },
  "uptime_percent": 99.8,
  "metrics": {
    "last_updated": "2024-03-03T20:45:00Z",
    "cpu_percent": 68,
    "memory_percent": 54,
    "storage_percent": 52.5
  }
}
```

### Application Instance Object

```json
{
  "id": "app-nextcloud-client-12345",
  "client_id": "client-12345",
  "app_id": "nextcloud",
  "app_name": "Nextcloud",
  "version": "28.0",
  "url": "https://storage.techstartup.com",
  "status": "running",
  "created_at": "2023-06-10T14:20:00Z",
  "last_backup": "2024-03-03T19:00:00Z",
  "namespace": "client-12345",
  "pod_name": "nextcloud-12345-abc123",
  "resources": {
    "cpu_limit": "1000m",
    "memory_limit": "2Gi",
    "storage_limit": "100Gi"
  },
  "usage": {
    "cpu_percent": 15,
    "memory_percent": 62,
    "storage_gb": 42
  },
  "config": {
    "admin_user": "admin",
    "domain": "storage.techstartup.com",
    "ssl_enabled": true
  }
}
```

---

## Form Validations & Rules

### Add Client Form

| Field | Validation | Rules |
|-------|-----------|-------|
| Client Name | Required, String | Min 3, Max 100 chars |
| Email | Required, Email | Valid email format |
| Plan | Required, Select | Starter / Business / Premium |
| Password | Required, String | Min 8, uppercase, number, special |
| Auto Renew | Boolean | Default: true |

### Create Subscription Form

| Field | Validation | Rules |
|-------|-----------|-------|
| Client | Required, Select | Valid client ID |
| Plan | Required, Select | Starter / Business / Premium |
| Expires | Required, Date | Must be future date |
| Price Override | Optional, Number | > 0 or leave blank |

### Change Plan Form

| Field | Validation | Rules |
|-------|-----------|-------|
| Client | Required, Select | Valid client ID |
| Current Plan | Display only | |
| New Plan | Required, Select | Different from current |
| Effective Date | Required, Date | Today or future |
| Proration | Boolean | Auto-calculate or manual |

---

## Error Handling & Messages

### Error Types

| Type | Example | Action |
|------|---------|--------|
| 404 Not Found | Client not found | Show 404 page, suggest go back |
| 403 Forbidden | Insufficient permissions | Show permission denied message |
| 409 Conflict | Subscription already active | Show conflict details, suggest actions |
| 500 Server Error | Database connection failed | Show generic error, suggest retry |
| Network Error | Request timeout | Show offline message, auto-retry |

### Success Messages

| Action | Message |
|--------|---------|
| Client Created | "Client 'Tech Startup Inc' created successfully" |
| Subscription Renewed | "Subscription renewed until Dec 15, 2025" |
| Plan Changed | "Plan changed from Business to Premium" |
| Cluster Scaled | "Cluster scaled to 8 worker nodes" |
| Backup Restored | "Backup restored from 2 days ago" |

---

## Permission Levels

### Super Admin
- View & edit all resources
- Manage all clients
- Manage clusters
- Manage admins
- System settings

### Admin
- View & edit all client accounts
- Manage applications
- View monitoring
- Cannot: delete cluster, manage admins

### Support Admin
- View client accounts (read-only for most)
- View & manage client support tickets
- Manage backups/restore
- Cannot: suspend/delete accounts, change plans

### DevOps Admin
- Manage clusters
- Manage nodes
- View monitoring/logs
- Cannot: manage clients, change plans

### Billing Admin
- View client accounts
- Manage subscriptions
- View billing/invoices
- Cannot: manage technical resources

---

## Accessibility & Performance

### Accessibility Features

- ✓ ARIA labels for all icons
- ✓ Keyboard navigation (Tab, Enter, Escape)
- ✓ Focus indicators visible
- ✓ Color not sole indicator
- ✓ Tables have proper headers
- ✓ Form labels associated with inputs
- ✓ Error messages descriptive
- ✓ Modals trapped focus

### Performance Targets

- Page Load: < 2 seconds
- Table Load (100 rows): < 1 second
- Search Results: < 500ms
- API Response: < 1 second
- First Contentful Paint: < 1.5 seconds

### Optimization Strategies

- Lazy load table data (pagination)
- Virtual scrolling for large lists
- Debounce search (300ms)
- Cache API responses (5min)
- Code splitting by page
- Image optimization
- CSS/JS minification
- Gzip compression

---

## Related Documentation

- **ADMIN_PANEL_REQUIREMENTS.md** — Complete feature list (100+ features)
- **MANAGEMENT_API_SPEC.md** — REST API endpoints
- **TECH_STACK_SUMMARY.md** — Technology stack
- **CLIENT_PANEL_FEATURES.md** — Customer-facing panel
- **MONITORING_OBSERVABILITY.md** — Monitoring setup

---

**Last Updated:** March 3, 2026  
**Status:** Specification Phase (Ready for Development)  
**Version:** 1.0
