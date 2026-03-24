import { describe, it, expect } from 'vitest';
import {
  ApiError,
  invalidToken,
  missingToken,
  insufficientPermissions,
  clientNotFound,
  domainNotFound,
  invalidEmail,
  duplicateEntry,
  missingRequiredField,
  operationNotAllowed,
} from './errors.js';

describe('ApiError', () => {
  it('should extend Error', () => {
    const err = new ApiError('TEST', 'test message', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('ApiError');
  });

  it('should store all properties', () => {
    const err = new ApiError('CODE', 'msg', 422, { key: 'val' }, 'fix it');
    expect(err.code).toBe('CODE');
    expect(err.message).toBe('msg');
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ key: 'val' });
    expect(err.remediation).toBe('fix it');
  });
});

describe('error factory functions', () => {
  it('invalidToken returns 401', () => {
    const err = invalidToken();
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_TOKEN');
  });

  it('missingToken returns 401', () => {
    const err = missingToken();
    expect(err.status).toBe(401);
    expect(err.code).toBe('MISSING_BEARER_TOKEN');
  });

  it('insufficientPermissions returns 403', () => {
    const err = insufficientPermissions('admin');
    expect(err.status).toBe(403);
    expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(err.details?.required_role).toBe('admin');
  });

  it('clientNotFound returns 404 with client_id', () => {
    const err = clientNotFound('client-123');
    expect(err.status).toBe(404);
    expect(err.code).toBe('CLIENT_NOT_FOUND');
    expect(err.details?.client_id).toBe('client-123');
  });

  it('domainNotFound returns 404', () => {
    const err = domainNotFound('domain-456');
    expect(err.status).toBe(404);
    expect(err.details?.domain_id).toBe('domain-456');
  });

  it('invalidEmail returns 400', () => {
    const err = invalidEmail('bad@');
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_EMAIL');
  });

  it('duplicateEntry returns 409', () => {
    const err = duplicateEntry('domain', 'example.com');
    expect(err.status).toBe(409);
    expect(err.code).toBe('DUPLICATE_ENTRY');
  });

  it('missingRequiredField returns 400', () => {
    const err = missingRequiredField('company_name');
    expect(err.status).toBe(400);
    expect(err.details?.field).toBe('company_name');
  });

  it('operationNotAllowed returns 403', () => {
    const err = operationNotAllowed('Cannot delete active client');
    expect(err.status).toBe(403);
    expect(err.message).toBe('Cannot delete active client');
  });
});
