export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    remediation?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.remediation = remediation;
  }
}

// Auth errors
export const invalidToken = () =>
  new ApiError('INVALID_TOKEN', 'Token is invalid or expired', 401, undefined, 'Re-authenticate to get new token');

export const missingToken = () =>
  new ApiError('MISSING_BEARER_TOKEN', 'Authorization header missing or invalid', 401, undefined, 'Provide valid JWT in Authorization: Bearer <token>');

export const insufficientPermissions = (required: string) =>
  new ApiError('INSUFFICIENT_PERMISSIONS', 'Insufficient permissions for this action', 403, { required_role: required }, 'Contact admin for permission escalation');

// Resource errors
export const clientNotFound = (id: string) =>
  new ApiError('CLIENT_NOT_FOUND', `Client '${id}' not found`, 404, { client_id: id }, 'Verify client_id');

export const domainNotFound = (id: string) =>
  new ApiError('DOMAIN_NOT_FOUND', `Domain '${id}' not found`, 404, { domain_id: id }, 'Verify domain exists');

// Validation errors
export const invalidEmail = (value: string) =>
  new ApiError('INVALID_EMAIL', 'Invalid email format', 400, { field: 'email', value }, 'Provide valid email address');

export const duplicateEntry = (resource: string, name: string) =>
  new ApiError('DUPLICATE_ENTRY', `This ${resource} already exists`, 409, { resource, name }, 'Use unique identifier');

export const missingRequiredField = (field: string) =>
  new ApiError('MISSING_REQUIRED_FIELD', `Required field missing: ${field}`, 400, { field }, 'Provide missing required field');

// Business logic
export const operationNotAllowed = (reason: string) =>
  new ApiError('OPERATION_NOT_ALLOWED', reason, 403, undefined, 'Verify action is permitted');
