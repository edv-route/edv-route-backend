import type pg from 'pg';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';

type DriverRow = Camelize<Drivers>;
type UserRow = Camelize<Users>;

/** Public driver profile returned by the app auth flow. */
export type DriverProfile = Pick<UserRow, 'fullName' | 'phone' | 'email' | 'photoUrl'> &
  Pick<DriverRow, 'nationalId' | 'status' | 'registrationStep' | 'isAvailable' | 'avgRating'> & {
    userId: string;
  };

/** Profile + credential hash; the hash never leaves the auth service. */
export type DriverAuthRecord = DriverProfile & { passwordHash: string | null };

const PROFILE_COLUMNS = `
  u.id AS "userId", u.full_name AS "fullName", u.phone, u.email, u.photo_url AS "photoUrl",
  d.national_id AS "nationalId", d.status, d.registration_step AS "registrationStep",
  d.is_available AS "isAvailable", d.avg_rating AS "avgRating"
`;

export class DriverAuthRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Credential lookup by national id (cédula). Includes the password hash. */
  async findAuthByNationalId(nationalId: string): Promise<DriverAuthRecord | null> {
    const { rows } = await this.db.query<DriverAuthRecord>(
      `SELECT ${PROFILE_COLUMNS}, u.password_hash AS "passwordHash"
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.national_id = $1`,
      [nationalId],
    );
    return rows[0] ?? null;
  }

  /** Public profile by user id (for the authenticated /me endpoint). */
  async findProfileById(userId: string): Promise<DriverProfile | null> {
    const { rows } = await this.db.query<DriverProfile>(
      `SELECT ${PROFILE_COLUMNS}
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE u.id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** Active document requirements the app asks for during self-registration. */
  async listActiveRequirements(): Promise<AppRequirement[]> {
    const { rows } = await this.db.query<AppRequirement>(
      `SELECT id, name, description, applies_to AS "appliesTo", is_required AS "isRequired"
       FROM requirements WHERE active ORDER BY applies_to, name`,
    );
    return rows;
  }

  /** Payment methods offered to the app: active and NOT admin-only (no cash_usd). */
  async listAppPaymentMethods(): Promise<AppPaymentMethod[]> {
    const { rows } = await this.db.query<AppPaymentMethod>(
      `SELECT id, name, type::text AS type, details
       FROM payment_methods WHERE is_active AND NOT admin_only ORDER BY name`,
    );
    return rows;
  }

  /** Active vehicle types the app's registration wizard offers (id must be a
   *  real row so the register FK holds). */
  async listActiveVehicleTypes(): Promise<AppVehicleType[]> {
    const { rows } = await this.db.query<AppVehicleType>(
      `SELECT id, name FROM vehicle_types WHERE active ORDER BY name`,
    );
    return rows;
  }

  /**
   * Current active membership (name + price) for the app's enrollment summary.
   * Same criterion the alta uses (`memberships WHERE active`), so the preview
   * equals what will be charged. Null when none is configured.
   */
  async getCurrentMembership(): Promise<AppMembership | null> {
    const { rows } = await this.db.query<AppMembership>(
      `SELECT name, price_usd AS "priceUsd" FROM memberships WHERE active ORDER BY id DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Active subscription plans (tariffs) for the app's enrollment summary. The
   * alta charges the weekly one; the app selects it from this list (a single
   * weekly tariff for now), mirroring the panel's /subscription-plans.
   */
  async listActivePlans(): Promise<AppPlan[]> {
    const { rows } = await this.db.query<AppPlan>(
      `SELECT id, name, price_usd AS "priceUsd", billing_period AS "billingPeriod"
       FROM subscription_plans WHERE active ORDER BY id`,
    );
    return rows;
  }
}

/** A document requirement as the app consumes it. */
export interface AppRequirement {
  id: number;
  name: string;
  description: string | null;
  appliesTo: 'driver' | 'vehicle';
  isRequired: boolean;
}

/** A payment method the app may offer (admin-only methods are excluded upstream). */
export interface AppPaymentMethod {
  id: number;
  name: string;
  type: string;
  details: Record<string, string>;
}

/** A vehicle type the app's registration wizard offers. */
export interface AppVehicleType {
  id: number;
  name: string;
}

/** The active membership as the app's enrollment summary consumes it. */
export interface AppMembership {
  name: string;
  /** Numeric column serialized as a string by pg (matches the panel schema). */
  priceUsd: string;
}

/** A subscription plan (tariff) as the app's enrollment summary consumes it. */
export interface AppPlan {
  id: number;
  name: string;
  priceUsd: string;
  billingPeriod: string;
}
