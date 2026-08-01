import type pg from 'pg';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';
import { withTransaction } from '../../db/tx.js';

type DriverRow = Camelize<Drivers>;
type UserRow = Camelize<Users>;

/** Derived tariff state shown as badges in the panel (driver app later). */
export interface DriverSubscriptionSummary {
  status: 'active' | 'scheduled' | 'pending_payment' | 'expired';
  currentPeriodEnd: string | null;
  dueSoon: boolean;
}

/** List projection (multi-table) - anchored to the generated row models. */
export type DriverListItem = Pick<UserRow, 'fullName' | 'email' | 'phone'> &
  Pick<DriverRow, 'userId' | 'nationalId' | 'status' | 'source' | 'registrationStep' | 'createdAt'> & {
    subscription: DriverSubscriptionSummary | null;
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
  registeredBy: string;
}

const LIST_COLUMNS = `
  d.user_id AS "userId", u.full_name AS "fullName", u.email, u.phone,
  d.national_id AS "nationalId", d.status, d.source,
  d.registration_step AS "registrationStep", d.created_at AS "createdAt"
`;

/**
 * The driver's headline subscription is the one that rules TODAY: a pending
 * plan change adds a `scheduled` row alongside the active one, and the newest
 * row is not the current one (decision 2026-07-15).
 */
const SUBSCRIPTION_PRIORITY = `
  CASE ds.status
    WHEN 'active' THEN 1 WHEN 'expired' THEN 2
    WHEN 'pending_payment' THEN 3 ELSE 4
  END
`;

export class DriversRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(opts: {
    status?: string;
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
          ORDER BY ${SUBSCRIPTION_PRIORITY}, ds.created_at DESC LIMIT 1) AS subscription
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
      `INSERT INTO drivers (user_id, national_id, source, registered_by, registration_step)
       VALUES ($1, $2, 'admin', $3, $4)`,
      [userId, data.nationalId, data.registeredBy, registrationStep],
    );
    return userId;
  }

  /** Inserts a vehicle on the given client (admin-registered = approved). */
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
    registeredBy: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO vehicles
         (driver_id, vehicle_type_id, brand, model, year, color, plate, approval_status, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8) RETURNING id`,
      [
        driverId,
        input.vehicleTypeId ?? null,
        input.brand ?? null,
        input.model ?? null,
        input.year ?? null,
        input.color ?? null,
        input.plate?.trim().toUpperCase() || null,
        registeredBy,
      ],
    );
    return rows[0]!.id;
  }

  /** Inserts a document's metadata owned by a driver XOR a vehicle (file attached later). */
  async insertDocument(
    client: pg.PoolClient,
    owner: { driverId: string } | { vehicleId: string },
    input: { requirementId: number; expiresAt?: string | null },
    uploadedBy: string,
  ): Promise<string> {
    const driverId = 'driverId' in owner ? owner.driverId : null;
    const vehicleId = 'vehicleId' in owner ? owner.vehicleId : null;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (requirement_id, driver_id, vehicle_id, file_url, expires_at, uploaded_by)
       VALUES ($1, $2, $3, NULL, $4, $5) RETURNING id`,
      [input.requirementId, driverId, vehicleId, input.expiresAt ?? null, uploadedBy],
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
            'approvalStatus', v.approval_status,
            'images', (SELECT COALESCE(json_agg(json_build_object('id', vi.id, 'position', vi.position)
                         ORDER BY vi.position), '[]'::json)
                       FROM vehicle_images vi WHERE vi.vehicle_id = v.id)
          ) ORDER BY v.created_at), '[]'::json)
          FROM vehicles v WHERE v.driver_id = d.user_id) AS vehicles,
         (SELECT COALESCE(json_agg(json_build_object(
            'id', doc.id, 'requirementId', doc.requirement_id, 'requirementName', r.name,
            'appliesTo', r.applies_to, 'vehicleId', doc.vehicle_id, 'fileUrl', doc.file_url,
            'expiresAt', doc.expires_at, 'status', doc.status) ORDER BY doc.created_at), '[]'::json)
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
            'weeksOwed', count(*) FILTER (WHERE sp.charge_kind::text = 'period'),
            'penaltyCount', count(*) FILTER (WHERE sp.charge_kind::text = 'penalty'),
            'capWeeks', COALESCE((SELECT (value#>>'{}')::int FROM app_settings WHERE key = 'debt_cap_weeks'), 2),
            'charges', COALESCE(json_agg(json_build_object(
               'id', sp.id, 'kind', sp.charge_kind, 'amountUsd', sp.amount_usd::text,
               'status', sp.status, 'periodStart', sp.period_start,
               'periodEnd', sp.period_end) ORDER BY sp.period_start), '[]'::json))
          FROM subscription_payments sp
          JOIN driver_subscriptions ds2 ON ds2.id = sp.driver_subscription_id
          -- Debt (red band) = OVERDUE tariff weeks (not covered by paid coverage)
          -- + penalties + the ALTA debt (membership pending, added into totalUsd
          -- above; and the first week, a pending row that carries an invoice_id).
          -- A pending week WITHOUT an invoice is the UPCOMING charge (amber), not debt.
          WHERE ds2.driver_id = d.user_id
            AND ((sp.charge_kind::text = 'period' AND (
                    (sp.status = 'overdue' AND sp.period_start >= COALESCE(
                       (SELECT max(cov.period_end) FROM subscription_payments cov
                        WHERE cov.driver_subscription_id = sp.driver_subscription_id
                          AND cov.status = 'paid' AND cov.charge_kind::text = 'period'), sp.period_start))
                    OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL)))
                 OR (sp.charge_kind::text = 'penalty' AND sp.status IN ('pending', 'overdue')))) AS debt,
         -- Próximo cobro (v8): the next weekly charge already emitted (Friday 18:00)
         -- but NOT yet due — the solvent driver's "advance pay" prompt. Null if none.
         (SELECT json_build_object(
            'amountUsd', sp.amount_usd::text,
            'periodStart', sp.period_start, 'periodEnd', sp.period_end)
          FROM subscription_payments sp
          JOIN driver_subscriptions ds4 ON ds4.id = sp.driver_subscription_id
          WHERE ds4.driver_id = d.user_id
            AND sp.charge_kind::text = 'period' AND sp.status = 'pending'
            AND sp.period_start >= COALESCE(
              (SELECT max(cov.period_end) FROM subscription_payments cov
               WHERE cov.driver_subscription_id = sp.driver_subscription_id
                 AND cov.status = 'paid' AND cov.charge_kind::text = 'period'), sp.period_start)
          ORDER BY sp.period_start LIMIT 1) AS upcoming,
         (SELECT json_build_object(
            'id', ds.id, 'planId', ds.plan_id, 'planName', sp.name, 'status', ds.status,
            'billingPeriod', sp.billing_period, 'priceUsd', sp.price_usd::text,
            'startedAt', ds.started_at,
            'currentPeriodStart', ds.current_period_start,
            'currentPeriodEnd', ds.current_period_end,
            -- Paid-through: end of the LAST prepaid period (advances included),
            -- i.e. the date coverage actually runs out (not just the running one).
            'paidUntil', (SELECT max(spp.period_end) FROM subscription_payments spp
                          WHERE spp.driver_subscription_id = ds.id AND spp.status = 'paid'
                            AND spp.charge_kind::text = 'period'),
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
          LIMIT 1) AS "scheduledPlan"
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }
}
