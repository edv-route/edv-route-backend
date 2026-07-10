import type pg from 'pg';
import type Benefits from '../../db/models/public/Benefits.js';
import type { Camelize } from '../../db/case-types.js';

/** Derived from the generated DB row model. */
export type BenefitRecord = Camelize<Benefits>;

const COLUMNS = `id, name, description, active, created_at AS "createdAt", updated_at AS "updatedAt"`;

export class BenefitsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<BenefitRecord[]> {
    const { rows } = await this.db.query<BenefitRecord>(
      `SELECT ${COLUMNS} FROM benefits ORDER BY name`,
    );
    return rows;
  }

  async findById(id: number): Promise<BenefitRecord | null> {
    const { rows } = await this.db.query<BenefitRecord>(
      `SELECT ${COLUMNS} FROM benefits WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(name: string, description: string | null): Promise<BenefitRecord> {
    const { rows } = await this.db.query<BenefitRecord>(
      `INSERT INTO benefits (name, description) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [name, description],
    );
    return rows[0]!;
  }

  async update(
    id: number,
    data: { name?: string; description?: string | null; active?: boolean },
  ): Promise<BenefitRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      values.push(data.name);
      sets.push(`name = $${values.length}`);
    }
    if (data.description !== undefined) {
      values.push(data.description);
      sets.push(`description = $${values.length}`);
    }
    if (data.active !== undefined) {
      values.push(data.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const { rows } = await this.db.query<BenefitRecord>(
      `UPDATE benefits SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM benefits WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
