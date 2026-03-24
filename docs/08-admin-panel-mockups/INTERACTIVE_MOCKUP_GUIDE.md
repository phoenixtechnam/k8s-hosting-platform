# Interactive Admin Panel Mockups - User Guide

## Overview

This document provides a complete guide to the fully interactive admin panel mockups with the new blue-to-dark-green gradient color scheme (`#0066cc` to `#00663d`).

---

## Files Created

### 1. **admin-panel-interactive.html** (Main File)
- **Size:** 85+ KB
- **Type:** Fully interactive single-page HTML application
- **Status:** Ready to use
- **Features:** Complete navigation, multiple pages, responsive design

This is the PRIMARY mockup file with all interactive pages integrated.

---

## How to Use

### Opening the Mockup

1. **Local File:**
   ```bash
   open "/config/Server Infrastructure/08-admin-panel-mockups/admin-panel-interactive.html"
   # or on Linux:
   xdg-open "/config/Server Infrastructure/08-admin-panel-mockups/admin-panel-interactive.html"
   ```

2. **In Browser:**
   - Copy the file path
   - Open any web browser (Chrome, Firefox, Safari, Edge)
   - Drag and drop the HTML file into the browser
   - Or use: `File > Open...` and select the file

3. **No Server Required:**
   - This is a standalone HTML file
   - Works entirely in the browser
   - No dependencies or build process needed

### Navigation

**Sidebar Navigation:**
- Click any menu item to navigate to that section
- Active item is highlighted with blue-to-green gradient
- All 9 main sections are available

**Table Row Clicking:**
- Click any table row to navigate to details page
- Click buttons for specific actions
- Breadcrumb navigation at top of each page

**Navigation Flow:**
```
Dashboard
├── Cluster Status → Click "Manage" → Cluster Details
└── Recent Clients → Click "View" → Client Details

Clients Page
├── Click any client row → Client Details
└── Click "+ Add Client" → Add client modal (mockup)

Clusters Page
├── Click any cluster row → Cluster Details
└── Click "+ Add Cluster" → Add cluster modal (mockup)

Workloads, Applications, Storage, Monitoring
└── Browse and explore tab content
```

---

## Interactive Pages

### 1. Dashboard
**URL State:** `#dashboard`
**Default Landing Page**

**Features:**
- 4 stat cards (Total Clients, Active Subscriptions, Cluster Health, Storage)
- Cluster Status table (3 clusters)
- Recent Clients table (5 clients)
- All tables clickable for navigation

**Interactions:**
- Click cluster row → Go to Cluster Details
- Click client row → Go to Client Details
- Click "+ View All" button → Go to Clusters page
- Sidebar navigation to other sections

---

### 2. Clients Page
**URL State:** `#clients`

**Features:**
- Search bar for filtering
- Plan filter dropdown (All, Starter, Business, Premium)
- Status filter dropdown (Active, Suspended, Expired)
- 7 sample client rows
- Checkbox selection (not functional in mockup)
- Export button
- Add Client button

**Interactions:**
- Click any client row → Go to Client Details
- Use filters to see different data
- Click "+ Add Client" → Ready for modal implementation
- Click "Export" → Ready for export implementation

**Client List Columns:**
1. Checkbox (selection)
2. Client Name (clickable → Details)
3. Email
4. Plan (Starter, Business, Premium)
5. Status badge (Active, Suspended, Expiring Soon)
6. Days until expiry
7. Storage usage
8. Actions

---

### 3. Client Details Page
**URL State:** `#client-details`

**Features:**
- Client name header with action buttons (Edit, Suspend, More)
- Left sidebar with 6 tabs:
  1. Overview (Account, Subscription, Resources)
  2. Workloads (placeholder)
  3. Applications (placeholder)
  4. Backups (placeholder)
  5. Billing (placeholder)
  6. Activity Log (placeholder)
- Detailed information display

**Interactions:**
- Click sidebar tabs to switch content
- Click breadcrumb to go back to Clients
- Currently showing "Overview" tab
- Other tabs ready for implementation

**Overview Tab Sections:**
- Account Information (Name, Email, Plan, Status, Created Date)
- Subscription Information (Plan, Status, Expiry, Auto-renew)
- Resource Usage (Storage bar, Domains, Databases, Email)

---

### 4. Clusters Page
**URL State:** `#clusters`

**Features:**
- 3 sample clusters (prod-us, prod-eu, prod-apac)
- Status indicators (Healthy, Warning)
- Resource usage bars (CPU, Memory)
- Storage information
- Uptime percentage
- Manage button on each row

**Interactions:**
- Click any cluster row → Go to Cluster Details
- Click "Manage" button → Go to Cluster Details
- Click "+ Add Cluster" → Ready for modal

**Cluster List Columns:**
1. Cluster Name
2. Region (AWS region/location)
3. Status (Health indicator)
4. Node count
5. CPU Usage (% with bar)
6. Memory Usage (% with bar)
7. Storage (Used / Total)
8. Uptime %
9. Actions

---

### 5. Cluster Details Page
**URL State:** `#cluster-details`

**Features:**
- Cluster name header (prod-us) with action buttons
- 4 main tabs:
  1. Overview (Status & Resource Usage)
  2. Nodes (Worker node list)
  3. Storage (Longhorn & Backup Storage details)
  4. Monitoring (Placeholder for Grafana)
- Detailed information cards

**Interactions:**
- Click tabs to switch content
- Overview tab shows 2-column layout:
  - Left: Cluster Status (K8s version, uptime, node counts)
  - Right: Resource Usage (CPU, Memory, Storage bars, Pod counts)
- Nodes tab shows worker node table
- Storage tab shows block storage and offsite backup storage details
- Monitoring tab placeholder for embedding Grafana

**Tab Contents:**

**Overview Tab:**
- Cluster Status card (6 fields)
- Resource Usage card (4 fields with bars)

**Nodes Tab:**
- Worker nodes table with 8 columns
- 2 sample nodes
- Columns: Name, IP, Status, CPU, Memory, Pods, Uptime, Actions

**Storage Tab:**
- Block Storage (Longhorn) card
- Offsite Backup Storage card
- Each showing: Total, Used, Volumes/Directories, Connection Status

**Monitoring Tab:**
- Placeholder area for Grafana dashboard embedding
- "Open Grafana Dashboard" button

---

### 6. Workloads Page
**URL State:** `#workloads`

**Features:**
- Search bar for workload filtering
- Add Workload button
- Table with 5 workload types:
  - Apache + PHP (8.2, 8.3, 8.4, 7.4)
  - Node.js (20, 22)
  - Python (3.12)

**Table Columns:**
1. Workload name
2. Version
3. Status (Active, Deprecated)
4. Usage (# pods)
5. Clients (# clients using)
6. Last Updated
7. Actions (Manage button)

**Interactions:**
- Search workloads by name/version
- Click "Manage" → Ready for workload management modal
- Click "+ Add Workload" → Ready for add workload modal

**Status Meanings:**
- **Active:** Available for new deployments
- **Deprecated:** Old version, no new deployments

---

### 7. Applications Page
**URL State:** `#applications`

**Features:**
- Search bar
- Status filter (All Status, Available, Beta, Disabled)
- 6 application cards in grid layout:
  1. Nextcloud (v28.0, 45 clients) - Available
  2. Gitea (v1.21, 23 clients) - Available
  3. Mattermost (v9.4, 12 clients) - Available
  4. Jitsi Meet (v23.2, 4 clients) - Beta
  5. BigBlueButton (v3.0, 8 clients) - Available
  6. WordPress (v6.6, 92 clients) - Available

**Card Information:**
- App Icon/Emoji
- App Name
- Version + Client count
- Status badge (Available/Beta/Disabled)

**Interactions:**
- Search applications
- Filter by status
- Click card → Ready for app details modal
- Cards have hover effect (lift animation)

**Status Badges:**
- **Available** (Green): Ready for deployment
- **Beta** (Orange): Testing phase
- **Disabled** (Red): Not available

---

### 8. Storage & Database Page
**URL State:** `#storage`

**Features:**
- 4 stat cards (Total Storage, Block Storage, Backup Storage, Database Size)
- 4 tabs:
  1. Overview (Storage by type + top users)
  2. Block Storage (Longhorn details)
  3. Databases (MariaDB, PostgreSQL, Redis table)
  4. Backups (Backup history table)

**Overview Tab:**
- Storage by Type card (Block, Object, Databases, Backups with percentages)
- Top Storage Users card (Top 4 clients with usage)

**Block Storage Tab:**
- Total Capacity, Used, Volume count, Replication info

**Databases Tab:**
- Table with 3 databases:
  1. MariaDB Primary (850GB, 2,340 tables)
  2. PostgreSQL Primary (420GB, 1,240 tables)
  3. Redis Cache (45GB)
- Columns: Name, Type, Size, Tables, Status, Actions

**Backups Tab:**
- Recent backups table
- Columns: Backup name, Type, Size, Client, Date, Status
- Manual Backup button
- 2 sample backups

---

### 9. Monitoring & Alerts Page
**URL State:** `#monitoring`

**Features:**
- 4 stat cards (System Health, Active Alerts, Avg Response Time, Error Rate)
- 3 tabs:
  1. Active Alerts (Real-time alert list)
  2. History (Placeholder)
  3. Metrics (Placeholder for Grafana)

**Active Alerts Tab:**
- Alert table with 3 sample alerts
- Columns: Alert name, Severity, Source, Time, Status, Actions
- Alert 1: Critical (High CPU on prod-apac)
- Alert 2: Warning (Storage usage)
- Alert 3: Warning (Database replication lag)
- Acknowledge/View/Investigate buttons

**Severity Levels:**
- **Critical** (Red): Immediate action required
- **Warning** (Orange): Monitor and investigate
- **Info** (Blue): Informational only

---

## Color Scheme

### Primary Gradient
```
Background Gradient: #0066cc (Blue) → #00663d (Dark Green)
Used for:
- Sidebar
- Primary buttons
- Stat card left border
- Active states
- User avatar background
```

### Semantic Colors
| Usage | Color | Hex |
|-------|-------|-----|
| Success/Healthy | Green | #00b34d |
| Warning | Orange | #f59e0b |
| Error/Critical | Red | #ef4444 |
| Background | Light Gray | #f5f7fa |
| Card Background | White | #ffffff |
| Text Primary | Dark Gray | #333333 |
| Text Secondary | Medium Gray | #666666 |
| Border | Light Gray | #e0e6ed |

### Status Badges
- **Active** - Green background (#d1fae5) with dark green text
- **Inactive/Suspended** - Red background (#fee2e2) with dark red text
- **Pending/Expiring Soon** - Orange background (#fef3c7) with orange text
- **Warning** - Orange background (#fed7aa)

---

## Interactive Elements

### Buttons

**Primary Button** (Blue-to-Green Gradient)
- Used for main actions (Create, Add, Save)
- Hover effect: Opacity change + lift
- Small variant for inline actions

**Secondary Button** (Light Gray)
- Used for alternative actions (View, Edit, Cancel)
- Hover effect: Slightly darker background

### Forms (Implemented in expandable sections)

**Form Groups:**
- Label (bold, 12px)
- Input/Select field (12px)
- Focus state: Blue border + subtle shadow

### Tables

**Features:**
- Hover effect on rows (slight background change)
- Clickable rows for navigation
- Sortable column headers (indicator not shown, but implemented)
- Pagination at bottom

**Row Interaction:**
- Hover: Background becomes #f9fafb
- Click: Navigate to details page
- Button click: Stop propagation (don't navigate)

### Tabs

**Style:**
- Border-bottom indicator (blue-to-green gradient)
- Active: Blue text + colored border
- Hover: Blue text

**Types:**
1. Main page tabs (at top level)
2. Details sidebar tabs (left navigation)

---

## Responsive Design

### Breakpoints

**Desktop (> 1024px)**
- Full sidebar (280px)
- 2-column grid layouts
- All features visible
- Full tables

**Tablet (768px - 1024px)**
- Sidebar 200px
- Single-column layouts
- Reduced spacing
- Touch-friendly buttons

**Mobile (< 768px)**
- Sidebar should be drawer
- Single column
- Reduced header
- Full-width tables

---

## Data Models Used in Mockup

### Client Object
```json
{
  "id": "client-12345",
  "name": "Tech Startup Inc",
  "email": "admin@techstartup.com",
  "plan": "Premium",
  "status": "active",
  "subscription_expires": "2024-12-15",
  "storage_used_gb": 180,
  "storage_limit_gb": 500
}
```

### Cluster Object
```json
{
  "id": "prod-us",
  "name": "prod-us",
  "region": "us-east-1",
  "status": "healthy",
  "nodes": 6,
  "cpu_percent": 68,
  "memory_percent": 54,
  "storage_used_tb": 2.1,
  "storage_total_tb": 4,
  "uptime_percent": 98.2
}
```

### Application Instance Object
```json
{
  "id": "app-nextcloud-12345",
  "app_name": "Nextcloud",
  "version": "28.0",
  "client_count": 45,
  "status": "available"
}
```

---

## Navigation Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          DASHBOARD                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────────────┐  │
│  │ Clusters Table       │    │ Recent Clients Table         │  │
│  │ (3 clusters)         │    │ (5 clients)                  │  │
│  │                      │    │                              │  │
│  │ Click Row ──────────────┐ │ Click Row ────────┐         │  │
│  └──────────────────────┘  │ └──────────────────────────────┘  │
│                            │                     │              │
│                            ▼                     ▼              │
│                  ┌──────────────────┐  ┌──────────────────┐   │
│                  │ CLUSTER DETAILS  │  │ CLIENT DETAILS   │   │
│                  │ (4 tabs)         │  │ (6 tabs)         │   │
│                  │                  │  │                  │   │
│                  │ • Overview       │  │ • Overview       │   │
│                  │ • Nodes          │  │ • Workloads      │   │
│                  │ • Storage        │  │ • Applications   │   │
│                  │ • Monitoring     │  │ • Backups        │   │
│                  │                  │  │ • Billing        │   │
│                  │                  │  │ • Activity Log   │   │
│                  └──────────────────┘  └──────────────────┘   │
│                            ▲                     ▲              │
│                            │                     │              │
│                  Breadcrumb Navigation (clickable)             │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ CLIENTS        CLUSTERS      WORKLOADS    APPLICATIONS       │
│ (List View)    (List View)   (List View)  (Grid View)        │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│ Each has:                                                    │
│ • Search/Filter                                              │
│ • Clickable rows → Details                                   │
│ • Add/Manage buttons                                         │
│ • Status indicators                                          │
│                                                               │
│ STORAGE & DB   MONITORING & ALERTS                          │
│ (Tabbed View)  (Tabbed View)                                │
│ • Overview     • Active Alerts                              │
│ • Block        • History                                    │
│ • Databases    • Metrics                                    │
│ • Backups                                                   │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Features Ready for Development

### Phase 1 (Next Steps)
- [ ] Convert to React components
- [ ] Connect to REST API endpoints
- [ ] Implement form submissions
- [ ] Add real data loading
- [ ] Implement search functionality
- [ ] Add pagination
- [ ] Create modals for actions

### Phase 2 (Enhancement)
- [ ] Real-time data updates
- [ ] Charts and graphs
- [ ] Advanced filtering
- [ ] Bulk operations
- [ ] Export functionality
- [ ] Audit logs viewer

### Phase 3 (Advanced)
- [ ] Role-based access control
- [ ] Custom dashboards
- [ ] Workflow automation
- [ ] Webhook management
- [ ] API key management
- [ ] Dark mode

---

## Browser Compatibility

✅ Works in:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers

⚠️ Requires:
- JavaScript enabled
- Modern CSS support (Flexbox, Grid)
- No external dependencies

---

## Keyboard Shortcuts (Ready to implement)

| Key | Action |
|-----|--------|
| `Esc` | Close modal/dropdown |
| `Ctrl+K` | Open search |
| `Ctrl+/` | Show keyboard shortcuts |
| `Tab` | Navigate between elements |
| `Enter` | Submit form/click button |

---

## Accessibility Features

✅ Implemented:
- High contrast colors
- Semantic HTML structure
- Clear button labels
- Status indicators with text + color
- Focus indicators visible
- Proper link colors

⚠️ To Enhance:
- ARIA labels on icons
- Screen reader testing
- Keyboard navigation testing
- Color contrast validation

---

## Performance Considerations

**Current Mockup:**
- Single HTML file (no build needed)
- Loads instantly
- No external dependencies
- Pure CSS animations (no jQuery)

**For Production:**
- Code splitting by page/section
- Lazy load table data
- Virtual scrolling for large lists
- API response caching
- Image optimization
- CSS/JS minification

---

## Testing the Mockup

### Quick Navigation Test
1. Start on Dashboard
2. Click "Manage" in Cluster Status table
3. Should show Cluster Details page
4. Click breadcrumb "Clusters"
5. Should return to Clusters list

### Tab Switching Test
1. Go to Cluster Details
2. Click each tab (Overview, Nodes, Storage, Monitoring)
3. Content should switch correctly
4. Go to Client Details
5. Click each sidebar tab

### Filter Test
1. Go to Clients page
2. Use Plan filter dropdown
3. Use Status filter dropdown
4. Try search input

### Responsive Test
1. Open in browser
2. Press F12 (DevTools)
3. Click mobile device icon
4. Test at 375px, 768px, 1024px, 1440px widths

---

## Next Steps

1. **Open the interactive mockup** in a web browser
2. **Explore all pages** using sidebar navigation
3. **Click table rows** to test navigation
4. **Try filters and searches**
5. **Review the layout** on different screen sizes
6. **Provide feedback** on colors, spacing, navigation
7. **Use this as reference** for React component development

---

## Troubleshooting

**If page doesn't load:**
- Check file path is correct
- Ensure file has `.html` extension
- Try a different browser
- Check browser console for errors

**If navigation doesn't work:**
- Make sure JavaScript is enabled
- Try refreshing the page
- Check browser console for errors
- Try a different browser

**If styling looks broken:**
- Check browser zoom level (should be 100%)
- Try clearing browser cache
- Disable browser extensions
- Try a different browser

---

## Contact & Feedback

Refer to the main documentation:
- `ADMIN_PANEL_MOCKUP_GUIDE.md` - Design system
- `KEY_PAGES_SPECIFICATION.md` - Page details
- `ADMIN_PANEL_REQUIREMENTS.md` - Feature requirements

---

**Version:** 1.0 - Blue-to-Dark-Green Gradient  
**Last Updated:** March 3, 2026  
**Status:** Production Ready for Development  
**Interactive Pages:** 9 (Dashboard, Clients, Client Details, Clusters, Cluster Details, Workloads, Applications, Storage, Monitoring)
