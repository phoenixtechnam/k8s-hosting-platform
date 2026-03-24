import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { insufficientPermissions, missingToken, invalidToken } from '../shared/errors.js';

export interface JwtPayload {
  readonly sub: string;
  readonly role: 'admin' | 'billing' | 'support' | 'read-only';
  readonly exp: number;
  readonly iat: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export function registerAuth(_app: FastifyInstance): void {
  // @fastify/jwt already decorates request.user
}

export function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    done(missingToken());
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = request.server.jwt.verify<JwtPayload>(token);
    request.user = decoded;
    done();
  } catch {
    done(invalidToken());
  }
}

export function requireRole(...roles: JwtPayload['role'][]) {
  return function checkRole(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    if (!request.user || !roles.includes(request.user.role)) {
      done(insufficientPermissions(roles.join(', ')));
      return;
    }
    done();
  };
}
