import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from './error-handler.js';
import { ApiError } from '../shared/errors.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

function createMockRequestReply() {
  const sendFn = vi.fn();
  const statusFn = vi.fn().mockReturnValue({ send: sendFn });
  const reply = { status: statusFn, send: sendFn } as unknown as FastifyReply;
  const request = {
    id: 'req-test-123',
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;

  return { request, reply, statusFn, sendFn };
}

describe('errorHandler', () => {
  it('should handle ApiError with correct status and envelope', () => {
    const { request, reply, statusFn, sendFn } = createMockRequestReply();
    const err = new ApiError('CLIENT_NOT_FOUND', 'Not found', 404, { client_id: 'x' }, 'Check ID');

    errorHandler(err as unknown as FastifyError, request, reply);

    expect(statusFn).toHaveBeenCalledWith(404);
    const body = sendFn.mock.calls[0][0];
    expect(body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(body.error.message).toBe('Not found');
    expect(body.error.status).toBe(404);
    expect(body.error.request_id).toBe('req-test-123');
    expect(body.error.details).toEqual({ client_id: 'x' });
    expect(body.error.remediation).toBe('Check ID');
  });

  it('should handle Fastify validation errors', () => {
    const { request, reply, statusFn, sendFn } = createMockRequestReply();
    const err = {
      validation: [{ message: 'field is required' }],
      message: 'body must have required property "name"',
    } as unknown as FastifyError;

    errorHandler(err, request, reply);

    expect(statusFn).toHaveBeenCalledWith(400);
    const body = sendFn.mock.calls[0][0];
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.validation).toBeDefined();
  });

  it('should handle unexpected errors with 500', () => {
    const { request, reply, statusFn, sendFn } = createMockRequestReply();
    const err = new Error('unexpected crash') as FastifyError;

    errorHandler(err, request, reply);

    expect(statusFn).toHaveBeenCalledWith(500);
    const body = sendFn.mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(request.log.error).toHaveBeenCalledWith(err);
  });
});
