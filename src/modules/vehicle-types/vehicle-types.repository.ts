import type pg from 'pg';
import type VehicleTypes from '../../db/models/public/VehicleTypes.js';
import type { Camelize } from '../../db/case-types.js';

/** Derived from the generated DB row model. */
export type VehicleTypeRecord = Camelize<VehicleTypes>;

const COLUMNS = `id, name, active, created_at AS "createdAt", updated_at AS "updatedAt"`;

export class VehicleTypesRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<VehicleTypeRecord[]> {
    const { rows } = await this.db.query<VehicleTypeRecord>(
      `SELECT ${COLUMNS} FROM vehicle_types ORDER BY id`,
    );
    return rows;
  }

  async findById(id: number): Promise<VehicleTypeRecord | null> {
    const { rows } = await this.db.query<VehicleTypeRecord>(
      `SELECT ${COLUMNS} FROM vehicle_types WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(name: string): Promise<VehicleTypeRecord> {
    const { rows } = await this.db.query<VehicleTypeRecord>(
      `INSERT INTO vehicle_types (name) VALUES ($1) RETURNING ${COLUMNS}`,
      [name],
    );
    return rows[0]!;
  }

  async update(
    id: number,
    data: { name?: string; active?: boolean },
  ): Promise<VehicleTypeRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      values.push(data.name);
      sets.push(`name = $${values.length}`);
    }
    if (data.active !== undefined) {
      values.push(data.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const { rows } = await this.db.query<VehicleTypeRecord>(
      `UPDATE vehicle_types SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM vehicle_types WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
