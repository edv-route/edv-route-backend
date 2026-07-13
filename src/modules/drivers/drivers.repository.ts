import type pg from 'pg';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';

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
  fullName: string;
  email: string | null;
  phone: string | null;
  nationalId: string | null;
  registeredBy: string;
}

const LIST_COLUMNS = `
  d.user_id AS "userId", u.full_name AS "fullName", u.email, u.phone,
  d.national_id AS "nationalId", d.status, d.source,
  d.registration_step AS "registrationStep", d.created_at AS "createdAt"
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
      where.push(`d.status = $${values.length}`);
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
            'dueSoon', ds.status = 'active'
                       AND ds.current_period_end <= now() + make_interval(days => $${reminderIdx}))
          FROM driver_subscriptions ds
          WHERE ds.driver_id = d.user_id
            AND ds.status IN ('active', 'scheduled', 'pending_payment', 'expired')
          ORDER BY ds.created_at DESC LIMIT 1) AS subscription
       FROM drivers d JOIN users u ON u.id = d.user_id
       ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  /** Wizard step 1: identity + driver shell in one transaction. */
  async createWithUser(data: CreateDriverData): Promise<string> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
        [data.fullName, data.email, data.phone],
      );
      const userId = rows[0]!.id;
      await client.query(
        `INSERT INTO drivers (user_id, national_id, source, registered_by, registration_step)
         VALUES ($1, $2, 'admin', $3, 2)`,
        [userId, data.nationalId, data.registeredBy],
      );
      await client.query('COMMIT');
      return userId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findDetail(userId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query(
      `SELECT
         ${LIST_COLUMNS},
         d.is_available AS "isAvailable", d.avg_rating AS "avgRating",
         d.rating_count AS "ratingCount", d.cancel_count AS "cancelCount",
         d.contract_url AS "contractUrl", d.current_vehicle_id AS "currentVehicleId",
         d.registered_by AS "registeredBy", d.updated_at AS "updatedAt",
         (SELECT COALESCE(json_agg(json_build_object(
            'id', v.id, 'vehicleTypeId', v.vehicle_type_id, 'brand', v.brand,
            'model', v.model, 'year', v.year, 'color', v.color, 'plate', v.plate,
            'approvalStatus', v.approval_status) ORDER BY v.created_at), '[]'::json)
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
         (SELECT json_build_object(
            'id', ds.id, 'planId', ds.plan_id, 'planName', sp.name, 'status', ds.status,
            'billingPeriod', sp.billing_period,
            'currentPeriodStart', ds.current_period_start,
            'currentPeriodEnd', ds.current_period_end,
            'paidPeriods', (SELECT count(*) FROM subscription_payments spp
                            WHERE spp.driver_subscription_id = ds.id AND spp.status = 'paid'))
          FROM driver_subscriptions ds JOIN subscription_plans sp ON sp.id = ds.plan_id
          WHERE ds.driver_id = d.user_id
            AND ds.status IN ('active','scheduled','pending_payment','expired')
          ORDER BY ds.created_at DESC LIMIT 1) AS subscription
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }
}
