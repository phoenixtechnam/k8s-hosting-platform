// Shared role enum used by both routes.ts and service.ts to avoid a
// circular import (routes → service; service → validator → role).

export type CallerRole = 'super_admin' | 'admin' | 'client_admin' | 'client_user';
