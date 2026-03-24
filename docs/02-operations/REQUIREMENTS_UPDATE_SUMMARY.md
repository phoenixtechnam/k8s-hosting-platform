# Admin Panel Requirements - Update Summary

**Date:** March 3, 2026  
**Status:** Updated with new critical features  
**File Updated:** `ADMIN_PANEL_REQUIREMENTS.md`

---

## 📝 Overview

The ADMIN_PANEL_REQUIREMENTS.md file has been updated with three major feature categories:

1. **Branding & Customization** - Customizable platform branding
2. **Customizable Dashboards & Widgets** - Flexible dashboard layouts
3. **Passwordless Authentication with OIDC** - Google, Apple, GitHub, and custom OIDC providers

---

## 🎨 1. Branding & Customization (Phase 1.5)

### Purpose
Enable white-label and custom branding options for the platform, allowing organizations to customize the appearance and identity of the admin and client panels.

### Key Features

**Customizable Branding Elements:**
- ✅ Logo (PNG, SVG, JPEG - 2MB max)
- ✅ Favicon
- ✅ Color scheme (primary, secondary, accent)
- ✅ Company name
- ✅ Company website URL
- ✅ Email sender name
- ✅ Footer text (copyright/legal)
- ✅ Help/support links
- ✅ Theme mode (light/dark toggle)

**Admin Features:**
- ✅ Logo upload with preview
- ✅ Color customization interface
- ✅ Live preview before saving
- ✅ Reset to defaults option
- ✅ Global application (admin + client panels)

**Advanced (Phase 2):**
- ✅ Email template customization with branding
- ✅ Custom CSS overrides
- ✅ Complete white-label mode (hide platform branding)

### API Endpoints
```
GET /admin/branding                 # Get current branding
PUT /admin/branding                 # Update branding
POST /admin/branding/logo           # Upload logo
DELETE /admin/branding/reset        # Reset to defaults
```

### Use Cases
- Multi-tenant SaaS deployment (each customer sees their branding)
- Resellers/partners (white-label platform)
- Enterprise deployments (custom corporate branding)
- Franchise operations (network-wide branding)

---

## 📊 2. Customizable Dashboards & Widgets (Phase 2)

### Purpose
Enable different user roles to customize their dashboard with relevant widgets, improving productivity and user experience.

### Dashboard Types

| Dashboard | Users | Customizable |
|-----------|-------|---|
| Admin | Super Admin | ✅ Yes |
| DevOps | DevOps Admin | ✅ Yes |
| Support | Support Admin | ✅ Yes |
| Billing | Billing Admin | ✅ Yes |

### Widget Categories (30+ Available)

**Metrics Widgets:**
- System Health (uptime, status)
- Client Count (active, suspended, expired)
- Storage Usage (with trend)
- CPU/Memory/Network Usage
- Revenue (monthly, with trend)
- Subscription Stats (active, expiring, churn)

**Table Widgets:**
- Recent Clients
- Active Alerts (with severity)
- Billing Summary
- Node Status
- Activity Log

**Chart Widgets:**
- Client Growth Chart (line, monthly)
- Storage Growth Chart (area, daily)
- Revenue Chart (bar, monthly)
- Uptime Chart (line, 30-day)
- CPU Usage Heatmap
- Resource Utilization (pie/bar/line)

**Status Widgets:**
- Cluster Health Grid
- Alert Summary (by severity)
- Infrastructure Status

### Key Features
- ✅ **Drag & Drop** - Rearrange widgets on dashboard
- ✅ **Add/Remove** - Select from 30+ widget library
- ✅ **Customize Widgets** - Time range, filters, size per widget
- ✅ **Resize** - Small, medium, large widget sizes
- ✅ **Save Layouts** - Multiple dashboard configurations
- ✅ **Share Dashboards** - Share config with other users
- ✅ **Default Layout** - Admin sets role-based defaults
- ✅ **Auto-Refresh** - Configurable refresh interval (5s - 60m)

### API Endpoints
```
GET /admin/dashboard                      # Get dashboard config
PUT /admin/dashboard                      # Update layout
GET /admin/dashboard/widgets              # List available widgets
POST /admin/dashboard/widgets/:widgetId   # Add widget
DELETE /admin/dashboard/widgets/:widgetId # Remove widget
POST /admin/dashboard/layouts             # Save layout
GET /admin/dashboard/layouts              # List layouts
```

### Use Cases
- DevOps team focuses on cluster health, storage, and resource usage
- Support team focuses on alerts, recent activity, and open tickets
- Billing team focuses on revenue, subscriptions, and invoices
- Executives see high-level metrics and trends

---

## 🔐 3. Passwordless Authentication with OIDC (Phase 1.5 & 2)

### Purpose
Enable secure, frictionless authentication for Admin, Staff, and User accounts using industry-standard OIDC providers, eliminating password management overhead.

### Phase 1.5: Pre-Configured Providers

**Out-of-Box Support:**
- ✅ **Google** - OIDC + OAuth2
- ✅ **Apple** - Sign in with Apple
- ✅ **GitHub** - OAuth2 (developer-friendly)
- ✅ **Dex** - Internal OpenID Connect provider

**Features:**
- ✅ Social login buttons on login page
- ✅ Account linking (link multiple providers to one account)
- ✅ Auto-create account on first login
- ✅ Email auto-verified from OIDC provider
- ✅ Option to disable password login entirely
- ✅ Just-in-time user provisioning

### Phase 2: Custom OIDC Providers

**Admin-Configurable Providers:**
- ✅ Keycloak
- ✅ Auth0
- ✅ Okta
- ✅ Azure AD
- ✅ Any custom OIDC provider

**Configuration Options:**
| Setting | Type | Purpose |
|---------|------|---------|
| Provider Name | Text | Display name in UI |
| Discovery URL | URL | OIDC Discovery endpoint |
| Client ID | Text | OAuth2 app ID |
| Client Secret | Secret | OAuth2 app secret (encrypted) |
| Scopes | List | openid, email, profile, etc. |
| Claim Mapping | Map | Map OIDC claims to platform attributes |
| Auto-Create Users | Boolean | Auto-create on first login |
| Auto-Assign Role | Select | Default role (Admin, Staff, User) |
| Email Domain Filter | Text | Restrict to domain (optional) |
| Enabled | Boolean | Enable/disable provider |

### Account Types Supporting OIDC

| Account Type | OIDC Support | Login Options | Scope |
|---|---|---|---|
| **Admin** | ✅ Yes | Google, Apple, GitHub, Custom | Admin panel |
| **Staff** | ✅ Yes | Google, Apple, GitHub, Custom | Limited admin panel |
| **User/Client** | ✅ Yes | Google, Apple, GitHub, Custom | Customer portal + email |

### Admin Features (Phase 2)

**Provider Management:**
- ✅ List all OIDC providers
- ✅ Add new custom OIDC provider
- ✅ Edit provider settings
- ✅ Disable/enable providers
- ✅ Delete providers
- ✅ Test provider connection before enabling

**Account Management:**
- ✅ Link OIDC providers to existing accounts
- ✅ Unlink OIDC providers
- ✅ View linked providers per user

### User Features

**Account Settings:**
- ✅ View linked OIDC providers
- ✅ Add new provider link
- ✅ Remove provider link
- ✅ Require MFA (optional)

### API Endpoints

**Admin:**
```
GET /admin/settings/oidc                      # Get OIDC config
POST /admin/settings/oidc                     # Add provider
PUT /admin/settings/oidc/:providerId          # Update provider
DELETE /admin/settings/oidc/:providerId       # Delete provider
POST /admin/settings/oidc/:providerId/test    # Test connection
```

**User:**
```
GET /user/accounts/oidc                       # List linked providers
POST /user/accounts/oidc/:providerId/link     # Link provider
DELETE /user/accounts/oidc/:providerId/unlink # Unlink provider
```

### Security Features

**Authentication Security:**
- ✅ PKCE flow (authorization code with proof)
- ✅ CSRF state validation
- ✅ Nonce validation in ID token
- ✅ Token signature verification
- ✅ JWK caching for performance
- ✅ Refresh token support
- ✅ Refresh token rotation

**Data Security:**
- ✅ Encrypted client secrets at rest
- ✅ TLS for all OIDC communication
- ✅ Secure token storage
- ✅ Audit logging of all OIDC events

### Audit & Logging

**Events Logged:**
- ✅ OIDC Provider Added/Updated/Deleted (admin action)
- ✅ Provider test results
- ✅ User OIDC login (success/failure)
- ✅ Account link/unlink
- ✅ Failed login attempts

### Login Page Experience

```
┌──────────────────────────────────┐
│   Login to HostPlatform           │
├──────────────────────────────────┤
│                                  │
│  [Google Login] [Apple] [GitHub]  │
│  [Custom Provider 1]              │
│  [Custom Provider 2]              │
│                                  │
│  ─── or use email/password ───   │
│  Email: [____________]           │
│  Password: [____________]         │
│  [Sign In]                       │
│                                  │
│  [Forgot Password?]              │
└──────────────────────────────────┘
```

### Use Cases
- **Enterprise:** Use existing corporate OIDC (Azure AD, Okta)
- **Developers:** Quick login with GitHub
- **Consumers:** Easy access with Google/Apple
- **Resellers:** Configure for clients using their OIDC provider
- **Compliance:** Maintain identity governance while enabling passwordless auth

---

## 📊 Impact Summary

### Feature Count Updates

| Phase | Previous | New | Change |
|-------|----------|-----|--------|
| Phase 1 | 40+ | 40+ | Same |
| Phase 1.5 | 15+ | 25+ | +10 features |
| Phase 2 | 30+ | 40+ | +10 features |
| Phase 3+ | 20+ | 20+ | Same |
| **Total** | **100+** | **130+** | **+30 features** |

### New Feature Breakdown

**Branding (Phase 1.5):** 8+ features
- Logo upload, color customization, company info, theme mode, preview, reset

**Passwordless Auth (Phase 1.5):** 15+ features
- Google, Apple, GitHub login, account linking, auto-create, password-optional

**Custom OIDC Providers (Phase 2):** 8+ features
- Add/edit/delete providers, test connection, account linking, claim mapping

**Dashboards & Widgets (Phase 2):** 10+ features
- Widget library, drag-drop, layouts, sharing, 30+ widgets, auto-refresh

---

## 🎯 Implementation Priority

### Phase 1.5 (Next Priority)
1. **Branding** - Logo, colors, company info
2. **Passwordless Auth** - Google, Apple, GitHub
3. **Basic Account Linking** - Link multiple providers

### Phase 2 (Later Priority)
1. **Custom OIDC Providers** - Add/manage custom providers
2. **Customizable Dashboards** - Widget system, layouts
3. **Advanced Provider Features** - Claim mapping, email filtering

---

## 📝 File Changes

### Updated File
- `/config/Server Infrastructure/02-operations/ADMIN_PANEL_REQUIREMENTS.md`

### Changes Made
- ✅ Added 3 new sections (Branding, Dashboards, OIDC)
- ✅ Added to Table of Contents
- ✅ Updated Summary with new feature counts
- ✅ Comprehensive specifications with API endpoints
- ✅ Security and audit logging details

### Statistics
- **Lines Added:** 272
- **New Total:** 1,073 lines (was 801)
- **New Sections:** 3
- **New Features:** 30+
- **New API Endpoints:** 12+

---

## 🔗 Related Documentation

**Current File:**
- `ADMIN_PANEL_REQUIREMENTS.md` - Now includes all three new sections

**Related Files:**
- `CLIENT_PANEL_FEATURES.md` - Customer-facing features
- `../04-deployment/MANAGEMENT_API_SPEC.md` - REST API endpoints
- `../01-core/PLATFORM_ARCHITECTURE.md` - Security architecture (OIDC integration)

---

## ✅ Ready for Development

All three feature areas are now fully specified:
- ✅ Detailed requirements
- ✅ API endpoints defined
- ✅ Use cases documented
- ✅ Security considerations covered
- ✅ Audit logging specified
- ✅ Implementation phases defined

**Next Steps:**
1. Review updated requirements with team
2. Prioritize Phase 1.5 features (branding + passwordless auth)
3. Plan Phase 2 features (custom OIDC + dashboards)
4. Begin implementation

---

**Document Version:** 1.1  
**Status:** Complete & Ready for Implementation  
**Total Admin Panel Features:** 160+ (increased from 100+)

---

# Mobile Optimization Requirements - NEW

**Date:** March 3, 2026  
**Status:** Comprehensive mobile specification added  
**File Updated:** `ADMIN_PANEL_REQUIREMENTS.md`

## 📱 Mobile Optimization Overview

A new comprehensive section on **Mobile Optimization & Responsive Design** has been added to ensure the admin panel is fully optimized for mobile and tablet devices.

### Device Support
- ✅ Smartphones (< 480px) - Critical
- ✅ Large phones (480-768px) - Critical
- ✅ Tablets portrait (768-1024px) - High
- ✅ Tablets landscape (1024-1366px) - High
- ✅ Desktops (> 1366px) - Full support

### Key Mobile Features

**Touch-Friendly Interface:**
- ✅ 44-48px minimum touch targets
- ✅ 8-12px spacing between elements
- ✅ Large form inputs (48px height)
- ✅ Haptic feedback (Phase 2)

**Mobile Navigation:**
- ✅ Bottom tab bar (5 max items on mobile)
- ✅ Left drawer menu for additional items
- ✅ Hamburger menu toggle
- ✅ Back button in header
- ✅ Swipe gesture support

**Responsive Layouts:**
- ✅ Card view on mobile (< 480px)
- ✅ Compact table on tablets
- ✅ Full table on desktop
- ✅ Auto-switching based on screen size
- ✅ Horizontal scroll for tables

**Mobile Forms:**
- ✅ Single-column forms
- ✅ Full-width inputs (100% - 24px)
- ✅ Smart keyboard types (email, number, tel)
- ✅ Auto-focus first input
- ✅ Autofill support
- ✅ No zoom on input focus

**Performance Targets:**
- ✅ FCP < 2.5s on mobile (4G)
- ✅ LCP < 3s on mobile
- ✅ Page load < 2MB
- ✅ JS bundle < 200KB
- ✅ CLS < 0.1

**Performance Optimization:**
- ✅ Code splitting by page
- ✅ Image optimization (WebP, srcset)
- ✅ CSS minification
- ✅ Service Worker for offline
- ✅ HTTP caching (365 days static)
- ✅ API pagination and field selection
- ✅ System fonts (no heavy web fonts)

**Accessibility on Mobile:**
- ✅ WCAG 2.1 Level AA compliant
- ✅ Screen reader support (VoiceOver, TalkBack)
- ✅ Keyboard navigation
- ✅ 44x44px touch targets
- ✅ High contrast colors
- ✅ Visible focus indicators

**PWA Features (Phase 2):**
- ✅ Installable as app
- ✅ Push notifications
- ✅ Offline capability
- ✅ Offline data sync
- ✅ Biometric auth (Face ID, Touch ID)

**Testing Requirements:**
- ✅ Real device testing
- ✅ Multiple iOS versions
- ✅ Multiple Android versions
- ✅ Orientation changes
- ✅ Dark mode support
- ✅ Low battery mode
- ✅ Various network speeds

### Implementation Impact

**Phase 1 (MVP):**
- Touch-friendly interface
- Responsive layouts
- Mobile navigation
- Performance optimization
- Core accessibility
- Service Worker

**Phase 2:**
- PWA features
- Push notifications
- Offline sync
- Biometric auth
- Enhanced accessibility

### Feature Count Update
- **Phase 1:** 40+ → 50+ features (+10 mobile)
- **Phase 1.5:** 25+ → 35+ features
- **Phase 2:** 40+ → 45+ features
- **Total:** 130+ → 160+ features (+30)

---

**Document Version:** 1.1  
**Status:** Complete & Ready for Implementation  
**Total Admin Panel Features:** 160+ (increased from 100+)
