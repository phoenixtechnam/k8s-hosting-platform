import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../shared/errors.js';
import { errorResponse } from '../shared/response.js';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  if (error instanceof ApiError) {
    reply.status(error.status).send(
      errorResponse(
        error.code,
        error.message,
        error.status,
        requestId,
        error.details,
        error.remediation,
      ),
    );
    return;
  }

  // Fastify validation errors
  if (error.validation) {
    reply.status(400).send(
      errorResponse(
        'VALIDATION_ERROR',
        error.message,
        400,
        requestId,
        { validation: error.validation },
      ),
    );
    return;
  }

  // Unexpected errors
  request.log.error(error);
  reply.status(500).send(
    errorResponse(
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred',
      500,
      requestId,
    ),
  );
}
