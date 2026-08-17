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
              COALESCE((
                SELECT json_agg(json_build_object(
                  'requirementId', r.id, 'requirementName', r.name, 'isRequired', r.is_required,
                  'documentId', doc.id, 'hasFile', COALESCE(doc.file_url IS NOT NULL, false),
                  'approvalStatus', doc.approval_status, 'rejectionReason', doc.rejection_reason)
                  ORDER BY r.name)
                FROM requirements r
                LEFT JOIN documents doc ON doc.requirement_id = r.id AND doc.vehicle_id = v.id
                WHERE r.applies_to = 'vehicle' AND r.active), '[]'::json) AS documents
         FROM vehicles v WHERE v.driver_id = $1 ORDER BY v.created_at`,
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
           AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))`,
      [driverId],
    );
    const items = rows.map((r) => ({ label: r.label, amountUsd: Number(r.amountUsd).toFixed(2) }));
    const total = items.reduce((sum, i) => sum + Number(i.amountUsd), 0);
    const { rows: pending } = await this.db.query(
      `SELECT 1 FROM payment_submissions WHERE driver_id = $1 AND status = 'pending' LIMIT 1`,
      [driverId],
    );
    return { totalUsd: total.toFixed(2), items, hasPendingPayment: pending.length > 0 };
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
  documents: ChecklistItem[];
}

/** The "completa tu solicitud" checklist the app renders post-login. */
export interface AppChecklist {
  driverDocuments: ChecklistItem[];
  vehicles: ChecklistVehicle[];
}

/** The driver's alta/arrears debt for the app's deferred payment screen. */
export interface AppDebt {
  /** Total owed, USD string (numeric column serialized as string). */
  totalUsd: string;
  /** Per-line breakdown (membership, tariff weeks, penalty). */
  items: { label: string; amountUsd: string }[];
  /** A payment for this driver is already awaiting admin review. */
  hasPendingPayment: boolean;
}
