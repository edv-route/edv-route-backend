import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { DriverAuthRepository, DriverProfile } from './driver-auth.repository.js';

// Verified against when the national id is unknown or has no app password, so
// both paths cost the same time (prevents user enumeration via response timing).
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

export interface DriverLoginResult {
  token: string;
  driver: DriverProfile;
}

export class DriverAuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly drivers: DriverAuthRepository,
  ) {}

  async login(nationalId: string, password: string): Promise<DriverLoginResult> {
    const { httpErrors } = this.app;
    const record = await this.drivers.findAuthByNationalId(nationalId.trim());

    // Unknown national id OR a driver without an app password cannot log in.
    if (!record?.passwordHash) {
      await argon2.verify(await DUMMY_HASH_PROMISE, password).catch(() => false);
      throw httpErrors.unauthorized('Cédula o clave incorrectas');
    }

    const validPassword = await argon2.verify(record.passwordHash, password);
    if (!validPassword) {
      throw httpErrors.unauthorized('Cédula o clave incorrectas');
    }

    const token = this.app.jwt.sign({ sub: record.userId, type: 'driver' });

    // Gating is open by decision: any driver with valid credentials logs in and
    // the app routes by `status` (in review / blocked / home). Failed-attempt
    // lockout is deferred — drivers have no lockout columns yet.
    const { passwordHash: _passwordHash, ...driver } = record;
    return { token, driver };
  }

  async getProfile(userId: string): Promise<DriverProfile> {
    const driver = await this.drivers.findProfileById(userId);
    if (!driver) {
      throw this.app.httpErrors.unauthorized('Sesión inválida');
    }
    return driver;
  }

  /** Active requirements (driver + vehicle) the registration wizard asks for. */
  listRequirements() {
    return this.drivers.listActiveRequirements();
  }

  /** App payment catalog: active, non-admin-only methods (never cash_usd). */
  listPaymentMethods() {
    return this.drivers.listAppPaymentMethods();
  }
}
