import type pg from 'pg';
import type SubscriptionPlans from '../../db/models/public/SubscriptionPlans.js';
import type BillingPeriod from '../../db/models/public/BillingPeriod.js';
import type { Camelize } from '../../db/case-types.js';

export type { BillingPeriod };

/** Derived from the generated DB row model. */
export type SubscriptionPlanRecord = Camelize<SubscriptionPlans>;

export interface SubscriptionPlanData {
  name: string;
  description: string | null;
  billingPeriod: BillingPeriod;
  priceUsd: number;
  allowedVehicleTypes: number[] | null;
  createdBy: string;
}

const COLUMNS = `
  id, name, description, billing_period AS "billingPeriod", price_usd AS "priceUsd",
  allowed_vehicle_types AS "allowedVehicleTypes", active,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

export class SubscriptionPlansRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<SubscriptionPlanRecord[]> {
    const { rows } = await this.db.query<SubscriptionPlanRecord>(
      `SELECT ${COLUMNS} FROM subscription_plans ORDER BY active DESC, created_at DESC`,
    );
    return rows;
  }

  async findById(id: number): Promise<SubscriptionPlanRecord | null> {
    const { rows } = await this.db.query<SubscriptionPlanRecord>(
      `SELECT ${COLUMNS} FROM subscription_plans WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** A plan version with at least one payment is frozen: edits create a replica. */
  async hasPayments(planId: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE ds.plan_id = $1 LIMIT 1`,
      [planId],
    );
    return rows.length > 0;
  }

  async create(data: SubscriptionPlanData): Promise<SubscriptionPlanRecord> {
    const { rows } = await this.db.query<SubscriptionPlanRecord>(
      `INSERT INTO subscription_plans
         (name, description, billing_period, price_usd, allowed_vehicle_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.description,
        data.billingPeriod,
        data.priceUsd,
        data.allowedVehicleTypes,
        data.createdBy,
      ],
    );
    return rows[0]!;
  }

  /** Edit-in-place path of conditional versioning. */
  async update(id: number, data: SubscriptionPlanData): Promise<SubscriptionPlanRecord | null> {
    const { rows } = await this.db.query<SubscriptionPlanRecord>(
      `UPDATE subscription_plans SET
         name = $2, description = $3, billing_period = $4,
         price_usd = $5, allowed_vehicle_types = $6
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [
        id,
        data.name,
        data.description,
        data.billingPeriod,
        data.priceUsd,
        data.allowedVehicleTypes,
      ],
    );
    return rows[0] ?? null;
  }

  /** Replica path: archive the paid version and create the replacement. */
  async replace(id: number, data: SubscriptionPlanData): Promise<SubscriptionPlanRecord> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE subscription_plans SET active = false WHERE id = $1', [id]);
      const { rows } = await client.query<SubscriptionPlanRecord>(
        `INSERT INTO subscription_plans
           (name, description, billing_period, price_usd, allowed_vehicle_types, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          data.name,
          data.description,
          data.billingPeriod,
          data.priceUsd,
          data.allowedVehicleTypes,
          data.createdBy,
        ],
      );
      await client.query('COMMIT');
      return rows[0]!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setActive(id: number, active: boolean): Promise<SubscriptionPlanRecord | null> {
    const { rows } = await this.db.query<SubscriptionPlanRecord>(
      `UPDATE subscription_plans SET active = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, active],
    );
    return rows[0] ?? null;
  }
}
