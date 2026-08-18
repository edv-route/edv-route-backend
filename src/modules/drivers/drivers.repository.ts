import type pg from 'pg';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';
import { withTransaction } from '../../db/tx.js';
import {
  debtChargePredicate,
  SUBSCRIPTION_PRIORITY,
  paidUntilSql,
  upcomingChargeSql,
} from './billing-sql.js';

type DriverRow = Camelize<Drivers>;
type UserRow = Camelize<Users>;

/** Derived tariff state shown as badges in the panel (driver app later). */
export interface DriverSubscriptionSummary {
  status: 'active' | 'scheduled' | 'pending_payment' | 'expired';
  currentPeriodEnd: string | null;
  dueSoon: boolean;
}

/** List projection (multi-table) - anchored to the generated row models. */
export type DriverListItem = Pick<UserRow, 'fullName' | 'email' | 'phone' | 'photoUrl'> &
  Pick<DriverRow, 'userId' | 'nationalId' | 'status' | 'source' | 'registrationStep' | 'createdAt' | 'tariffStartSetAt'> & {
    subscription: DriverSubscriptionSummary | null;
    /** Outstanding debt (membership + owed tariff weeks), USD string ("0.00" if none). */
    debtUsd: string;
    /** A payment (v9 submission) is awaiting admin review. */
    hasPendingSubmission: boolean;
  };

export interface DriverListResult {
  items: DriverListItem[];
  total: number;
}

export interface CreateDriverData {
  firstName: string;
  middleName: string | null;
  lastName: string;
  secondLastName: string | null;
  /** Composed by the service from the four name parts. */
  fullName: string;
  birthDate: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  nationalId: string | null;
  passwordHash: string | null;
  /** Admin who registered (panel); null for self-service app registrations. */
  registeredBy: string | null;
  /** Registration channel. Defaults to 'admin' when omitted. */
  source?: 'admin' | 'app';
  /** Initial driver_status. Defaults to 'pending'; the app channel uses 'applicant'. */
  status?: 'pending' | 'applicant';
  /** When true, stamps accepted_privacy_at = now() (app step-1 privacy consent). */
  acceptedPrivacy?: boolean;
}

const LIST_COLUMNS = `
  d.user_id AS "userId", u.full_name AS "fullName", u.email, u.phone,
  d.national_id AS "nationalId", d.status, d.source,
  d.registration_step AS "registrationStep", d.created_at AS "createdAt",
  d.tariff_start_set_at AS "tariffStartSetAt",
  -- Bucket PATH, not a link: the service signs it before it leaves the API.
  u.photo_url AS "photoUrl"
`;

export class DriversRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(opts: {
    status?: string;
    source?: string;
    search?: string;
    page: number;
    limit: number;
    reminderDays: number;
  }): Promise<DriverListResult> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.status) {
      values.push(opts.status);
      // Compared as text on purpose: a pooled connection with a stale catalog
      // cache would reject a newly added enum value (see the note in
      // plugins/subscription-scheduler.ts).
      where.push(`d.status::text = $${values.length}`);
    } else {
      // Afiliados default: app solicitudes (applicant) live in their own section
      // (source=app & status=applicant); they never show up in the affiliate list.
      where.push(`d.status::text <> 'applicant'`);
    }
    if (opts.source) {
      values.push(opts.source);
      where.push(`d.source::text = $${values.length}`);
    }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      where.push(
        `(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR d.national_id ILIKE $${values.length})`,
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM drivers d JOIN users u ON u.id = d.user_id ${whereSql}`,
      values,
    );

    values.push(opts.reminderDays);
    const reminderIdx = values.length;
    values.push(opts.limit, (opts.page - 1) * opts.limit);

    const { rows } = await this.db.query<DriverListItem>(
      `SELECT ${LIST_COLUMNS},
         (SELECT json_build_object(
            'status', ds.status,
            'currentPeriodEnd', ds.current_period_end,
            -- Due soon = PAID coverage (advances included) runs out within the
            -- reminder window; a driver with prepaid periods is not due
            -- (Luis, 2026-07-13). Same criterion as the dashboard.
            'dueSoon', ds.status = 'active'
                       AND COALESCE(
                         (SELECT max(sp.period_end) FROM subscription_payments sp
                          WHERE sp.driver_subscription_id = ds.id AND sp.status = 'paid'),
                         ds.current_period_end
                       ) <= now() + make_interval(days => $${reminderIdx}))
          FROM driver_subscriptions ds
          WHERE ds.driver_id = d.user_id
            AND ds.status IN ('active', 'scheduled', 'pending_payment', 'expired')
          ORDER BY ${SUBSCRIPTION_PRIORITY}, ds.created_at DESC LIMIT 1) AS subscription,
         -- Outstanding debt (membership pending + overdue / pending-with-invoice
         -- tariff weeks): distinguishes a pending driver who already PAID his alta
         -- (activatable) from one who still OWES — the list showed both the same.
         (COALESCE((SELECT sum(sp.amount_usd) FROM subscription_payments sp
                    JOIN driver_subscriptions ds2 ON ds2.id = sp.driver_subscription_id
                    WHERE ds2.driver_id = d.user_id
                      AND ${debtChargePredicate()}), 0)
          + COALESCE((SELECT sum(mp.amount_usd) FROM membership_payments mp
                      WHERE mp.driver_id = d.user_id AND mp.status = 'pending'), 0))::text AS "debtUsd",
         -- A payment awaiting admin review (v9): the alta is paid but not yet approved.
         EXISTS (SELECT 1 FROM payment_submissions ps
                 WHERE ps.driver_id = d.user_id AND ps.status = 'pending') AS "hasPendingSubmission"
       FROM drivers d JOIN users u ON u.id = d.user_id
       ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  /** Legacy person-only creation (POST /drivers): identity + driver shell in its own TX. */
  async createWithUser(data: CreateDriverData): Promise<string> {
    return withTransaction(this.db, (client) => this.insertUserAndDriver(client, data, 2));
  }

  /**
   * Inserts the identity (`users`) + driver shell (`drivers`) on the given
   * client without owning the transaction: the caller controls the unit of
   * work, so this is a step of the transactional registration (alongside the
   * enrollment) as well as the body of `createWithUser`. `registrationStep`
   * is null for the transactional 2-step wizard (nothing to resume).
   */
  async insertUserAndDriver(
    client: pg.PoolClient,
    data: CreateDriverData,
    registrationStep: number | null,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users
         (first_name, middle_name, last_name, second_last_name, full_name,
          birth_date, address, email, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        data.firstName,
        data.middleName,
        data.lastName,
        data.secondLastName,
        data.fullName,
        data.birthDate,
        data.address,
        data.email,
        data.phone,
        data.passwordHash,
      ],
    );
    const userId = rows[0]!.id;
    await client.query(
      `INSERT INTO drivers
         (user_id, national_id, source, registered_by, registration_step, status, accepted_privacy_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() ELSE NULL END)`,
      [
        userId,
        data.nationalId,
        data.source ?? 'admin',
        data.registeredBy,
        registrationStep,
        data.status ?? 'pending',
        data.acceptedPrivacy ?? false,
      ],
    );
    return userId;
  }

  /**
   * Inserts a vehicle on the given client. `approvalStatus` defaults to
   * `approved` (admin channel = authority); the self-service app passes
   * `pending` so the admin reviews it before the solicitud is approved.
   */
  async insertVehicle(
    client: pg.PoolClient,
    driverId: string,
    input: {
      vehicleTypeId?: number | null;
      brand?: string | null;
      model?: string | null;
      year?: number | null;
      color?: string | null;
      plate?: string | null;
    },
    registeredBy: string | null,
    approvalStatus: 'approved' | 'pending' = 'approved',
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO vehicles
         (driver_id, vehicle_type_id, brand, model, year, color, plate, approval_status, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        driverId,
        input.vehicleTypeId ?? null,
        input.brand ?? null,
        input.model ?? null,
        input.year ?? null,
        input.color ?? null,
        input.plate?.trim().toUpperCase() || null,
        approvalStatus,
        registeredBy,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Inserts a document's metadata owned by a driver XOR a vehicle (file attached
   * later). `approvalStatus` defaults to `approved` (admin channel = authority);
   * the self-service app passes `pending` so the admin reviews it.
   */
  async insertDocument(
    client: pg.PoolClient,
    owner: { driverId: string } | { vehicleId: string },
    input: { requirementId: number; expiresAt?: string | null },
    uploadedBy: string | null,
    approvalStatus: 'approved' | 'pending' = 'approved',
  ): Promise<string> {
    const driverId = 'driverId' in owner ? owner.driverId : null;
    const vehicleId = 'vehicleId' in owner ? owner.vehicleId : null;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents
         (requirement_id, driver_id, vehicle_id, file_url, expires_at, approval_status, uploaded_by)
       VALUES ($1, $2, $3, NULL, $4, $5, $6) RETURNING id`,
      [input.requirementId, driverId, vehicleId, input.expiresAt ?? null, approvalStatus, uploadedBy],
    );
    return rows[0]!.id;
  }

  async findDetail(userId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query(
      `SELECT
         ${LIST_COLUMNS},
         u.first_name AS "firstName", u.middle_name AS "middleName",
         u.last_name AS "lastName", u.second_last_name AS "secondLastName",
         u.birth_date AS "birthDate", u.address,
         (u.password_hash IS NOT NULL) AS "hasAppPassword",
         d.is_available AS "isAvailable", d.avg_rating AS "avgRating",
         d.rating_count AS "ratingCount", d.cancel_count AS "cancelCount",
         d.contract_url AS "contractUrl", d.current_vehicle_id AS "currentVehicleId",
         d.registered_by AS "registeredBy", d.updated_at AS "updatedAt",
         (SELECT COALESCE(json_agg(json_build_object(
            'id', v.id, 'vehicleTypeId', v.vehicle_type_id, 'brand', v.brand,
            'model', v.model, 'year', v.year, 'color', v.color, 'plate', v.plate,
            'approvalStatus', v.approval_status, 'rejectionReason', v.rejection_reason,
            'images', (SELECT COALESCE(json_agg(json_build_object('id', vi.id, 'position', vi.position)
                         ORDER BY vi.position), '[]'::json)
                       FROM vehicle_images vi WHERE vi.vehicle_id = v.id)
          ) ORDER BY v.created_at), '[]'::json)
          FROM vehicles v WHERE v.driver_id = d.user_id) AS vehicles,
         (SELECT COALESCE(json_agg(json_build_object(
            'id', doc.id, 'requirementId', doc.requirement_id, 'requirementName', r.name,
            'appliesTo', r.applies_to, 'vehicleId', doc.vehicle_id, 'fileUrl', doc.file_url,
            'expiresAt', doc.expires_at, 'status', doc.status,
            'approvalStatus', doc.approval_status, 'rejectionReason', doc.rejection_reason
            ) ORDER BY doc.created_at), '[]'::json)
          FROM documents doc JOIN requirements r ON r.id = doc.requirement_id
          WHERE doc.driver_id = d.user_id
             OR doc.vehicle_id IN (SELECT id FROM vehicles WHERE driver_id = d.user_id)
         ) AS documents,
         (SELECT json_build_object(
            'id', mp.id, 'membershipId', mp.membership_id, 'amountUsd', mp.amount_usd,
            'status', mp.status, 'paidAt', mp.paid_at)
          FROM membership_payments mp
          WHERE mp.driver_id = d.user_id AND mp.status <> 'refunded'
          LIMIT 1) AS "membershipPayment",
         -- Benefits of the membership VERSION the driver paid (what he enjoys)
         (SELECT COALESCE(json_agg(json_build_object(
            'id', b.id, 'name', b.name, 'description', b.description) ORDER BY b.name), '[]'::json)
          FROM membership_payments mp2
          JOIN membership_benefits mb ON mb.membership_id = mp2.membership_id
          JOIN benefits b ON b.id = mb.benefit_id
          WHERE mp2.driver_id = d.user_id AND mp2.status <> 'refunded') AS benefits,
         -- Outstanding debt (v8): unpaid weekly charges + penalty. Always an
         -- object (zeros when there is nothing owed). Read-only view; charges
         -- are settled via renew or external-payment, never registered by hand.
         (SELECT json_build_object(
            'totalUsd', (COALESCE(sum(sp.amount_usd), 0)
              + COALESCE((SELECT sum(mp.amount_usd) FROM membership_payments mp
                          WHERE mp.driver_id = d.user_id AND mp.status = 'pending'), 0))::text,
            'membershipDue', COALESCE((SELECT sum(mp.amount_usd) FROM membership_payments mp
                                       WHERE mp.driver_id = d.user_id AND mp.status = 'pending'), 0)::text,
            -- Invoice of the pending membership charge (alta debt): lets the profile
            -- tell whether the membership line is covered by a pending submission.
            'membershipInvoiceId', (SELECT mp.invoice_id FROM membership_payments mp
                                    WHERE mp.driver_id = d.user_id AND mp.status = 'pending' LIMIT 1),
            'weeksOwed', count(*) FILTER (WHERE sp.charge_kind::text = 'period'),
            'penaltyCount', count(*) FILTER (WHERE sp.charge_kind::text = 'penalty'),
            'capWeeks', COALESCE((SELECT (value#>>'{}')::int FROM app_settings WHERE key = 'debt_cap_weeks'), 2),
            'charges', COALESCE(json_agg(json_build_object(
               'id', sp.id, 'kind', sp.charge_kind, 'amountUsd', sp.amount_usd::text,
               'status', sp.status, 'invoiceId', sp.invoice_id, 'periodStart', sp.period_start,
               'periodEnd', sp.period_end) ORDER BY sp.period_start), '[]'::json))
          FROM subscription_payments sp
          JOIN driver_subscriptions ds2 ON ds2.id = sp.driver_subscription_id
          -- Debt (red band) = OVERDUE tariff weeks (not covered by paid coverage)
          -- + penalties + the ALTA debt (membership pending, added into totalUsd
          -- above; and the first week, a pending row that carries an invoice_id).
          -- A pending week WITHOUT an invoice is the UPCOMING charge (amber), not debt.
          WHERE ds2.driver_id = d.user_id
            AND ${debtChargePredicate()}) AS debt,
         -- Próximo cobro (v8): the next weekly charge already emitted (Friday 18:00)
         -- but NOT yet due — the solvent driver's "advance pay" prompt. Null if none.
         ${upcomingChargeSql('d.user_id')} AS upcoming,
         (SELECT json_build_object(
            'id', ds.id, 'planId', ds.plan_id, 'planName', sp.name, 'status', ds.status,
            'billingPeriod', sp.billing_period, 'priceUsd', sp.price_usd::text,
            'startedAt', ds.started_at,
            'currentPeriodStart', ds.current_period_start,
            'currentPeriodEnd', ds.current_period_end,
            -- Paid-through: end of the LAST prepaid period (advances included),
            -- i.e. the date coverage actually runs out (not just the running one).
            'paidUntil', ${paidUntilSql('ds.id')},
            'paidPeriods', (SELECT count(*) FROM subscription_payments spp
                            WHERE spp.driver_subscription_id = ds.id AND spp.status = 'paid'))
          FROM driver_subscriptions ds JOIN subscription_plans sp ON sp.id = ds.plan_id
          WHERE ds.driver_id = d.user_id
            AND ds.status IN ('active','scheduled','pending_payment','expired')
          ORDER BY ${SUBSCRIPTION_PRIORITY}, ds.created_at DESC LIMIT 1) AS subscription,
         -- Pending plan change: only meaningful next to an active subscription
         (SELECT json_build_object(
            'planName', sp.name, 'billingPeriod', sp.billing_period,
            'startsAt', (SELECT min(period_start) FROM subscription_payments spp
                         WHERE spp.driver_subscription_id = ds.id AND spp.status = 'paid'))
          FROM driver_subscriptions ds JOIN subscription_plans sp ON sp.id = ds.plan_id
          WHERE ds.driver_id = d.user_id AND ds.status = 'scheduled'
            AND EXISTS (SELECT 1 FROM driver_subscriptions act
                        WHERE act.driver_id = d.user_id AND act.status = 'active')
          LIMIT 1) AS "scheduledPlan",
         -- v9: a payment under review (pending) drives the "en revisión" band and
         -- hides the pay button; the most recent one, if REJECTED, drives the
         -- "su pago fue rechazado" message (a newer pending/approved supersedes it).
         (SELECT json_build_object('id', ps.id, 'amountUsd', ps.amount_usd::text,
            'purpose', ps.purpose, 'createdAt', ps.created_at,
            -- Invoices this pending payment covers (partial debt payment). Null when
            -- it covers the whole debt / is not a debt payment — profile treats null
            -- as "covers everything" (single band); a list splits covered vs. owed.
            'invoiceIds', ps.context->'invoiceIds')
          FROM payment_submissions ps
          WHERE ps.driver_id = d.user_id AND ps.status = 'pending'
          ORDER BY ps.created_at DESC LIMIT 1) AS "pendingSubmission",
         -- Every pending payment (2026-08-12: multiple allowed), so the profile can
         -- list each with its amount instead of only showing the most recent.
         (SELECT COALESCE(json_agg(json_build_object(
            'id', ps.id, 'submissionNumber', ps.submission_number::text,
            'amountUsd', ps.amount_usd::text, 'purpose', ps.purpose,
            'createdAt', ps.created_at, 'invoiceIds', ps.context->'invoiceIds',
            -- N° of every invoice this payment covers (by receipt link or the debt
            -- invoiceIds it targets), so the card names the exact factura.
            'invoiceNumbers', (
              SELECT COALESCE(json_agg(i.invoice_number::text ORDER BY i.invoice_number), '[]'::json)
              FROM invoices i
              WHERE i.submission_id = ps.id
                 OR i.id::text IN (SELECT jsonb_array_elements_text(ps.context->'invoiceIds'))))
            ORDER BY ps.created_at DESC), '[]'::json)
          FROM payment_submissions ps
          WHERE ps.driver_id = d.user_id AND ps.status = 'pending') AS "pendingSubmissions",
         -- Multiple pending payments (2026-08-12): how many are under review, plus
         -- the UNION of every invoice they cover — so the profile knows which debt
         -- is still UNRESERVED and can offer a new payment for the rest.
         (SELECT count(*)::int FROM payment_submissions ps
          WHERE ps.driver_id = d.user_id AND ps.status = 'pending') AS "pendingCount",
         (SELECT COALESCE(array_agg(DISTINCT inv), '{}') FROM (
            SELECT jsonb_array_elements_text(ps.context->'invoiceIds') AS inv
            FROM payment_submissions ps
            WHERE ps.driver_id = d.user_id AND ps.status = 'pending'
              AND jsonb_typeof(ps.context->'invoiceIds') = 'array'
            UNION
            SELECT mp.invoice_id::text FROM membership_payments mp
            JOIN payment_submissions ps ON ps.id = mp.submission_id
            WHERE ps.driver_id = d.user_id AND ps.status = 'pending' AND mp.invoice_id IS NOT NULL
            UNION
            SELECT sp2.invoice_id::text FROM subscription_payments sp2
            JOIN payment_submissions ps ON ps.id = sp2.submission_id
            WHERE ps.driver_id = d.user_id AND ps.status = 'pending' AND sp2.invoice_id IS NOT NULL
          ) cov WHERE inv IS NOT NULL) AS "coveredInvoiceIds",
         (SELECT CASE WHEN ps.status = 'rejected'
                    THEN json_build_object('rejectionReason', ps.rejection_reason,
                           'reviewedAt', ps.reviewed_at)
                    ELSE NULL END
          FROM payment_submissions ps
          WHERE ps.driver_id = d.user_id
          ORDER BY ps.created_at DESC LIMIT 1) AS "rejectedSubmission"
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * When the debt engine will EMIT this driver's next weekly charge: the billing
   * Friday (billing_day_of_week/hour) of the week BEFORE his paid coverage ends —
   * the exact moment debt-scheduler issues next week's charge. Returns null when
   * the engine is off, there is no active weekly coverage, or that Friday already
   * passed (the charge is then already emitted/pending). Config read from app_settings.
   */
  async weeklyNextChargeAt(driverId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ nextChargeAt: Date | string | null }>(
      `WITH cfg AS (
         SELECT
           (SELECT (value #>> '{}')::boolean FROM app_settings WHERE key = 'debt_engine_enabled') AS enabled,
           COALESCE((SELECT value #>> '{}' FROM app_settings WHERE key = 'business_timezone'), 'America/Caracas') AS tz,
           COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'billing_day_of_week'), 5) AS bdow,
           COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'billing_hour'), 18) AS bh
       ), cov AS (
         SELECT max(spp.period_end) AS paid_until
         FROM subscription_payments spp
         JOIN driver_subscriptions ds ON ds.id = spp.driver_subscription_id
         WHERE ds.driver_id = $1 AND ds.status = 'active'
           AND spp.status = 'paid' AND spp.charge_kind::text = 'period'
       )
       SELECT (
         date_trunc('week', (cov.paid_until - interval '1 day') AT TIME ZONE cfg.tz)
           + make_interval(days => cfg.bdow - 1, hours => cfg.bh)
       ) AT TIME ZONE cfg.tz AS "nextChargeAt"
       FROM cfg, cov
       WHERE cfg.enabled IS TRUE AND cov.paid_until IS NOT NULL`,
      [driverId],
    );
    const raw = rows[0]?.nextChargeAt ?? null;
    if (!raw) return null;
    const when = new Date(raw);
    // Only expose a FUTURE emission; a past one means the charge is already emitted.
    return when.getTime() > Date.now() ? when.toISOString() : null;
  }
}
