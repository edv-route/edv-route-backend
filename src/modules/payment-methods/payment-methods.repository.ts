import type pg from 'pg';
import type PaymentMethods from '../../db/models/public/PaymentMethods.js';
import type { Camelize } from '../../db/case-types.js';

/** Derived from the generated DB row model (created_by is an internal trace). */
export type PaymentMethodRecord = Omit<Camelize<PaymentMethods>, 'createdBy'>;

const COLUMNS = `id, name, type, details, is_active AS "isActive",
  admin_only AS "adminOnly", created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface CreatePaymentMethodData {
  name: string;
  type: string;
  details: Record<string, unknown>;
  /** v9: true = panel-only (never offered to the driver app). Derived from the type. */
  adminOnly: boolean;
  createdBy: string;
}

export interface UpdatePaymentMethodData {
  name?: string;
  type?: string;
  details?: Record<string, unknown>;
  adminOnly?: boolean;
  isActive?: boolean;
}

export class PaymentMethodsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<PaymentMethodRecord[]> {
    const { rows } = await this.db.query<PaymentMethodRecord>(
      `SELECT ${COLUMNS} FROM payment_methods ORDER BY is_active DESC, name`,
    );
    return rows;
  }

  async findById(id: number): Promise<PaymentMethodRecord | null> {
    const { rows } = await this.db.query<PaymentMethodRecord>(
      `SELECT ${COLUMNS} FROM payment_methods WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(data: CreatePaymentMethodData): Promise<PaymentMethodRecord> {
    const { rows } = await this.db.query<PaymentMethodRecord>(
      `INSERT INTO payment_methods (name, type, details, admin_only, created_by)
       VALUES ($1, $2::payment_method_type, $3::jsonb, $4, $5)
       RETURNING ${COLUMNS}`,
      [data.name, data.type, JSON.stringify(data.details), data.adminOnly, data.createdBy],
    );
    return rows[0]!;
  }

  async update(id: number, data: UpdatePaymentMethodData): Promise<PaymentMethodRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (data.name !== undefined) {
      values.push(data.name);
      sets.push(`name = $${values.length}`);
    }
    if (data.type !== undefined) {
      values.push(data.type);
      sets.push(`type = $${values.length}::payment_method_type`);
    }
    if (data.details !== undefined) {
      values.push(JSON.stringify(data.details));
      sets.push(`details = $${values.length}::jsonb`);
    }
    if (data.adminOnly !== undefined) {
      values.push(data.adminOnly);
      sets.push(`admin_only = $${values.length}`);
    }
    if (data.isActive !== undefined) {
      values.push(data.isActive);
      sets.push(`is_active = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await this.db.query<PaymentMethodRecord>(
      `UPDATE payment_methods SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM payment_methods WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
