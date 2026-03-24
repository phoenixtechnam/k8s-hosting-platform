# Database Management UI Specification

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** FINAL — Ready for implementation  
**Audience:** Web developers, UI designers, backend engineers

---

## Overview

This document specifies the **web-based database management interface** allowing customers and admins to access, view, edit, import, and export MariaDB and PostgreSQL databases via the Control Panel UI. The interface is similar to phpMyAdmin but integrated directly into the platform's admin/customer panels with per-customer isolation and audit logging.

### Key Features

- **Database Browser** — View all customer's databases, tables, and data
- **Table Editor** — Create, modify, delete tables with visual UI
- **SQL Console** — Execute arbitrary SQL queries with syntax highlighting
- **Data Editor** — View, insert, update, delete rows with inline editing
- **Import/Export** — Upload SQL dumps, CSV files, or JSON; download in same formats
- **Database User Management** — Create/modify database users, grant permissions
- **Backup Integration** — Restore from backups, point-in-time recovery
- **Audit Logging** — Track all database operations (who, what, when, from where)
- **Plan-Based Limits** — Database count, table count, query limits per plan

---

## PHASE 1: Single Region Database Management

### Architecture

```
Customer Control Panel
├── Databases Section
│   ├── Database List (mysql1, mysql2, postgres1)
│   ├── Database Details (size, tables, users, last backup)
│   ├── Table Browser
│   │   ├── Table List (users, posts, comments, etc.)
│   │   ├── Table Structure (columns, types, indexes)
│   │   └─ Row Data (paginated, searchable, sortable)
│   ├── SQL Console
│   │   ├─ Query Editor (syntax highlighting)
│   │   ├─ Query History
│   │   └─ Results (table view or CSV export)
│   ├─ Import
│   │   ├─ Upload SQL file
│   │   ├─ Upload CSV file
│   │   └─ Paste SQL/CSV directly
│   ├─ Export
│   │   ├─ Export as SQL (structure + data)
│   │   ├─ Export as CSV
│   │   └─ Export as JSON
│   └─ Database Users
│       ├─ Create user (grant hostname access)
│       ├─ Manage permissions (SELECT, INSERT, UPDATE, DELETE, etc.)
│       └─ Reset password
│
Admin Control Panel
├── Manage All Customers' Databases
│   ├── Search by customer
│   ├── View customer's databases
│   ├── Full access to all operations
│   ├── Can restore from backup
│   └── Full audit log access
```

---

## Database Access & Viewing

### Database List Page

**Customer View:**

```
┌─────────────────────────────────────────────────────────┐
│ Databases                                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Plan: Premium (limit: 5 databases)                      │
│ Used: 3 databases / 5                                   │
│ Total Size: 850 MB / 2000 MB                            │
│                                                         │
│ ┌─ mariadb_main                                           │
│ │  Type: MariaDB 10.6                                      │
│ │  Size: 450 MB                                         │
│ │  Tables: 12                                           │
│ │  Users: 2 (root, app_user)                           │
│ │  Last Backup: 2026-03-01 09:00 UTC                   │
│ │  Charset: utf8mb4                                     │
│ │  Status: ✓ Healthy                                   │
│ │  Actions: [Browse] [Backup] [Export] [Settings] [...]│
│ │
│ ├─ postgres_analytics                                  │
│ │  Type: PostgreSQL 16                                 │
│ │  Size: 300 MB                                        │
│ │  Tables: 8                                           │
│ │  Users: 1 (analytics_user)                          │
│ │  Last Backup: 2026-03-01 08:30 UTC                  │
│ │  Charset: UTF8                                       │
│ │  Status: ✓ Healthy                                   │
│ │  Actions: [Browse] [Backup] [Export] [Settings] [...]│
│ │
│ └─ mariadb_staging                                       │
│    Type: MariaDB 10.6                                     │
│    Size: 100 MB                                        │
│    Tables: 5                                           │
│    Users: 1 (staging_user)                             │
│    Last Backup: 2026-02-28 22:00 UTC                   │
│    Charset: utf8mb4                                    │
│    Status: ⚠️ Replication Lag: 5 minutes              │
│    Actions: [Browse] [Backup] [Export] [Settings] [...]│
│                                                         │
│ [+ Create New Database]                                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Database Details Page

```
┌─────────────────────────────────────────────────────────┐
│ Database: mariadb_main                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Overview:                                               │
│ ├─ Type: MariaDB 10.6.32                                  │
│ ├─ Size: 450 MB                                        │
│ ├─ Data Tables: 12                                     │
│ ├─ Views: 2                                            │
│ ├─ Indexes: 18                                         │
│ ├─ Row Count: 1,250,000                               │
│ ├─ Last Modified: 2026-03-01 10:30 UTC                │
│ ├─ Last Backup: 2026-03-01 09:00 UTC                  │
│ ├─ Charset: utf8mb4                                    │
│ ├─ Collation: utf8mb4_unicode_ci                       │
│ └─ Status: ✓ Healthy                                   │
│                                                         │
│ Quick Actions:                                          │
│ [Browse Tables] [SQL Console] [Import] [Export]        │
│ [Backup Now] [Restore] [Optimize] [Settings]           │
│                                                         │
│ Tables:                                                 │
│ ┌─────────────────────────────────┐                    │
│ │ Name     │ Type  │ Rows  │ Size │ Actions            │
│ ├─────────────────────────────────┤                    │
│ │ users    │ InnoDB│ 5000 │ 50MB │ [Edit] [Export] [▼]│
│ │ posts    │ InnoDB│ 15000│ 150MB│ [Edit] [Export] [▼]│
│ │ comments │ InnoDB│ 200k │ 120MB│ [Edit] [Export] [▼]│
│ │ tags     │ InnoDB│ 500  │ 1MB  │ [Edit] [Export] [▼]│
│ └─────────────────────────────────┘                    │
│                                                         │
│ Database Users:                                         │
│ ┌──────────────────────────────────────────┐           │
│ │ User      │ Host      │ Permissions │ [▼]│           │
│ ├──────────────────────────────────────────┤           │
│ │ root      │ localhost │ ALL         │[...]│          │
│ │ app_user  │ %         │ SELECT,...  │[...]│          │
│ └──────────────────────────────────────────┘           │
│ [+ Add User]                                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Table Browser & Data Viewer

### Table Structure View

```
┌─────────────────────────────────────────────────────────┐
│ Table: users (450 MB, 5,000 rows)                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Columns:                                                │
│ ┌──────────────────────────────────────────────────────┐│
│ │ Field    │ Type        │ Null │ Key  │ Default │ Xtra││
│ ├──────────────────────────────────────────────────────┤│
│ │ id       │ int(11)     │ NO   │ PRI  │ (auto)  │     ││
│ │ email    │ varchar(255)│ NO   │ UNI  │ NULL    │     ││
│ │ name     │ varchar(100)│ YES  │      │ NULL    │     ││
│ │ password │ varchar(255)│ NO   │      │ NULL    │     ││
│ │ status   │ enum(...)   │ NO   │      │ active  │     ││
│ │ created  │ timestamp   │ NO   │      │ NOW()   │     ││
│ │ updated  │ timestamp   │ YES  │      │ NULL    │ …UPD││
│ └──────────────────────────────────────────────────────┘│
│                                                         │
│ Indexes:                                                │
│ ├─ PRIMARY KEY (id)                                     │
│ ├─ UNIQUE KEY (email)                                   │
│ └─ KEY created (created)                                │
│                                                         │
│ Quick Actions:                                          │
│ [Edit Structure] [Add Column] [Add Index] [Drop Table]  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Data Viewer with Inline Editing

```
┌─────────────────────────────────────────────────────────┐
│ Data: users (showing 1-20 of 5,000)                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Search: [_____________________] [Search]                │
│ Filter: [Status ▼] [Created ▼] [_____] [Apply]         │
│ Sort: [ID ▼] [Direction: ASC ▼]                        │
│ Per Page: [20 ▼]                                        │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐│
│ │ ☐ │ id  │ email           │ name    │ status │ [...] ││
│ ├─────────────────────────────────────────────────────┤│
│ │ ☑ │ 1   │ alice@ex.com    │ Alice   │ active │ [⋯] ││
│ │ ☐ │ 2   │ bob@ex.com      │ Bob     │ active │ [⋯] ││
│ │ ☐ │ 3   │ carol@ex.com    │ Carol   │inactive│ [⋯] ││
│ │    │ 4   │ dave@ex.com     │ Dave    │ active │ [⋯] ││
│ │    │ 5   │ eve@ex.com      │ Eve     │ active │ [⋯] ││
│ │    │ ... │ ...             │ ...     │ ...    │ ... ││
│ │    │ 20  │ zack@ex.com     │ Zack    │ active │ [⋯] ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ Actions for selected (1 row):                           │
│ [Edit] [Duplicate] [Delete] [Export to CSV]             │
│                                                         │
│ Pagination: [◄] [1] [2] [3] [4] ... [250] [►]          │
│                                                         │
│ Bulk Actions:                                           │
│ [Select All] [Deselect All] [Delete All Selected]       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Edit Row (Modal)

```
┌──────────────────────────────────────────────────────┐
│ Edit Row (id=1)                                      │
├──────────────────────────────────────────────────────┤
│                                                      │
│ id: 1 [read-only]                                    │
│                                                      │
│ email: [alice@example.com          ]                 │
│ (Unique key, matches regex if set)                   │
│                                                      │
│ name: [Alice                       ]                 │
│ (varchar 100, allows NULL)                           │
│                                                      │
│ password: [••••••••••••••••]                          │
│ (varchar 255, masked for security)                   │
│                                                      │
│ status: [active ▼]                                   │
│ (enum: active, inactive, banned)                     │
│                                                      │
│ created: [2026-01-15 10:30:00] [Today] [Clear]      │
│                                                      │
│ updated: [2026-03-01 14:22:00] [Now] [Clear]        │
│                                                      │
│              [Save] [Cancel] [Delete Row]            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Table Editor: DDL Operations

### Create Table Wizard

```
Step 1: Basic Info
┌──────────────────────────────────────────────────────┐
│ Create New Table                                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Table Name: [blog_posts              ]               │
│                                                      │
│ Engine: [InnoDB ▼] (MariaDB only)                     │
│                                                      │
│ Charset: [utf8mb4 ▼]                                │
│                                                      │
│ Collation: [utf8mb4_unicode_ci ▼]                   │
│                                                      │
│ Row Format: [DYNAMIC ▼] (InnoDB)                    │
│                                                      │
│              [Next] [Cancel]                         │
│                                                      │
└──────────────────────────────────────────────────────┘

Step 2: Define Columns
┌──────────────────────────────────────────────────────┐
│ Define Columns                                       │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Column Name    │ Type       │ Null │ Key │ Default  │
│ ─────────────────────────────────────────────────────│
│ id             │ INT        │ NO   │ PRI │ AUTO     │
│ title          │ VARCHAR(255)│ NO   │     │ NULL     │
│ content        │ LONGTEXT   │ YES  │     │ NULL     │
│ author_id      │ INT        │ NO   │ FK  │ NULL     │
│ created_at     │ TIMESTAMP  │ NO   │     │ NOW()    │
│ ┌─────────────────────────────────────────────────┐  │
│ │ [+ Add Column] [Edit] [Delete]                 │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│              [Next] [Back] [Cancel]                  │
│                                                      │
└──────────────────────────────────────────────────────┘

Step 3: Indexes
┌──────────────────────────────────────────────────────┐
│ Define Indexes                                       │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Index Name     │ Type     │ Columns  │ Unique       │
│ ─────────────────────────────────────────────────────│
│ PRIMARY        │ PRIMARY  │ id       │ YES          │
│ idx_author     │ NORMAL   │ author_id│ NO           │
│ idx_created    │ NORMAL   │ created_at│ NO          │
│ ┌─────────────────────────────────────────────────┐  │
│ │ [+ Add Index]                                   │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│              [Create] [Back] [Cancel]                │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Modify Table Structure

```
┌──────────────────────────────────────────────────────┐
│ Modify Table: users                                  │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Columns:                                             │
│ ┌────────────────────────────────────────────────┐   │
│ │ Field    │ Type     │ Null │ Key │ Actions  │   │
│ ├────────────────────────────────────────────────┤   │
│ │ id       │ INT(11)  │ NO   │ PRI │ [⋮] [↕] │   │
│ │ email    │ VARCHAR  │ NO   │ UNI │ [Edit]  │   │
│ │ name     │ VARCHAR  │ YES  │     │ [Edit]  │   │
│ │ created  │ TIMESTAMP│ NO   │     │ [Edit]  │   │
│ │ ┌──────────────────────────────────────────┐  │   │
│ │ │ [+ Add Column] [+ Add Index] [More ▼]    │  │   │
│ │ └──────────────────────────────────────────┘  │   │
│ └────────────────────────────────────────────────┘   │
│                                                      │
│ Table Options:                                       │
│ ├─ Engine: InnoDB                                    │
│ ├─ Charset: utf8mb4                                  │
│ ├─ Collation: utf8mb4_unicode_ci                     │
│ ├─ Row Format: DYNAMIC                               │
│ └─ [Edit Table Options]                              │
│                                                      │
│              [Save Changes] [Cancel] [Drop Table]    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## SQL Console

### Query Editor & Execution

```
┌──────────────────────────────────────────────────────┐
│ SQL Console - mariadb_main                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ┌────────────────────────────────────────────────┐   │
│ │ SELECT * FROM users WHERE status = 'active' │   │
│ │ LIMIT 20;                                      │   │
│ │                                                │   │
│ │ [Syntax highlighting, autocomplete]            │   │
│ │                                                │   │
│ └────────────────────────────────────────────────┘   │
│ [Ctrl+Enter to Execute] [Clear] [History ▼]         │
│                                                      │
│ Execution Time: 0.042s | Rows Affected: 20          │
│                                                      │
│ Results:                                             │
│ ┌────────────────────────────────────────────────┐   │
│ │ id  │ email        │ name    │ status │ created  ││
│ ├────────────────────────────────────────────────┤   │
│ │ 1   │ alice@ex.com │ Alice   │ active │ ...      ││
│ │ 2   │ bob@ex.com   │ Bob     │ active │ ...      ││
│ │ ... │ ...          │ ...     │ ...    │ ...      ││
│ │ 20  │ zack@ex.com  │ Zack    │ active │ ...      ││
│ └────────────────────────────────────────────────┘   │
│                                                      │
│ [Export Results (CSV)] [Copy as JSON] [▼ More]      │
│                                                      │
├──────────────────────────────────────────────────────┤
│ Query History:                                       │
│ [Most recent first]                                  │
│ ├─ SELECT * FROM users ... (just now)              │
│ ├─ UPDATE users SET ... (5 min ago)                │
│ ├─ CREATE TABLE blog_posts ... (1 hour ago)        │
│ └─ [View All] [Clear History]                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Import & Export

### Import Workflow

```
┌──────────────────────────────────────────────────────┐
│ Import Data - mariadb_main                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Step 1: Choose Import Source                         │
│                                                      │
│ ☑ Upload File                                        │
│ │ ┌────────────────────────────────────────────┐     │
│ │ │ [Drop file here or click to upload]        │     │
│ │ │ Supported: .sql, .csv, .json, .gz          │     │
│ │ └────────────────────────────────────────────┘     │
│ │ Maximum file size: 500 MB                          │
│ │                                                    │
│ ○ Paste Text                                         │
│ │ ┌────────────────────────────────────────────┐     │
│ │ │ Paste SQL, CSV, or JSON content here:     │     │
│ │ │                                            │     │
│ │ │                                            │     │
│ │ │                                            │     │
│ │ └────────────────────────────────────────────┘     │
│ │                                                    │
│ ○ Import from Backup                                │
│ │ [Select Backup Point ▼] (latest: 2026-03-01)      │
│ │                                                    │
│                                                      │
│              [Next] [Cancel]                         │
│                                                      │
└──────────────────────────────────────────────────────┘

Step 2: Configure Import

┌──────────────────────────────────────────────────────┐
│ Configure Import                                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│ File: users_export.sql (2.4 MB)                     │
│ Type: SQL Dump (detected)                           │
│                                                      │
│ Options:                                             │
│ ☑ Drop tables if they exist (TRUNCATE, not DROP)    │
│ ☑ Ignore duplicate key errors                       │
│ ☑ Convert table charset to utf8mb4 (recommended)    │
│ ☐ Execute in transaction (rollback on error)        │
│ ☑ Show import progress (streaming)                  │
│                                                      │
│ Preview (first 10 lines):                            │
│ ┌────────────────────────────────────────────┐     │
│ │ CREATE TABLE users (                        │     │
│ │   id INT PRIMARY KEY AUTO_INCREMENT,        │     │
│ │   email VARCHAR(255) UNIQUE NOT NULL,       │     │
│ │   ...                                       │     │
│ └────────────────────────────────────────────┘     │
│                                                      │
│              [Import] [Back] [Cancel]                │
│                                                      │
└──────────────────────────────────────────────────────┘

Step 3: Import Progress & Results

┌──────────────────────────────────────────────────────┐
│ Importing...                                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Overall Progress: [██████████░░░░░░░░░░] 55%        │
│ Time Elapsed: 1 minute 23 seconds                    │
│ Estimated Time Remaining: 1 minute 7 seconds        │
│                                                      │
│ Details:                                             │
│ ├─ Tables Created: 12/15                             │
│ ├─ Rows Inserted: 245,000/450,000                    │
│ ├─ Errors: 0                                         │
│ ├─ Speed: ~3,500 rows/sec                           │
│ └─ Memory Used: 128 MB / 512 MB available            │
│                                                      │
│ [Pause] [Cancel] [Running in background...]         │
│                                                      │
└──────────────────────────────────────────────────────┘

Import Complete!

┌──────────────────────────────────────────────────────┐
│ Import Completed Successfully                        │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Summary:                                             │
│ ├─ Duration: 2 minutes 30 seconds                    │
│ ├─ Tables Created: 15                                │
│ ├─ Rows Inserted: 450,000                            │
│ ├─ Warnings: 3 (nullable fields set to NULL)         │
│ └─ Errors: 0                                         │
│                                                      │
│ Details:                                             │
│ ├─ users: 5,000 rows ✓                               │
│ ├─ posts: 15,000 rows ✓                              │
│ ├─ comments: 200,000 rows ✓                          │
│ ├─ tags: 500 rows ✓                                  │
│ └─ ... (11 more tables)                              │
│                                                      │
│              [Done] [Download Log]                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Export Workflow

```
┌──────────────────────────────────────────────────────┐
│ Export Data - mariadb_main                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Select Tables:                                       │
│ ☑ users (5,000 rows, 50 MB)                         │
│ ☑ posts (15,000 rows, 150 MB)                       │
│ ☑ comments (200,000 rows, 120 MB)                   │
│ ☐ tags (500 rows, 1 MB)                             │
│ [Select All] [Deselect All]                          │
│                                                      │
│ Export Format:                                       │
│ ○ SQL Dump (structure + data)                        │
│ │  ☑ Include CREATE TABLE statements                 │
│ │  ☑ Include DROP TABLE statements                   │
│ │  ☑ Include INSERT statements                       │
│ │  ☐ Include UPDATE statements (if available)        │
│ │  ☐ Compress (gzip)                                 │
│ │  Charset: utf8mb4                                  │
│ │                                                    │
│ ○ CSV (data only, one table per file)                │
│ │  ☑ Include column headers                          │
│ │  Delimiter: [, ▼]                                  │
│ │  Enclosure: [" ▼]                                  │
│ │                                                    │
│ ○ JSON (data only)                                   │
│ │  ☑ Pretty print                                    │
│ │                                                    │
│ Maximum Export Size: 1 GB (your plan allows 2 GB)   │
│ Estimated Size: 320 MB (compressed: 95 MB)          │
│                                                      │
│ ☑ Schedule recurring export (daily)                  │
│ │  Time: [08:00 UTC ▼]                               │
│ │  Keep: [7 days ▼]                                  │
│ │  Notification: Email on completion                 │
│ │                                                    │
│              [Export] [Cancel]                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Database User Management

### Create Database User

```
┌──────────────────────────────────────────────────────┐
│ Create Database User                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Username: [app_user              ]                   │
│ (lowercase alphanumeric + underscore, 2-32 chars)   │
│                                                      │
│ Host Access: [localhost ▼]                           │
│ ○ localhost (local connections only)                 │
│ ○ 127.0.0.1 (IPv4 loopback)                         │
│ ○ % (any host - requires password)                   │
│ ○ Custom IP: [________________]                      │
│ ○ Custom Host: [________________]                    │
│                                                      │
│ Password:                                            │
│ [••••••••••••••••••] [Generate Random]               │
│ [Show/Hide]                                          │
│ [Copy to Clipboard]                                  │
│                                                      │
│ ☑ Require strong password                            │
│   (min 12 chars, uppercase, number, special char)   │
│                                                      │
│ Permissions:                                         │
│ ☑ SELECT   ☑ INSERT   ☑ UPDATE   ☑ DELETE           │
│ ☐ CREATE   ☐ ALTER    ☐ DROP     ☐ GRANT            │
│ ☐ ALL      [Preset: ▼ Application User]              │
│                                                      │
│ Preset Templates:                                    │
│ ├─ Application User: SELECT, INSERT, UPDATE, DELETE  │
│ ├─ Read-Only User: SELECT only                       │
│ ├─ Admin User: All privileges except GRANT           │
│ └─ Custom: [Advanced Permissions Editor]             │
│                                                      │
│              [Create] [Cancel]                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Manage Users & Permissions

```
┌──────────────────────────────────────────────────────┐
│ Database Users - mariadb_main                          │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Users:                                               │
│ ┌──────────────────────────────────────────────┐   │
│ │ User      │ Host      │ Permissions │ Actions  │   │
│ ├──────────────────────────────────────────────┤   │
│ │ root      │ localhost │ ALL         │ [⋮] [↕] │   │
│ │ app_user  │ %         │ SELECT,     │ [⋮] [↕] │   │
│ │           │           │ INSERT,     │         │   │
│ │           │           │ UPDATE,     │         │   │
│ │           │           │ DELETE      │         │   │
│ │ api_user  │ 192.168.  │ SELECT,     │ [⋮] [↕] │   │
│ │           │ 1.0/24    │ INSERT      │         │   │
│ │ backup_ro │ localhost │ SELECT      │ [⋮] [↕] │   │
│ └──────────────────────────────────────────────┘   │
│ [+ Add User]                                         │
│                                                      │
│ Edit User: app_user @ %                              │
│ ┌──────────────────────────────────────────────┐   │
│ │ Password: [••••••••] [Change] [Reset]        │   │
│ │                                              │   │
│ │ Permissions (per table):                     │   │
│ │ [Grant on all tables] [Restrict to tables...] │   │
│ │                                              │   │
│ │ ☑ SELECT   ☑ INSERT   ☑ UPDATE   ☑ DELETE   │   │
│ │ ☐ CREATE   ☐ ALTER    ☐ DROP     ☐ GRANT    │   │
│ │                                              │   │
│ │             [Save] [Reset Password] [Delete] │   │
│ └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Backup & Restore Integration

### Restore from Backup

```
┌──────────────────────────────────────────────────────┐
│ Restore Database from Backup                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│ Target Database: mariadb_main                          │
│                                                      │
│ Available Backups:                                   │
│ ┌──────────────────────────────────────────────┐   │
│ │ Backup Point          │ Size  │ Actions      │   │
│ ├──────────────────────────────────────────────┤   │
│ │ 2026-03-01 09:00 UTC  │ 450MB │ [Restore]   │   │
│ │ 2026-02-28 09:00 UTC  │ 448MB │ [Restore]   │   │
│ │ 2026-02-27 09:00 UTC  │ 445MB │ [Restore]   │   │
│ │ 2026-02-20 09:00 UTC  │ 430MB │ [Restore]   │   │
│ │ 2026-02-01 09:00 UTC  │ 400MB │ [Restore]   │   │
│ └──────────────────────────────────────────────┘   │
│                                                      │
│ Restore Options:                                     │
│ ○ Drop tables and restore data (full restore)       │
│ ○ Merge with existing data (upsert)                 │
│ ○ Restore to table prefix: [bak_ ▼] (creates new)  │
│                                                      │
│ ☑ Verify checksums after restore                    │
│ ☑ Optimize tables after restore                     │
│ ☑ Send email notification on completion             │
│                                                      │
│              [Restore] [Cancel]                      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Plan-Based Limits & Quotas

### Database Limits by Plan

```
Starter Plan (defaults — all values customizable per-customer):
├─ Max databases: 1
├─ Max tables per database: 25
├─ Total storage: 500 MB
├─ Backup retention: Per global backup strategy
├─ Import/export file size: 100 MB
└─ Query timeout: 30 seconds

Business Plan (defaults — all values customizable per-customer):
├─ Max databases: 3
├─ Max tables per database: 100
├─ Total storage: 5 GB
├─ Backup retention: Per global backup strategy
├─ Import/export file size: 500 MB
└─ Query timeout: 60 seconds

Premium Plan (defaults — all values customizable per-customer):
├─ Max databases: 10
├─ Max tables per database: Unlimited
├─ Total storage: 25 GB
├─ Backup retention: Per global backup strategy
├─ Import/export file size: 2 GB
└─ Query timeout: 120 seconds

Control Panel Display:
┌─────────────────────────────────────────────────────┐
│ Storage Usage                                       │
├─────────────────────────────────────────────────────┤
│ Plan: Premium (25 GB limit)                         │
│ Used: 3.2 GB (12.8%)                                │
│ [████░░░░░░░░░░░░░░] 3.2 / 25 GB                   │
│                                                     │
│ Breakdown:                                          │
│ ├─ mariadb_main: 2.1 GB                               │
│ ├─ postgres_analytics: 1.0 GB                       │
│ └─ mariadb_staging: 0.1 GB                            │
│                                                     │
│ Databases: 3 / 10 (30%)                             │
│ Backups Kept: 45 / 90 days (50%)                    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## API Endpoints for Database Management

### Database Access & Listing

```bash
# List all databases (customer's databases or admin can query any customer)
GET /api/v1/customers/{customerId}/databases

Response:
{
  "databases": [
    {
      "id": "db_001",
      "name": "mariadb_main",
      "type": "mysql",
      "version": "8.0.32",
      "size_bytes": 450000000,
      "table_count": 12,
      "row_count": 1250000,
      "charset": "utf8mb4",
      "status": "healthy",
      "last_backup": "2026-03-01T09:00:00Z",
      "created_at": "2025-12-01T10:00:00Z"
    }
  ]
}

# Get database details
GET /api/v1/customers/{customerId}/databases/{databaseId}

# List tables in database
GET /api/v1/customers/{customerId}/databases/{databaseId}/tables

# Get table structure
GET /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/structure

# Get table data (paginated)
GET /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/data?page=1&limit=20&search=&sort=id&order=asc
```

### Table Management (DDL)

```bash
# Create table
POST /api/v1/customers/{customerId}/databases/{databaseId}/tables
{
  "name": "blog_posts",
  "engine": "InnoDB",
  "charset": "utf8mb4",
  "collation": "utf8mb4_unicode_ci",
  "columns": [
    {
      "name": "id",
      "type": "INT",
      "null": false,
      "key": "PRIMARY",
      "extra": "AUTO_INCREMENT"
    },
    {
      "name": "title",
      "type": "VARCHAR",
      "length": 255,
      "null": false
    }
  ],
  "indexes": [
    {
      "name": "idx_author",
      "type": "INDEX",
      "columns": ["author_id"],
      "unique": false
    }
  ]
}

# Modify table
PATCH /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}
{
  "columns": [
    {"operation": "add", "name": "slug", "type": "VARCHAR", "length": 255},
    {"operation": "modify", "name": "title", "type": "VARCHAR", "length": 500},
    {"operation": "drop", "name": "old_field"}
  ],
  "indexes": [
    {"operation": "add", "name": "idx_slug", "columns": ["slug"], "unique": true}
  ]
}

# Delete table
DELETE /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}
```

### Data Management (DML)

```bash
# Insert row
POST /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/rows
{
  "data": {
    "email": "alice@example.com",
    "name": "Alice",
    "status": "active"
  }
}

# Update row
PATCH /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/rows/{rowId}
{
  "data": {
    "name": "Alice Smith",
    "status": "inactive"
  }
}

# Delete row
DELETE /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/rows/{rowId}

# Bulk delete
DELETE /api/v1/customers/{customerId}/databases/{databaseId}/tables/{tableName}/rows
{
  "where": "status = 'inactive' AND created < '2020-01-01'"
}
```

### SQL Console

```bash
# Execute SQL query
POST /api/v1/customers/{customerId}/databases/{databaseId}/query
{
  "sql": "SELECT * FROM users WHERE status = 'active' LIMIT 20;",
  "timeout_seconds": 30
}

Response:
{
  "success": true,
  "execution_time_ms": 42,
  "rows_affected": 20,
  "columns": ["id", "email", "name", "status"],
  "data": [
    {"id": 1, "email": "alice@example.com", "name": "Alice", "status": "active"},
    ...
  ]
}
```

### Import/Export

```bash
# Start import job
POST /api/v1/customers/{customerId}/databases/{databaseId}/import
{
  "file_url": "s3://...",  // Or upload directly
  "format": "sql",  // or "csv", "json"
  "options": {
    "drop_tables": true,
    "charset_conversion": "utf8mb4"
  }
}

Response:
{
  "job_id": "import_001",
  "status": "in_progress",
  "progress_percent": 0,
  "started_at": "2026-03-01T10:00:00Z"
}

# Get import progress
GET /api/v1/customers/{customerId}/databases/{databaseId}/import/{jobId}

# Start export job
POST /api/v1/customers/{customerId}/databases/{databaseId}/export
{
  "tables": ["users", "posts"],
  "format": "sql",  // or "csv", "json"
  "options": {
    "include_create": true,
    "include_data": true,
    "compress": "gzip"
  }
}

Response:
{
  "job_id": "export_001",
  "download_url": "https://...",
  "expires_in_hours": 24,
  "size_bytes": 320000000
}
```

### Database Users

```bash
# Create database user
POST /api/v1/customers/{customerId}/databases/{databaseId}/users
{
  "username": "app_user",
  "password": "secure_password_here",
  "host": "%",  // or specific IP
  "permissions": ["SELECT", "INSERT", "UPDATE", "DELETE"]
}

# Update user permissions
PATCH /api/v1/customers/{customerId}/databases/{databaseId}/users/{userId}
{
  "password": "new_password",
  "permissions": ["SELECT"]
}

# Delete user
DELETE /api/v1/customers/{customerId}/databases/{databaseId}/users/{userId}

# Change user password
POST /api/v1/customers/{customerId}/databases/{databaseId}/users/{userId}/change-password
{
  "password": "new_password"
}
```

### Backups & Restore

```bash
# List backups
GET /api/v1/customers/{customerId}/databases/{databaseId}/backups

# Restore from backup
POST /api/v1/customers/{customerId}/databases/{databaseId}/restore
{
  "backup_id": "backup_001",
  "restore_mode": "drop_and_restore",  // or "merge", "prefix"
  "table_prefix": "bak_"  // if mode is "prefix"
}

Response:
{
  "job_id": "restore_001",
  "status": "in_progress"
}
```

---

## Security & Audit Logging

### Per-Customer Isolation

```
Database Access Control:
├─ Customers can only access their own databases
├─ Admins can access any customer's database
├─ All queries logged with user, timestamp, database, query
├─ Data is encrypted at rest (Longhorn volumes with encryption)
└─ Connections encrypted (TLS) if over network
```

### Audit Logging

```json
{
  "timestamp": "2026-03-01T10:00:00Z",
  "user_id": "user_001",
  "customer_id": "customer_001",
  "database_id": "db_001",
  "action": "QUERY_EXECUTE",
  "query": "SELECT * FROM users WHERE id = 1",
  "affected_rows": 1,
  "duration_ms": 42,
  "result": "success",
  "ip_address": "192.0.2.100",
  "user_agent": "Mozilla/5.0..."
}

{
  "timestamp": "2026-03-01T10:01:00Z",
  "user_id": "user_001",
  "customer_id": "customer_001",
  "database_id": "db_001",
  "action": "TABLE_CREATED",
  "table_name": "blog_posts",
  "result": "success",
  "ip_address": "192.0.2.100"
}

{
  "timestamp": "2026-03-01T10:02:00Z",
  "user_id": "user_001",
  "customer_id": "customer_001",
  "database_id": "db_001",
  "action": "IMPORT_STARTED",
  "file_name": "users_export.sql",
  "file_size_bytes": 2400000,
  "format": "sql",
  "ip_address": "192.0.2.100"
}
```

---

## Implementation Checklist

### Week 1-2: Core Database Browser
- [ ] Database list page (MariaDB + PostgreSQL)
- [ ] Database details page (statistics, tables list)
- [ ] Table structure view (columns, indexes, DDL)
- [ ] Read-only data viewer (paginated, searchable)

### Week 3: Data Editing
- [ ] Inline row editing (modal form)
- [ ] Add new row form
- [ ] Bulk delete operations
- [ ] Row-level audit logging

### Week 4: SQL Console
- [ ] SQL query editor (syntax highlighting, autocomplete)
- [ ] Query execution with results display
- [ ] Query history
- [ ] Export results (CSV, JSON)

### Week 5: Table Editor (DDL)
- [ ] Create table wizard (columns, indexes)
- [ ] Modify table structure (add/edit/drop columns)
- [ ] Add/drop indexes
- [ ] View/edit table options (charset, collation, engine)

### Week 6: Import/Export
- [ ] SQL import (file upload + paste)
- [ ] CSV import (with field mapping)
- [ ] JSON import
- [ ] SQL export (full dump)
- [ ] CSV export (per table)
- [ ] Scheduled recurring exports

### Week 7: Database User Management
- [ ] Create database user with password
- [ ] Manage user permissions (per-table)
- [ ] Reset password
- [ ] Delete user
- [ ] Preset permission templates

### Week 8: Backup Integration
- [ ] List available backups
- [ ] Restore from backup (drop/merge/prefix modes)
- [ ] Point-in-time recovery selection
- [ ] Verify restore integrity

### Week 9: Testing & Documentation
- [ ] Integration tests (all CRUD operations)
- [ ] Security tests (per-customer isolation)
- [ ] Performance tests (large tables, exports)
- [ ] Admin documentation
- [ ] Customer documentation

---

## Related Features

- **Backup & Restore** — RESTORE_SPECIFICATION.md
- **Storage Management** — Persistent volumes, quota enforcement
- **Security** — Encryption at rest, audit logging
- **Plan Limits** — Per-plan database/table/storage limits

---

**Status:** Ready for implementation  
**Estimated Development Time:** 8-9 weeks  
**Key Dependencies:** Database backends (MariaDB, PostgreSQL), Kubernetes persistent volumes, Backup system
