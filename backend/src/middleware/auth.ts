import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { insufficientPermissions, missingToken, invalidToken, ApiError } from '../shared/errors.js';
import { isTokenDenied } from '../modules/auth/routes.js';

export type AdminRole = 'super_admin' | 'admin' | 'billing' | 'support' | 'read_only';
export type ClientRole = 'client_admin' | 'client_user';
export type AnyRole = AdminRole | ClientRole;

export interface JwtPayload {
  readonly sub: string;
  readonly role: AnyRole;
  readonly panel: 'admin' | 'client';
  readonly clientId?: string;
  readonly impersonatedBy?: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti?: string;
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

  if (isTokenDenied(token)) {
    done(invalidToken());
    return;
  }

  try {
    const decoded = request.server.jwt.verify<JwtPayload>(token);
    request.user = decoded;
    done();
  } catch {
    done(invalidToken());
  }
}

export function requirePanel(panel: 'admin' | 'client') {
  return function checkPanel(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    if (!request.user || request.user.panel !== panel) {
      done(new ApiError(
        'PANEL_ACCESS_DENIED',
        `This endpoint requires ${panel} panel access`,
        403,
      ));
      return;
    }
    done();
  };
}

export function requireRole(...roles: AnyRole[]) {
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

export function requireClientAccess() {
  return function checkClientAccess(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    const user = request.user;
    if (!user) {
      done(invalidToken());
      return;
    }

    // Admin panel users can access any client
    if (user.panel === 'admin') {
      done();
      return;
    }

    // Client panel users can only access their own client
    const params = request.params as { clientId?: string; id?: string };
    const requestedClientId = params.clientId ?? params.id;

    if (requestedClientId && user.clientId && requestedClientId !== user.clientId) {
      done(new ApiError(
        'CLIENT_ACCESS_DENIED',
        'You can only access your own client resources',
        403,
      ));
      return;
    }

    done();
  };
}
