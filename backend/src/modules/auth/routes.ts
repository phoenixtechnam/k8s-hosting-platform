import type { FastifyInstance } from 'fastify';
import { loginSchema } from './schema.js';
import { authenticateUser } from './service.js';
import { ApiError } from '../../shared/errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }

    const { email, password } = parsed.data;
    const user = await authenticateUser(app.db, email, password);

    const token = app.jwt.sign(
      {
        sub: user.id,
        role: user.role as 'admin' | 'billing' | 'support' | 'read-only',
        exp: Math.floor(Date.now() / 1000) + 86400,
        iat: Math.floor(Date.now() / 1000),
      },
    );

    return reply.send({
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        },
      },
    });
  });

  app.get('/auth/me', async (request) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string; role: string };

    return {
      data: {
        id: payload.sub,
        role: payload.role,
      },
    };
  });
}
