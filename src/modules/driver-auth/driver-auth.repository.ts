import type pg from 'pg';
import {
  debtChargePredicate,
  SUBSCRIPTION_PRIORITY,
  paidUntilSql,
  upcomingChargeSql,
} from '../drivers/billing-sql.js';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';

type DriverRow = Camelize<Drivers>;
type UserRow = Camelize<Users>;

/** Public driver profile returned by the app auth flow. */
export type DriverProfile = Pick<UserRow, 'fullName' | 'phone' | 'email' | 'photoUrl'> &
  Pick<DriverRow, 'nationalId' | 'status' | 'registrationStep' | 'isAvailable' | 'avgRating'> & {
    userId: string;
    /** Whether the admin has already set the tariff start. Drives the app between
     *  the "approved, waiting for activation" screen and the operating home. */
    tariffStarted: boolean;
  };

/** Profile + credential hash; the hash never leaves the auth service. */
export type DriverAuthRecord = DriverProfile & { passwordHash: string | null };

const PROFILE_COLUMNS = `
  u.id AS "userId", u.full_name AS "fullName", u.phone, u.email, u.photo_url AS "photoUrl",
  d.national_id AS "nationalId", d.status, d.registration_step AS "registrationStep",
  d.is_available AS "isAvailable", d.avg_rating AS "avgRating",
  (d.tariff_start_set_at IS NOT NULL) AS "tariffStarted"
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

  /** Stamps the terms & conditions consent (accepted at payment time). */
  async markTermsAccepted(userId: string): Promise<void> {
    await this.db.query('UPDATE drivers SET accepted_terms_at = now() WHERE user_id = $1', [userId]);
  }

  /**
   * Updates ONLY the fields a driver may change about himself. Names and
   * national id are deliberately absent: they are the identity an admin already
   * verified against approved documents, and a self-service edit would silently
   * invalidate that review. Any field left `undefined` keeps its value.
   */
  async updateOwnProfile(
    userId: string,
    changes: { phone?: string | null; email?: string | null; address?: string | null; passwordHash?: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE users SET
         phone = CASE WHEN $2::boolean THEN $3 ELSE phone END,
         email = CASE WHEN $4::boolean THEN $5 ELSE email END,
         address = CASE WHEN $6::boolean THEN $7 ELSE address END,
         password_hash = COALESCE($8, password_hash)
       WHERE id = $1`,
      [
        userId,
        changes.phone !== undefined,
        changes.phone ?? null,
        changes.email !== undefined,
        changes.email ?? null,
        changes.address !== undefined,
        changes.address ?? null,
        changes.passwordHash ?? null,
      ],
    );
  }

  /**
   * Points the profile photo at a new bucket path and returns the OLD one, so
   * the caller can delete the orphan object. The binary never touches the DB —
   * only its reference (project rule 3).
   */
  async replacePhotoPath(userId: string, path: string): Promise<string | null> {
    const { rows } = await this.db.query<{ previous: string | null }>(
      `WITH previous AS (SELECT photo_url FROM users WHERE id = $1)
       UPDATE users SET photo_url = $2
       FROM previous
       WHERE users.id = $1
       RETURNING previous.photo_url AS previous`,
      [userId, path],
    );
    return rows[0]?.previous ?? null;
  }

  /**
   * The vehicle he is operating with. A single column means the choice is
   * mutually exclusive by construction: naming one un-names the previous one,
   * with no way to end up with two.
   */
  async setPrimaryVehicle(userId: string, vehicleId: string): Promise<void> {
    await this.db.query('UPDATE drivers SET current_vehicle_id = $2 WHERE user_id = $1', [
      userId,
      vehicleId,
    ]);
  }

  /** A vehicle of THIS driver, with the state that decides if it may be used. */
  async findOwnVehicle(
    userId: string,
    vehicleId: string,
  ): Promise<{ approvalStatus: string } | null> {
    const { rows } = await this.db.query<{ approvalStatus: string }>(
      `SELECT approval_status AS "approvalStatus" FROM vehicles
        WHERE id = $1 AND driver_id = $2`,
      [vehicleId, userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Flips the driver's own availability. Returns null when the id is not a
   * driver, so the caller can answer 404 instead of pretending it worked.
   */
  async setAvailability(userId: string, available: boolean): Promise<boolean | null> {
    const { rows } = await this.db.query<{ isAvailable: boolean }>(
      `UPDATE drivers SET is_available = $2 WHERE user_id = $1
       RETURNING is_available AS "isAvailable"`,
      [userId, available],
    );
    return rows[0]?.isAvailable ?? null;
  }

  /** The driver's operating status, to decide whether he may go available. */
  async findStatus(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ status: string }>(
      'SELECT status::text AS status FROM drivers WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.status ?? null;
  }

  /** Current password hash, to re-authenticate before a self-service change. */
  async findPasswordHash(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ passwordHash: string | null }>(
      'SELECT password_hash AS "passwordHash" FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.passwordHash ?? null;
  }

  /** The driver's own address (the app's edit form needs to prefill it). */
  async findEditableData(userId: string): Promise<{ address: string | null } | null> {
    const { rows } = await this.db.query<{ address: string | null }>(
      'SELECT address FROM users WHERE id = $1',
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
      `SELECT m.name, m.price_usd AS "priceUsd",
              COALESCE((
                SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'description', b.description)
                         ORDER BY b.name)
                FROM membership_benefits mb JOIN benefits b ON b.id = mb.benefit_id
                WHERE mb.membership_id = m.id), '[]'::json) AS benefits
       FROM memberships m WHERE m.active ORDER BY m.id DESC LIMIT 1`,
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

  /**
   * "Completa tu solicitud" checklist (proposal: solicitudes-app): for every
   * active requirement (driver + per-vehicle), the applicant's document state —
   * missing (documentId null) / en revisión (pending) / aprobado / rechazado +
   * motivo — plus each vehicle's own review state so the app can guide the fix.
   */
  async getChecklist(driverId: string): Promise<AppChecklist> {
    const { rows: driverDocuments } = await this.db.query<ChecklistItem>(
      `SELECT r.id AS "requirementId", r.name AS "requirementName", r.is_required AS "isRequired",
              doc.id AS "documentId", COALESCE(doc.file_url IS NOT NULL, false) AS "hasFile",
              doc.approval_status AS "approvalStatus", doc.rejection_reason AS "rejectionReason"
         FROM requirements r
         LEFT JOIN documents doc ON doc.requirement_id = r.id AND doc.driver_id = $1
        WHERE r.applies_to = 'driver' AND r.active
        ORDER BY r.name`,
      [driverId],
    );
    const { rows: vehicles } = await this.db.query<ChecklistVehicle>(
      `SELECT v.id, v.brand, v.model, v.plate,
              v.approval_status AS "approvalStatus", v.rejection_reason AS "rejectionReason",
              -- Which one he works with travels WITH the checklist: the vehicle
              -- list used to ask a second endpoint for it, and when that call
              -- failed the screen silently showed nothing in use — and offered
              -- "use this one" on the vehicle already in use.
              (v.id = d.current_vehicle_id) AS "isPrimary",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'requirementId', r.id, 'requirementName', r.name, 'isRequired', r.is_required,
                  'documentId', doc.id, 'hasFile', COALESCE(doc.file_url IS NOT NULL, false),
                  'approvalStatus', doc.approval_status, 'rejectionReason', doc.rejection_reason)
                  ORDER BY r.name)
                FROM requirements r
                LEFT JOIN documents doc ON doc.requirement_id = r.id AND doc.vehicle_id = v.id
                WHERE r.applies_to = 'vehicle' AND r.active), '[]'::json) AS documents
         FROM vehicles v
         JOIN drivers d ON d.user_id = v.driver_id
        WHERE v.driver_id = $1 ORDER BY v.created_at`,
      [driverId],
    );
    return { driverDocuments, vehicles };
  }

  /**
   * The driver's current alta/arrears debt for the app's deferred payment: the
   * pending membership + the owed tariff/penalty charges (overdue, or pending
   * with an invoice), with per-line labels and the total, plus whether a payment
   * is already under review (so the app shows "en revisión" instead of paying).
   */
  async getDebt(driverId: string): Promise<AppDebt> {
    const { rows } = await this.db.query<{ label: string; amountUsd: string }>(
      `SELECT 'Membresía' AS label, amount_usd::text AS "amountUsd"
         FROM membership_payments WHERE driver_id = $1 AND status = 'pending'
       UNION ALL
       SELECT CASE WHEN sp.charge_kind::text = 'penalty' THEN 'Penalización'
                   ELSE 'Tarifa de la semana' END AS label,
              sp.amount_usd::text AS "amountUsd"
         FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
         WHERE ds.driver_id = $1
           AND ${debtChargePredicate()}`,
      [driverId],
    );
    const items = rows.map((r) => ({ label: r.label, amountUsd: Number(r.amountUsd).toFixed(2) }));
    const total = items.reduce((sum, i) => sum + Number(i.amountUsd), 0);
    // The driver must learn HERE that his payment was turned down and why: until
    // now only the admin panel knew, so a rejected driver saw the payment screen
    // again with no explanation and kept resending the same proof. Same criterion
    // the panel uses (drivers.repository `rejectedSubmission`): only the LATEST
    // submission counts, so sending a new one clears the notice by itself.
    const { rows: state } = await this.db.query<{
      hasPending: boolean;
      rejected: AppDebtRejection | null;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM payment_submissions
                  WHERE driver_id = $1 AND status = 'pending') AS "hasPending",
         (SELECT CASE WHEN ps.status = 'rejected'
                   THEN json_build_object('amountUsd', ps.amount_usd::text,
                          'reason', ps.rejection_reason, 'reviewedAt', ps.reviewed_at)
                   ELSE NULL END
            FROM payment_submissions ps
           WHERE ps.driver_id = $1
           ORDER BY ps.created_at DESC LIMIT 1) AS rejected`,
      [driverId],
    );
    return {
      totalUsd: total.toFixed(2),
      items,
      hasPendingPayment: state[0]?.hasPending ?? false,
      rejected: state[0]?.rejected ?? null,
    };
  }

  /**
   * The driver's ACCOUNT STANDING for his own profile: until when his tariff is
   * paid, which charge comes next, how deep the arrears are, and — when he was
   * penalized and has already settled — when the engine will let him operate
   * again (`reactivatesAt`, written by debt-scheduler and until now never shown
   * to anyone). Every money fact reuses the fragments the admin panel queries
   * with, so both channels answer the same thing.
   */
  async getAccount(driverId: string): Promise<AppAccountRow | null> {
    const { rows } = await this.db.query<AppAccountRow>(
      `WITH sub AS (
         SELECT ds.id, ds.status, p.billing_period, p.price_usd
         FROM driver_subscriptions ds
         JOIN subscription_plans p ON p.id = ds.plan_id
         WHERE ds.driver_id = $1
           AND ds.status IN ('active', 'scheduled', 'pending_payment', 'expired')
         ORDER BY ${SUBSCRIPTION_PRIORITY}, ds.created_at DESC LIMIT 1
       )
       SELECT
         d.status::text AS "driverStatus",
         d.reactivates_at AS "reactivatesAt",
         -- WHEN he starts working, for a driver whose tariff is programmed and
         -- has not begun (2026-08-20). The admin sets the start ("el próximo
         -- lunes") and until now the app said nothing about it: the driver only
         -- got "tu cuenta no está habilitada, contacta a la oficina" when he
         -- tried to go active — a dead end for something that already has a date.
         (SELECT current_period_start FROM driver_subscriptions ds3
           WHERE ds3.id = (SELECT id FROM sub) AND ds3.status = 'scheduled') AS "tariffStartsAt",
         (SELECT status FROM sub) AS "subscriptionStatus",
         (SELECT billing_period FROM sub) AS "billingPeriod",
         (SELECT price_usd::text FROM sub) AS "planPriceUsd",
         ${paidUntilSql('(SELECT id FROM sub)')} AS "paidUntil",
         ${upcomingChargeSql('$1')} AS upcoming,
         (SELECT count(*)::int FROM subscription_payments sp
          JOIN driver_subscriptions ds2 ON ds2.id = sp.driver_subscription_id
          WHERE ds2.driver_id = $1 AND sp.charge_kind::text = 'period'
            AND ${debtChargePredicate()}) AS "weeksOwed",
         (SELECT count(*)::int FROM subscription_payments sp
          JOIN driver_subscriptions ds2 ON ds2.id = sp.driver_subscription_id
          WHERE ds2.driver_id = $1 AND sp.charge_kind::text = 'penalty'
            AND ${debtChargePredicate()}) AS "penaltyCount",
         COALESCE((SELECT (value#>>'{}')::int FROM app_settings
                   WHERE key = 'debt_cap_weeks'), 2) AS "capWeeks"
       FROM drivers d
       WHERE d.user_id = $1`,
      [driverId],
    );
    return rows[0] ?? null;
  }

  /**
   * The driver's vehicles with full detail + photo references (for the profile's
   * vehicle catalog/detail). Photos come as bucket paths (`fileUrl`); the service
   * turns them into short-lived signed URLs.
   */
  async getVehicles(driverId: string): Promise<AppVehicleRow[]> {
    const { rows } = await this.db.query<AppVehicleRow>(
      `SELECT v.id, v.brand, v.model, v.year, v.color, v.plate,
              vt.name AS "vehicleType",
              v.approval_status AS "approvalStatus", v.rejection_reason AS "rejectionReason",
              (v.id = d.current_vehicle_id) AS "isPrimary",
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', vi.id, 'position', vi.position, 'fileUrl', vi.file_url)
                       ORDER BY vi.position)
                FROM vehicle_images vi WHERE vi.vehicle_id = v.id), '[]'::json) AS images
         FROM vehicles v
         JOIN drivers d ON d.user_id = v.driver_id
         LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        WHERE v.driver_id = $1
        ORDER BY v.created_at`,
      [driverId],
    );
    return rows;
  }
}

/** A vehicle photo reference (bucket path; signed by the service before leaving). */
export interface AppVehicleImageRow {
  id: string;
  position: number;
  fileUrl: string;
}

/** A driver's vehicle with full detail, as the repository returns it. */
export interface AppVehicleRow {
  id: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  vehicleType: string | null;
  approvalStatus: string;
  rejectionReason: string | null;
  /** The one he is operating with (drivers.current_vehicle_id). */
  isPrimary: boolean;
  images: AppVehicleImageRow[];
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
  /** Benefits of the active version, for the app's informational pre-screen. */
  benefits: { id: number; name: string; description: string | null }[];
}

/** A subscription plan (tariff) as the app's enrollment summary consumes it. */
export interface AppPlan {
  id: number;
  name: string;
  priceUsd: string;
  billingPeriod: string;
}

/** One document slot in the solicitud checklist (null documentId = missing). */
export interface ChecklistItem {
  requirementId: number;
  requirementName: string;
  isRequired: boolean;
  documentId: string | null;
  hasFile: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected' | null;
  rejectionReason: string | null;
}

/** A vehicle in the checklist, with its own review state and document slots. */
export interface ChecklistVehicle {
  id: string;
  brand: string | null;
  model: string | null;
  plate: string | null;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  rejectionReason: string | null;
  /** The one he is operating with; only one of his can hold it. */
  isPrimary: boolean;
  documents: ChecklistItem[];
}

/** The "completa tu solicitud" checklist the app renders post-login. */
export interface AppChecklist {
  driverDocuments: ChecklistItem[];
  vehicles: ChecklistVehicle[];
}

/** The next weekly charge already emitted but not yet due (pay-in-advance). */
export interface AppUpcomingCharge {
  amountUsd: string;
  periodStart: string;
  periodEnd: string;
}

/** Account standing as the repository returns it (dates still raw from pg). */
export interface AppAccountRow {
  driverStatus: string;
  reactivatesAt: Date | string | null;
  /** His tariff is programmed and starts on this date; null once it is running. */
  tariffStartsAt: Date | string | null;
  subscriptionStatus: string | null;
  billingPeriod: string | null;
  planPriceUsd: string | null;
  paidUntil: Date | string | null;
  upcoming: AppUpcomingCharge | null;
  weeksOwed: number;
  penaltyCount: number;
  capWeeks: number;
}

/** His LAST submission was turned down: what the app tells him, and why. */
export interface AppDebtRejection {
  /** Amount of the rejected submission, USD string. */
  amountUsd: string;
  /** Reason the admin typed. Null only for rejections predating the field. */
  reason: string | null;
  reviewedAt: string;
}

/** The driver's alta/arrears debt for the app's deferred payment screen. */
export interface AppDebt {
  /** Total owed, USD string (numeric column serialized as string). */
  totalUsd: string;
  /** Per-line breakdown (membership, tariff weeks, penalty). */
  items: { label: string; amountUsd: string }[];
  /** A payment for this driver is already awaiting admin review. */
  hasPendingPayment: boolean;
  /** His latest submission was rejected; null once he sends a new one. */
  rejected: AppDebtRejection | null;
}
