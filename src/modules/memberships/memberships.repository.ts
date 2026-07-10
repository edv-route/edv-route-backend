import type pg from 'pg';
import type Memberships from '../../db/models/public/Memberships.js';
import type { Camelize } from '../../db/case-types.js';

/** Generated DB row + the aggregated benefit ids of the version. */
export type MembershipRecord = Camelize<Memberships> & { benefitIds: number[] };

export interface MembershipData {
  name: string;
  description: string | null;
  priceUsd: number;
  benefitIds: number[];
  createdBy: string;
}

const COLUMNS = `
  m.id, m.name, m.description, m.price_usd AS "priceUsd", m.active,
  m.created_by AS "createdBy", m.created_at AS "createdAt", m.updated_at AS "updatedAt",
  COALESCE(
    (SELECT array_agg(mb.benefit_id ORDER BY mb.benefit_id)
     FROM membership_benefits mb WHERE mb.membership_id = m.id),
    '{}'
  ) AS "benefitIds"
`;

export class MembershipsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<MembershipRecord[]> {
    const { rows } = await this.db.query<MembershipRecord>(
      `SELECT ${COLUMNS} FROM memberships m ORDER BY m.created_at DESC`,
    );
    return rows;
  }

  async findCurrent(): Promise<MembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRecord>(
      `SELECT ${COLUMNS} FROM memberships m WHERE m.active`,
    );
    return rows[0] ?? null;
  }

  /** A version with at least one payment is frozen: edits create a replica. */
  async hasPayments(membershipId: number): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM membership_payments WHERE membership_id = $1 LIMIT 1',
      [membershipId],
    );
    return rows.length > 0;
  }

  /** Creates a version (first one, or replica during conditional versioning). */
  async createWithBenefits(data: MembershipData): Promise<MembershipRecord> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO memberships (name, description, price_usd, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [data.name, data.description, data.priceUsd, data.createdBy],
      );
      const id = rows[0]!.id;
      await this.insertBenefits(client, id, data.benefitIds);
      await client.query('COMMIT');
      return (await this.findById(id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Edit-in-place path of conditional versioning (no payments on the version). */
  async updateWithBenefits(id: number, data: MembershipData): Promise<MembershipRecord> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memberships SET name = $2, description = $3, price_usd = $4 WHERE id = $1`,
        [id, data.name, data.description, data.priceUsd],
      );
      await client.query('DELETE FROM membership_benefits WHERE membership_id = $1', [id]);
      await this.insertBenefits(client, id, data.benefitIds);
      await client.query('COMMIT');
      return (await this.findById(id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Replica path: archive the paid version and create the new active one. */
  async replaceCurrent(currentId: number, data: MembershipData): Promise<MembershipRecord> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE memberships SET active = false WHERE id = $1', [currentId]);
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO memberships (name, description, price_usd, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [data.name, data.description, data.priceUsd, data.createdBy],
      );
      const id = rows[0]!.id;
      await this.insertBenefits(client, id, data.benefitIds);
      await client.query('COMMIT');
      return (await this.findById(id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async findById(id: number): Promise<MembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRecord>(
      `SELECT ${COLUMNS} FROM memberships m WHERE m.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async insertBenefits(
    client: pg.PoolClient,
    membershipId: number,
    benefitIds: number[],
  ): Promise<void> {
    if (benefitIds.length === 0) return;
    await client.query(
      `INSERT INTO membership_benefits (membership_id, benefit_id)
       SELECT $1, unnest($2::int[])`,
      [membershipId, benefitIds],
    );
  }
}
