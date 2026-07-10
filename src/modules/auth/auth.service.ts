import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { AdminRecord, AdminsRepository } from '../admins/admins.repository.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// Verified against when the username does not exist, so both paths cost the
// same time (prevents user enumeration via response timing).
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

export interface LoginResult {
  token: string;
  admin: AdminRecord;
}

export class AuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly admins: AdminsRepository,
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const { httpErrors } = this.app;
    const admin = await this.admins.findAuthByUsername(username.trim().toLowerCase());

    if (!admin) {
      await argon2.verify(await DUMMY_HASH_PROMISE, password).catch(() => false);
      throw httpErrors.unauthorized('Usuario o contraseña incorrectos');
    }
    if (admin.status !== 'active') {
      throw httpErrors.forbidden('Cuenta suspendida. Contacta a otro administrador.');
    }
    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      throw httpErrors.unauthorized(
        'Cuenta bloqueada temporalmente por intentos fallidos. Intenta en unos minutos.',
      );
    }

    const validPassword = await argon2.verify(admin.passwordHash, password);
    if (!validPassword) {
      await this.admins.recordLoginFailure(admin.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES);
      throw httpErrors.unauthorized('Usuario o contraseña incorrectos');
    }

    await this.admins.recordLoginSuccess(admin.id);

    const token = this.app.jwt.sign({
      sub: admin.id,
      username: admin.username,
      role: admin.role,
    });

    const { passwordHash: _ph, failedLoginAttempts: _fa, lockedUntil: _lu, ...publicAdmin } = admin;
    return { token, admin: { ...publicAdmin, lastLoginAt: new Date() } };
  }

  async getProfile(adminId: string): Promise<AdminRecord> {
    const admin = await this.admins.findById(adminId);
    if (!admin || admin.status !== 'active') {
      throw this.app.httpErrors.unauthorized('Sesión inválida');
    }
    return admin;
  }
}
