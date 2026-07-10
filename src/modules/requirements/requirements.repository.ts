import type pg from 'pg';
import type Requirements from '../../db/models/public/Requirements.js';
import type { Camelize } from '../../db/case-types.js';

/** Derived from the generated DB row model. */
export type RequirementRecord = Camelize<Requirements>;

export interface CreateRequirementData {
  name: string;
  description: string | null;
  appliesTo: 'driver' | 'vehicle';
  isRequired: boolean;
  createdBy: string;
}

export interface UpdateRequirementData {
  name?: string;
  description?: string | null;
  appliesTo?: 'driver' | 'vehicle';
  isRequired?: boolean;
  active?: boolean;
}

const COLUMNS = `
  id, name, description, applies_to AS "appliesTo", is_required AS "isRequired",
  active, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

export class RequirementsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<RequirementRecord[]> {
    const { rows } = await this.db.query<RequirementRecord>(
      `SELECT ${COLUMNS} FROM requirements ORDER BY applies_to, name`,
    );
    return rows;
  }

  async findById(id: number): Promise<RequirementRecord | null> {
    const { rows } = await this.db.query<RequirementRecord>(
      `SELECT ${COLUMNS} FROM requirements WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(data: CreateRequirementData): Promise<RequirementRecord> {
    const { rows } = await this.db.query<RequirementRecord>(
      `INSERT INTO requirements (name, description, applies_to, is_required, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [data.name, data.description, data.appliesTo, data.isRequired, data.createdBy],
    );
    return rows[0]!;
  }

  async update(id: number, data: UpdateRequirementData): Promise<RequirementRecord | null> {
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
    if (data.appliesTo !== undefined) {
      values.push(data.appliesTo);
      sets.push(`applies_to = $${values.length}`);
    }
    if (data.isRequired !== undefined) {
      values.push(data.isRequired);
      sets.push(`is_required = $${values.length}`);
    }
    if (data.active !== undefined) {
      values.push(data.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const { rows } = await this.db.query<RequirementRecord>(
      `UPDATE requirements SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM requirements WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
