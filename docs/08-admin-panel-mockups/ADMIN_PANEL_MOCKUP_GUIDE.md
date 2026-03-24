# Admin Panel UI Mockup Guide

## Overview

This directory contains comprehensive UI mockups and design specifications for the Admin Panel of the Kubernetes-based Web Hosting Platform.

---

## Files in This Directory

### 1. **admin-panel-mockup.html**
Interactive HTML mockup of the main admin dashboard. Open in a web browser to view the design.

**Features Shown:**
- Sidebar navigation with 9 main sections
- Header with search and user profile
- Dashboard with 4 key metrics (Total Clients, Active Subscriptions, Cluster Health, Storage)
- Cluster Status table showing 3 Kubernetes clusters
- Recent Clients table showing 5 sample clients
- Responsive design for desktop and tablet viewing

**How to Use:**
1. Save the HTML file
2. Open in any modern web browser (Chrome, Firefox, Safari, Edge)
3. No server required - standalone HTML file
4. Click on sidebar items to simulate navigation

---

## Design System

### Color Palette

| Usage | Color | Hex |
|-------|-------|-----|
| Primary (Buttons, Links, Accent) | Purple-to-Pink Gradient | #667eea → #764ba2 |
| Background | Light Gray | #f5f7fa |
| Card Background | White | #ffffff |
| Text Primary | Dark Gray | #333333 |
| Text Secondary | Medium Gray | #666666 |
| Border | Light Gray | #e0e6ed |
| Success/Healthy | Green | #10b981 |
| Warning | Amber | #f59e0b |
| Error/Critical | Red | #ef4444 |
| Muted | Light Gray | #f9fafb |

### Typography

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Page Title | System Font | 24px | 600 |
| Section Title | System Font | 18px | 600 |
| Table Header | System Font | 12px | 600 |
| Body Text | System Font | 14px | 400 |
| Label Text | System Font | 12px | 600 |
| Small Text | System Font | 13px | 400 |

### Spacing

- **Content Padding:** 32px (desktop), 20px (tablet), 16px (mobile)
- **Gap Between Cards:** 20px
- **Gap Between Sections:** 32-40px
- **Sidebar Width:** 280px (desktop), 200px (tablet)
- **Border Radius:** 8px (inputs/buttons), 12px (cards)

### Components

#### Buttons

**Primary Button**
- Background: Purple-to-Pink Gradient
- Color: White
- Padding: 10px 16px
- Border Radius: 8px
- Hover: Opacity 0.9, slight lift effect
- Used for: Main actions (Create, Save, Submit)

**Secondary Button**
- Background: Light Gray (#f5f7fa)
- Color: Dark Gray (#333)
- Border: 1px solid #e0e6ed
- Padding: 10px 16px
- Border Radius: 8px
- Hover: Slightly darker background
- Used for: Alternative actions (View, Edit, Cancel)

**Small Button Variant**
- Padding: 6px 12px
- Font Size: 12px
- Used for: Inline actions in tables, filters

#### Status Badges

| Status | Background | Color | Used For |
|--------|-----------|-------|----------|
| Active | #d1fae5 | #065f46 | Active clients/subscriptions |
| Inactive | #fee2e2 | #991b1b | Suspended/deleted items |
| Pending | #fef3c7 | #92400e | Expiring soon subscriptions |
| Warning | #fed7aa | #92400e | Resource warnings |

#### Cards

- Background: White
- Border: 1px solid #e0e6ed
- Padding: 24px
- Border Radius: 12px
- Box Shadow: 0 1px 3px rgba(0,0,0,0.05)
- Hover: Subtle background change (optional)

#### Tables

- Header Background: #f9fafb
- Header Text: Uppercase, small, bold
- Row Padding: 16px 24px
- Row Hover: #f9fafb background
- Borders: 1px solid #e0e6ed
- No striping required

---

## Layout Structure

### Sidebar Navigation (280px width)

**Header Section** (24px padding)
- Logo (40x40px) + Logo Text
- Separator line

**Menu Items**
- Icon (20px) + Label
- 8px bottom margin between items
- 12px padding horizontal
- Active state: background color + left border (3px white)

**Menu Categories:**
1. 📊 Dashboard
2. 🏢 Clusters
3. 👥 Clients
4. 📦 Workloads
5. 🚀 Applications
6. 💾 Storage & DB
7. 🔐 Security
8. 📈 Monitoring
9. ⚙️ Settings

### Header (Full Width)

**Left Side:**
- Page Title (e.g., "Dashboard")

**Right Side:**
- Search Bar (280px width) with placeholder "Search clients, domains..."
- User Profile (Avatar + Name + Role)

### Content Area

**Breadcrumb Navigation**
- Format: "Home / Dashboard"
- Color: #666 text, #667eea links
- Font Size: 13px

**Stats Grid (4 columns responsive)**
- Stat Card template:
  - Label (12px, uppercase)
  - Value (32px, bold)
  - Change text (13px) with color coding

**Section Titles**
- 18px, bold
- 20px margin-bottom

**Tables**
- Header with title on left, actions on right
- Standard table with hover effects
- Pagination at bottom

---

## Page Sections (from Mockup)

### 1. Dashboard Section

**Metrics Cards (4 total)**
- Total Clients: 248 (↑12 this month)
- Active Subscriptions: 235 (98.8% retention)
- Cluster Health: 99.8% (✓ All systems normal)
- Storage Used: 4.2TB (of 10TB capacity)

### 2. Cluster Status Table

**Columns:**
1. Region (e.g., "US East")
2. Status (Health indicator + text)
3. Nodes count
4. CPU Usage (bar chart + percentage)
5. Memory Usage (bar chart + percentage)
6. Storage (e.g., "2.1TB / 4TB")
7. Uptime percentage
8. Actions (Manage button)

**Sample Data:**
- US East: 6 nodes, 68% CPU, 54% memory, 98.2% uptime ✓ Healthy
- EU West: 4 nodes, 45% CPU, 38% memory, 99.5% uptime ✓ Healthy
- Asia Pacific: 3 nodes, 82% CPU, 71% memory, 97.3% uptime ⚠️ Warning

### 3. Recent Clients Table

**Columns:**
1. Client Name
2. Email
3. Plan (Starter, Business, Premium)
4. Status (Active, Suspended, Expiring Soon)
5. Subscription (Expiry date)
6. Storage (Used / Total)
7. Actions (View button)

**Sample Data:**
- Tech Startup Inc: Premium, Active, Dec 15 2024, 180GB/500GB
- Design Agency Co: Business, Active, Jan 8 2025, 32GB/50GB
- Local Services Ltd: Starter, Active, Nov 22 2024, 2.8GB/5GB
- Enterprise Corp: Premium, Suspended, Oct 31 2024, 450GB/500GB
- Web Solutions Pro: Business, Expiring Soon, Nov 5 2024, 38GB/50GB

---

## Responsive Design

### Desktop (> 1024px)
- Sidebar: 280px
- Content padding: 32px
- Two-column grid layout
- Full features visible

### Tablet (768px - 1024px)
- Sidebar: 200px
- Content padding: 20px
- Single-column layout for grids
- Reduced header elements

### Mobile (< 768px)
- Sidebar: Collapsed or drawer
- Content padding: 16px
- Header simplified
- Full-width elements
- Touch-friendly tap targets (44px min)

---

## Interactive Elements

### Search Bar
- Placeholder: "Search clients, domains..."
- Width: 280px
- Icon: 🔍
- Returns results in real-time or on Enter

### Filters
- Plan filter dropdown
- Status filter dropdown
- Date range picker (optional)
- Custom filter builder (Phase 2)

### Sorting
- Click on table headers to sort
- Visual indicator (arrow) for active sort column
- Ascending/Descending toggle

### Pagination
- Numbered buttons: 1, 2, 3, ..., 24
- Next/Previous buttons
- Items per page selector (optional)

### Modals/Dialogs (Not shown, but needed)
- Add Client modal
- Edit Client modal
- Delete confirmation
- Create Cluster modal
- View Details modal

---

## Data Visualization

### Resource Bars
- Filled portion: Gradient (purple-pink)
- Empty portion: Light gray (#e0e6ed)
- Shows: Current usage / Total capacity
- Percentage displayed on right

### Health Indicators
- Green dot (10px diameter): Healthy
- Amber dot: Warning
- Red dot: Critical
- Followed by status text

### Stats Cards
- Large number (32px)
- Small label (12px uppercase)
- Change indicator (↑/↓ or text)
- Color: Green for positive, red for negative

---

## User Experience Flow

### Admin Dashboard Access Flow

1. **Login** → Redirects to Dashboard
2. **Dashboard** → Overview of platform health
3. **Navigation** → Click sidebar items to access sections
4. **Search** → Quick access to specific clients/resources
5. **Actions** → Click "View", "Manage", "Edit" buttons
6. **Details** → Drill down into specific resources
7. **Modifications** → Create/edit/delete resources
8. **Confirmation** → Modals for destructive actions

### Key Actions Shown

- **View Cluster Details** → Click "Manage" button in cluster row
- **View Client Details** → Click "View" button in client row
- **Add Client** → Click "+ Add Client" button
- **Add Cluster** → Click "+ Add Cluster" button
- **Filter** → Use dropdown filters
- **Search** → Type in search bar
- **Pagination** → Click page numbers

---

## Accessibility Considerations

- ✓ High contrast colors (WCAG AA compliant)
- ✓ Semantic HTML structure
- ✓ ARIA labels for icons
- ✓ Keyboard navigation support
- ✓ Focus indicators visible
- ✓ Color not sole indicator (also use text/icons)
- ✓ Font sizes readable (min 14px for body)
- ✓ Touch targets 44px minimum

---

## Navigation Structure

### Sidebar Menu Items (Future Implementation)

| Item | Icon | Pages |
|------|------|-------|
| Dashboard | 📊 | Overview, Statistics, Alerts |
| Clusters | 🏢 | List, Details, Add, Settings |
| Clients | 👥 | List, Details, Edit, Suspend/Delete |
| Workloads | 📦 | List, Details, Deploy, Logs |
| Applications | 🚀 | Catalog, Instances, Deploy, Configure |
| Storage & DB | 💾 | Storage, Databases, Backups, Restore |
| Security | 🔐 | Users, Roles, Policies, Audit Logs |
| Monitoring | 📈 | Metrics, Logs, Alerts, Dashboards |
| Settings | ⚙️ | General, Billing, Integration, API |

---

## Next Steps for Full Implementation

### Phase 1 (Mockup to Code)
- [ ] Convert HTML mockup to React components
- [ ] Set up component library (Storybook)
- [ ] Implement routing between pages
- [ ] Connect to Management API endpoints
- [ ] Add form validation
- [ ] Implement search and filtering

### Phase 2 (Enhanced Features)
- [ ] Add real-time notifications
- [ ] Implement advanced filtering/search
- [ ] Add data export (CSV, PDF)
- [ ] Implement bulk operations
- [ ] Add charts and graphs (Chart.js, D3.js)
- [ ] Implement dark mode

### Phase 3 (Advanced)
- [ ] Add role-based access control
- [ ] Implement audit logs viewer
- [ ] Add workflow automation UI
- [ ] Implement custom dashboards
- [ ] Add webhook management
- [ ] Implement API key management

---

## File Organization

```
08-admin-panel-mockups/
├── admin-panel-mockup.html          (Main mockup - open in browser)
├── ADMIN_PANEL_MOCKUP_GUIDE.md      (This file)
├── design-system.md                 (To be created)
├── component-specs/                 (To be created)
│   ├── buttons.md
│   ├── cards.md
│   ├── tables.md
│   ├── forms.md
│   └── dialogs.md
├── page-flows/                      (To be created)
│   ├── cluster-management.md
│   ├── client-management.md
│   ├── workload-management.md
│   └── billing-management.md
├── wireframes/                      (To be created)
│   ├── dashboard.png
│   ├── cluster-details.png
│   ├── client-details.png
│   └── add-client-flow.png
└── figma-export/                    (To be created)
    └── admin-panel.fig
```

---

## Browser Compatibility

- ✓ Chrome 90+
- ✓ Firefox 88+
- ✓ Safari 14+
- ✓ Edge 90+
- ✓ Mobile browsers (iOS Safari, Chrome Mobile)

---

## Performance Considerations

- Lazy load table data (pagination)
- Virtual scrolling for large lists
- Debounce search input (300ms)
- Cache API responses
- Optimize images and icons
- Code splitting by page/section
- Minimize bundle size

---

## Testing Strategy

### Unit Tests
- Component rendering
- Props validation
- Event handlers
- State management

### Integration Tests
- Navigation flows
- API integration
- Data loading
- Error handling

### E2E Tests (Cypress/Playwright)
- User workflows
- Form submissions
- Data persistence
- Edge cases

### Visual Regression Tests
- Component snapshot tests
- Cross-browser visual tests
- Responsive design tests

---

## Development Stack (Recommended)

- **Framework:** React 18+ with TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS or CSS Modules
- **State Management:** Zustand or TanStack Query
- **API Client:** Axios or Fetch API
- **Testing:** Vitest, React Testing Library, Cypress
- **Component Library:** Storybook
- **UI Library:** Headless UI or Radix UI

---

## References

- Related Documentation: `/config/Server Infrastructure/02-operations/ADMIN_PANEL_REQUIREMENTS.md`
- Management API: `/config/Server Infrastructure/04-deployment/MANAGEMENT_API_SPEC.md`
- Tech Stack: `/config/Server Infrastructure/07-reference/TECH_STACK_SUMMARY.md`

---

**Last Updated:** March 3, 2026
**Status:** Mockup Phase (Ready for Development)
