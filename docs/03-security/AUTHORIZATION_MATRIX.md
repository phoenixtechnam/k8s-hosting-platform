# Authorization Matrix & RBAC (Role-Based Access Control)

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Security & Backend Team

## Overview

This document defines the complete role-based access control (RBAC) matrix for the platform, ensuring:
- **Principle of Least Privilege** - Users get minimum required permissions
- **Multi-scope Authorization** - Global admin, region admin, client-level roles
- **Audit Trail** - All permission checks logged for compliance
- **Scalability** - Easy to add new roles and permissions in future

---

## Core Concepts

### Scopes

Permissions can be granted at different scope levels:

| Scope | Description | Example |
| --- | --- | --- |
| **Global** | Applies to entire platform | Platform admin can manage all regions |
| **Region** | Applies to specific region(s) | Region admin manages only US East region |
| **Client** | Applies to specific client tenant | Client admin manages only their resources |

### Permission Format

Permissions follow pattern: `resource:action:scope`

```
clients:create:global    # Create any client (platform admin only)
clients:read:own         # Read own client details
workloads:create:own     # Create workloads for own client
backups:delete:own       # Delete own backups
users:manage_rbac:global # Manage user roles (admin only)
```

### Built-in Roles vs Custom Roles

- **Built-in Roles:** Predefined, managed by system (cannot be modified)
  - Platform Admin
  - Region Admin
  - Client Admin
  - Client User
  - Support Staff
  - Viewer (read-only)

- **Custom Roles:** Future feature (Phase 2+) for fine-grained control

---

## Role Definitions

### 1. Platform Admin

**Scope:** Global  
**Use Case:** Platform infrastructure team, support leadership  
**Typical User Count:** 2-5 per deployment

**Permissions:** Full access to all resources

```yaml
Role: platform_admin
Description: Full platform access - infrastructure, security, billing
Permissions:
  - clients:*:*              # All client operations
  - regions:*:*              # All region management
  - workloads:*:*            # All workload operations
  - domains:*:*              # All domain management
  - databases:*:*            # All database operations
  - backups:*:*              # All backup operations
  - applications:*:*         # All application management
  - users:*:*                # All user management
  - rbac:*:*                 # Role management
  - billing:*:*              # Billing & subscriptions
  - monitoring:*:*           # Monitoring & logs
  - security:*:*             # Security policies
  - audit:*:*                # Audit logs access
  - system:*:*               # System configuration
```

### 2. Region Admin

**Scope:** Region  
**Use Case:** Regional infrastructure manager  
**Typical User Count:** 1-2 per region

**Permissions:** Full access to region resources, limited platform-wide operations

```yaml
Role: region_admin
Description: Full access to assigned region(s) - clients, workloads, etc.
Scope: region_id (assigned per user)
Permissions:
  - clients:create
  - clients:read
  - clients:update
  - clients:delete
  - clients:suspend
  - workloads:create
  - workloads:read
  - workloads:update
  - workloads:delete
  - workloads:start
  - workloads:stop
  - domains:create
  - domains:read
  - domains:update
  - domains:delete
  - databases:create
  - databases:read
  - databases:update
  - databases:delete
  - backups:create
  - backups:read
  - backups:restore
  - backups:delete
  - applications:install
  - applications:read
  - applications:update
  - applications:delete
  - monitoring:read
  - monitoring:export
  - users:read                # Read users in region only
  - users:manage_rbac         # Assign client-admin role only
  - audit:read               # Read region audit logs
  - billing:read             # Read-only access to billing
```

### 3. Client Admin

**Scope:** Client (tenant)  
**Use Case:** Business owner/manager of hosting account  
**Typical User Count:** 1-2 per client

**Permissions:** Full access to own client resources

```yaml
Role: client_admin
Description: Full access to own client's resources - workloads, domains, etc.
Scope: client_id (their own tenant)
Permissions:
  - clients:read:own                    # Read own client details
  - clients:update:own                  # Update own client settings
  - workloads:create:own
  - workloads:read:own
  - workloads:update:own
  - workloads:delete:own
  - workloads:start:own
  - workloads:stop:own
  - workloads:export:own                # Export configuration
  - domains:create:own
  - domains:read:own
  - domains:update:own
  - domains:delete:own
  - domains:verify:own
  - databases:create:own
  - databases:read:own
  - databases:update:own
  - databases:delete:own
  - databases:backup:own
  - databases:export:own
  - backups:create:own
  - backups:read:own
  - backups:restore:own
  - backups:delete:own
  - applications:install:own
  - applications:read:own
  - applications:update:own
  - applications:delete:own
  - ssh_keys:create:own
  - ssh_keys:read:own
  - ssh_keys:delete:own
  - monitoring:read:own
  - monitoring:export:own               # Export metrics/logs
  - users:read:own                      # List own team members
  - users:invite                        # Invite team members
  - users:manage_rbac:own               # Grant client_user role to team
  - audit:read:own                      # Read own audit logs
  - settings:update:own                 # Update client settings
  - branding:read:own                   # View branding customization
  - billing:read:own                    # Read own billing info
  - subscription:manage:own             # Change plan, update payment
```

### 4. Client User (Developer)

**Scope:** Client (tenant)  
**Use Case:** Developer/team member working on hosted applications  
**Typical User Count:** 2-20+ per client

**Permissions:** Limited to operational tasks, no destructive actions by default

```yaml
Role: client_user
Description: Limited access for team members - deploy, monitor, read-only settings
Scope: client_id (their assigned tenant)
Permissions:
  - clients:read:own                    # Read client info
  - workloads:read:own
  - workloads:start:own                 # Can restart workloads
  - workloads:stop:own
  - workloads:view_logs:own
  - workloads:export:own
  - domains:read:own
  - domains:verify:own                  # Can verify domain ownership
  - databases:read:own
  - databases:export:own                # Database schema/data export
  - backups:read:own
  - backups:restore:own                 # Self-service restore
  - applications:read:own
  - applications:view_logs:own
  - ssh_keys:create:own                 # Create own SSH keys
  - ssh_keys:read:own
  - ssh_keys:delete:own                 # Delete only own keys
  - monitoring:read:own
  - monitoring:export:own
  - audit:read:own                      # Read own actions only
```

### 5. Support Staff

**Scope:** Global (but limited to view/inspect)  
**Use Case:** Customer support team, debugging issues  
**Typical User Count:** 5-20

**Permissions:** Read-only access to debug customer issues

```yaml
Role: support_staff
Description: Read-only access for support team - troubleshooting & diagnostics
Scope: global (all regions/clients)
Permissions:
  - clients:read                        # View all clients
  - workloads:read
  - workloads:view_logs
  - domains:read
  - databases:read
  - backups:read
  - applications:read
  - applications:view_logs
  - monitoring:read                     # View metrics, logs, alerts
  - audit:read                          # View audit logs (no client filter)
  - users:read                          # View user list
  - tickets:create                      # Create support tickets
  - tickets:read                        # Read support tickets
  - tickets:update                      # Update support tickets
```

### 6. Viewer (Read-Only)

**Scope:** Client  
**Use Case:** Stakeholders, read-only access  
**Typical User Count:** 1-5 per client

**Permissions:** View-only access to resources

```yaml
Role: viewer
Description: Read-only access - no modification capabilities
Scope: client_id (their assigned tenant)
Permissions:
  - clients:read:own
  - workloads:read:own
  - workloads:view_logs:own
  - domains:read:own
  - databases:read:own
  - backups:read:own
  - applications:read:own
  - monitoring:read:own
  - audit:read:own
```

### 7. Custom Role (Phase 2+)

For future expansion:

```yaml
Role: custom_*
Description: Custom role with fine-grained permissions
Scope: client or region
Permissions: Specified per role
```

---

## Permission Matrix

### Resources & Actions

| Resource | Create | Read | Update | Delete | Start/Stop | Other |
| --- | --- | --- | --- | --- | --- | --- |
| **Clients** | ✅ Admin, RegionAdmin | ✅ Admin, RegionAdmin, ClientAdmin | ✅ Admin, RegionAdmin, ClientAdmin | ✅ Admin | - | Suspend: Admin, RegionAdmin |
| **Workloads** | ✅ ClientAdmin, ClientUser | ✅ All own-scoped | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin | ✅ ClientUser | ViewLogs: ClientUser |
| **Domains** | ✅ ClientAdmin | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin | ✅ ClientAdmin | - | Verify: ClientAdmin, ClientUser |
| **Databases** | ✅ ClientAdmin | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin | ✅ ClientAdmin | - | Backup, Export: ClientAdmin, ClientUser |
| **Backups** | ✅ ClientAdmin, System | ✅ ClientAdmin, ClientUser | - | ✅ ClientAdmin | - | Restore: ClientAdmin, ClientUser |
| **Applications** | ✅ ClientAdmin | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin | ✅ ClientAdmin | - | ViewLogs: ClientUser |
| **SSH Keys** | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin, ClientUser | ✅ ClientAdmin | ✅ ClientAdmin, ClientUser (own) | - | - |
| **Monitoring** | - | ✅ All own-scoped | - | - | - | Export: All own-scoped |
| **Audit Logs** | - | ✅ Admin, Support, own-scoped users | - | - | - | - |
| **Users** | ✅ Admin, RegionAdmin (invite) | ✅ All own-scoped | ✅ ClientAdmin (team) | ✅ Admin | - | ManageRBAC: Admin, RegionAdmin, ClientAdmin |
| **Billing** | ✅ Admin | ✅ Admin, ClientAdmin (own) | ✅ Admin, ClientAdmin (own) | - | - | Export: Admin, ClientAdmin (own) |
| **Settings** | - | - | ✅ Admin, ClientAdmin (own) | - | - | - |
| **Branding** | - | ✅ All | ✅ Admin, ClientAdmin (own) | - | - | - |

---

## Detailed Permission Definitions

### Client Permissions

```yaml
clients:create:
  description: Create new client
  role: platform_admin, region_admin
  condition: region_admin can only create in assigned region

clients:read:
  description: Read client details
  role: platform_admin, region_admin, client_admin (own)
  fields_visible:
    - public: id, name, plan, status, created_at
    - admin: password_reset_token, api_keys, internal_notes

clients:update:
  description: Update client settings
  role: platform_admin, region_admin, client_admin (own)
  protected_fields:
    - plan: platform_admin, region_admin only
    - status: platform_admin, region_admin only
    - namespace: platform_admin only

clients:delete:
  description: Delete client (permanent)
  role: platform_admin only
  requires_audit: true
  requires_backup_confirmation: true

clients:suspend:
  description: Suspend client (disable access)
  role: platform_admin, region_admin
  requires_reason: true
  requires_audit: true
```

### Workload Permissions

```yaml
workloads:create:
  description: Create new workload
  role: client_admin, client_user (limited)
  limits:
    - client_user: respects quota
    - client_admin: can exceed quota with approval

workloads:read:
  description: Read workload details and status
  role: all (own-scoped)
  fields_hidden:
    - environment_variables (values)  # Only keys visible to client_user
    - private_keys
    - api_credentials

workloads:update:
  description: Update workload configuration
  role: client_admin, client_user
  protected_fields:
    - cpu_request: client_admin only (if exceeds quota)
    - memory_request: client_admin only (if exceeds quota)

workloads:delete:
  description: Delete workload
  role: client_admin only
  requires_running_stop: true

workloads:start:
  description: Start workload
  role: client_admin, client_user
  quota_check: true

workloads:stop:
  description: Stop workload
  role: client_admin, client_user
  grace_period: 30 seconds

workloads:view_logs:
  description: View workload logs
  role: client_admin, client_user
  log_retention: 7 days
```

### Backup Permissions

```yaml
backups:create:
  description: Create backup
  role: system (automatic), client_admin (manual)
  quota_check: true

backups:read:
  description: List and view backups
  role: client_admin, client_user

backups:restore:
  description: Restore from backup
  role: client_admin, client_user
  notification: "Restore will overwrite current data"
  requires_confirmation: true
  audit_required: true

backups:delete:
  description: Delete backup
  role: client_admin
  prevents: preventing accidental loss
```

### Audit Log Permissions

```yaml
audit:read:
  description: Read audit logs
  role: platform_admin (all), region_admin (region), client_admin (own), client_user (own actions only)
  retention: 7 years
  fields_hidden_from_client_user: ip_address (for privacy)

audit:export:
  description: Export audit logs
  role: platform_admin, region_admin, client_admin
  formats: csv, json, pdf
  requires_reason: true
```

### User & RBAC Permissions

```yaml
users:create:
  description: Invite new user
  role: platform_admin, region_admin, client_admin

users:read:
  description: List users
  role: all (own-scoped)
  
users:update:
  description: Update user details
  role: platform_admin, client_admin (own team only)

users:delete:
  description: Delete user
  role: platform_admin only

users:manage_rbac:
  description: Assign/modify user roles
  role: platform_admin, region_admin (limited), client_admin (limited)
  constraints:
    - client_admin: can only assign client_user role
    - client_admin: cannot assign client_admin role
    - region_admin: can assign client_admin to clients in region
```

### Billing Permissions

```yaml
billing:read:
  description: Read billing information
  role: platform_admin, region_admin, client_admin (own)
  fields_hidden:
    - payment_method_tokens (from client_user)
    - per_unit_costs (from client_user)

billing:manage:
  description: Update billing, change plans, payment method
  role: platform_admin, client_admin (own)
  requires_mfa: true
  audit_required: true

subscription:manage:
  description: Manage subscription (upgrade/downgrade/cancel)
  role: client_admin (own)
  downgrade_notice_period: 30 days
```

---

## Implementation in Code

### Database Schema

```sql
-- Roles stored in rbac_roles table
CREATE TABLE rbac_roles (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  is_system_role BOOLEAN DEFAULT FALSE,
  permissions JSON NOT NULL,  -- Array of permission strings
  scope_type ENUM('global', 'region', 'client'),
  created_at TIMESTAMP
);

-- User role assignments
CREATE TABLE user_roles (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  role_id VARCHAR(36) NOT NULL,
  scope_type ENUM('global', 'region', 'client') DEFAULT 'global',
  scope_id VARCHAR(36),  -- region_id or client_id
  assigned_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_id) REFERENCES rbac_roles(id)
);
```

### Permission Checking Middleware

```typescript
// middleware/authorize.ts

interface AuthContext {
  userId: string;
  roles: Array<{
    roleId: string;
    roleName: string;
    permissions: string[];
    scopeType: 'global' | 'region' | 'client';
    scopeId: string | null;
  }>;
  tenantId: string;
}

export const authorize = (requiredPermission: string) => {
  return async (request: any, reply: any) => {
    const authContext = request.user as AuthContext;

    // Flatten permissions from all roles
    const allPermissions = authContext.roles.flatMap(r => r.permissions);

    // Check if user has permission
    const hasPermission = checkPermission(
      requiredPermission,
      allPermissions,
      authContext
    );

    if (!hasPermission) {
      throw new ApiError(
        'INSUFFICIENT_PERMISSIONS',
        'Insufficient permissions for this action',
        403
      );
    }
  };
};

const checkPermission = (
  required: string,
  permissions: string[],
  context: AuthContext
): boolean => {
  // resource:action:scope
  const [reqResource, reqAction, reqScope] = required.split(':');

  for (const perm of permissions) {
    const [permResource, permAction, permScope] = perm.split(':');

    if (permResource === '*' || permResource === reqResource) {
      if (permAction === '*' || permAction === reqAction) {
        if (permScope === '*' || permScope === reqScope) {
          return true;
        }
        // CRITICAL: 'own' scope requires resource ownership validation.
        // The permission check alone is NOT sufficient — the calling code
        // MUST verify resource.client_id === context.tenantId before proceeding.
        // This function only confirms the role grants 'own' scope access;
        // actual ownership is verified by requireOwnership() below.
        if (permScope === 'own' && reqScope === 'own') {
          return true;
        }
      }
    }
  }

  return false;
};

// MANDATORY: Resource ownership validation for 'own' scope.
// Every API endpoint that operates on a specific resource MUST call this
// after checkPermission passes with 'own' scope. Without this, any
// authenticated user can access any other client's resources (IDOR/BOLA
// — OWASP API Security Top 10 #1).
const requireOwnership = async (
  resourceId: string,
  resourceType: string,
  context: AuthContext
): Promise<void> => {
  const resource = await loadResource(resourceType, resourceId);
  if (!resource) {
    throw new NotFoundError(`${resourceType} not found`);
  }
  if (resource.client_id !== context.tenantId) {
    throw new ForbiddenError('Access denied: resource belongs to another client');
  }
};

// Usage in route — BOTH checks required
app.delete('/api/workloads/:id', authorize('workloads:delete:own'), async (req, reply) => {
  await requireOwnership(req.params.id, 'workload', req.authContext);
  // ... delete workload (ownership verified)
});

app.post('/api/workloads', authorize('workloads:create:own'), (req, reply) => {
  // Create operations: tenantId is set from authContext, not from request body
  // ... create workload with client_id = req.authContext.tenantId
});
```

### Frontend Permission Check

```typescript
// hooks/usePermission.ts

export const usePermission = (requiredPermission: string): boolean => {
  const { user } = useAuth();

  if (!user) return false;

  const allPermissions = user.roles.flatMap(r => r.permissions);
  return checkPermission(requiredPermission, allPermissions);
};

// Component usage
function WorkloadActions({ workload }) {
  const canDelete = usePermission('workloads:delete:own');
  const canStart = usePermission('workloads:start:own');

  return (
    <>
      {canStart && <button onClick={handleStart}>Start</button>}
      {canDelete && <button onClick={handleDelete}>Delete</button>}
    </>
  );
}
```

---

## Role Hierarchy

```
┌─────────────────────┐
│  Platform Admin     │ ← Root access
│  (global:*)         │
└──────────┬──────────┘
           │
           ├─────────────┬──────────────┬──────────┐
           ▼             ▼              ▼          ▼
    ┌──────────────┐  ┌────────────┐  ┌────────────────┐  ┌──────────┐
    │ Region Admin │  │ Support    │  │ Client Admin   │  │ Viewer   │
    │ (region:*,   │  │ (global:   │  │ (client:*,     │  │ (read)   │
    │  limited)    │  │  read,     │  │  own)          │  └──────────┘
    └──────┬───────┘  │  debug)    │  └────────┬───────┘
           │          └────────────┘           │
           │                                   │
           ├───────────────────────────────────┤
           │                                   │
           ▼                                   ▼
    ┌──────────────┐                  ┌──────────────┐
    │ Client Admin │                  │ Client User  │
    │ (client:*,   │                  │ (limited     │
    │  own)        │                  │  ops)        │
    └──────────────┘                  └──────────────┘
```

---

## Audit & Compliance

### Permission Change Audit

Every role assignment change must be logged:

```sql
INSERT INTO audit_logs (
  client_id, action_type, resource_type, resource_id,
  actor_id, changes, timestamp
) VALUES (
  NULL,
  'update',
  'user_role',
  'user-123',
  'admin-456',
  JSON_OBJECT(
    'before', JSON_OBJECT('role', 'client_user'),
    'after', JSON_OBJECT('role', 'client_admin')
  ),
  NOW()
);
```

### Permission Denial Logging

```typescript
// If permission denied, log for security monitoring
if (!hasPermission) {
  await logSecurityEvent({
    event_type: 'insufficient_permissions',
    severity: 'warning',
    user_id: authContext.userId,
    resource_type: 'workload',
    resource_id: resourceId,
    required_permission: requiredPermission,
    timestamp: new Date()
  });

  throw new ApiError('INSUFFICIENT_PERMISSIONS', ..., 403);
}
```

---

## Testing

```typescript
describe('Authorization', () => {
  it('platform_admin should have full access', async () => {
    const result = await checkPermission(
      'clients:delete:global',
      adminRolePermissions,
      adminContext
    );
    expect(result).toBe(true);
  });

  it('client_user should not be able to delete workload', async () => {
    const result = await checkPermission(
      'workloads:delete:own',
      clientUserRolePermissions,
      clientUserContext
    );
    expect(result).toBe(false);
  });

  it('region_admin should only see own region clients', async () => {
    const clients = await getClients(regionAdminContext);
    expect(clients.every(c => c.region_id === regionAdminContext.scope_id))
      .toBe(true);
  });

  it('client_admin should not manage other client', async () => {
    const response = await updateClient(
      otherClientId,
      clientAdminContext
    );
    expect(response.status).toBe(403);
  });
});
```

---

## Migration & Rollout

### Phase 1 Rollout

1. **Week 1-2:** Implement role definitions and permission checks in backend
2. **Week 3:** Deploy permission middleware to production
3. **Week 4:** Migrate existing users to new role system (backward compatible)
4. **Week 5:** Monitor permission denials, adjust as needed
5. **Week 6+:** Deprecate old authorization system

### Custom Roles (Phase 2)

For Phase 2+, enable fine-grained permission management:

```
UI: Admin > RBAC Management > Create Custom Role
- Select permissions individually (checkbox list)
- Assign to users
- Track usage and audit
```

---

## Checklist for Implementation

- [ ] Define all roles and permissions in database
- [ ] Implement permission checking middleware
- [ ] Add role assignment functionality to admin panel
- [ ] Create permission audit logging
- [ ] Add permission tests for all roles
- [ ] Implement frontend permission checks (disable buttons)
- [ ] Create RBAC management UI in admin panel
- [ ] Document role descriptions for end users
- [ ] Set up permission monitoring and alerts
- [ ] Test role hierarchy and permission inheritance
- [ ] Performance test permission checks (< 1ms)

---

## References

- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- NIST Access Control Guide: https://csrc.nist.gov/publications/detail/sp/800-178/final
- Role-Based Access Control (RBAC): https://csrc.nist.gov/publications/detail/sp/800-162/final
