import type pg from 'pg';
import type { default as Trainings, TrainingsId } from '../../db/models/public/Trainings.js';
import type TrainingAttendees from '../../db/models/public/TrainingAttendees.js';
import type { Camelize } from '../../db/case-types.js';

type TrainingRow = Camelize<Trainings>;
type AttendeeRow = Camelize<TrainingAttendees>;

export type TrainingRecord = Omit<TrainingRow, 'createdBy'> & {
  /** Non-cancelled enrollments; measures slot usage against capacity. */
  enrolledCount: number;
};

export type AttendeeRecord = Pick<AttendeeRow, 'id' | 'driverId' | 'status' | 'createdAt'> & {
  driverName: string;
  nationalId: string | null;
};

export type TrainingDetail = TrainingRecord & { attendees: AttendeeRecord[] };

export interface TrainingInput {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
  capacity: number | null;
}

const TRAINING_COLUMNS = `
  t.id, t.title, t.description, t.location, t.starts_at AS "startsAt",
  t.ends_at AS "endsAt", t.capacity, t.status,
  t.created_at AS "createdAt", t.updated_at AS "updatedAt",
  (SELECT count(*)::int FROM training_attendees ta
   WHERE ta.training_id = t.id AND ta.status <> 'cancelled') AS "enrolledCount"
`;

export class TrainingsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(opts: { status?: string; page: number; limit: number }): Promise<{
    items: TrainingRecord[];
    total: number;
  }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.status) {
      values.push(opts.status);
      where.push(`t.status = $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM trainings t ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<TrainingRecord>(
      `SELECT ${TRAINING_COLUMNS} FROM trainings t ${whereSql}
       ORDER BY t.starts_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  async findDetail(id: number): Promise<TrainingDetail | null> {
    const { rows } = await this.db.query<TrainingDetail>(
      `SELECT ${TRAINING_COLUMNS},
         (SELECT COALESCE(json_agg(json_build_object(
            'id', ta.id::text, 'driverId', ta.driver_id, 'status', ta.status,
            'createdAt', ta.created_at, 'driverName', u.full_name,
            'nationalId', d.national_id) ORDER BY u.full_name), '[]'::json)
          FROM training_attendees ta
          JOIN users u ON u.id = ta.driver_id
          JOIN drivers d ON d.user_id = ta.driver_id
          WHERE ta.training_id = t.id) AS attendees
       FROM trainings t WHERE t.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(data: TrainingInput, createdBy: string): Promise<TrainingsId> {
    const { rows } = await this.db.query<{ id: TrainingsId }>(
      `INSERT INTO trainings (title, description, location, starts_at, ends_at, capacity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [data.title, data.description, data.location, data.startsAt, data.endsAt, data.capacity, createdBy],
    );
    return rows[0]!.id;
  }

  async update(id: number, data: TrainingInput): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE trainings SET
         title = $2, description = $3, location = $4,
         starts_at = $5, ends_at = $6, capacity = $7
       WHERE id = $1`,
      [id, data.title, data.description, data.location, data.startsAt, data.endsAt, data.capacity],
    );
    return (rowCount ?? 0) > 0;
  }

  async setStatus(id: number, status: 'cancelled' | 'completed'): Promise<boolean> {
    const { rowCount } = await this.db.query(`UPDATE trainings SET status = $2 WHERE id = $1`, [
      id,
      status,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Enrolls atomically: re-checks capacity inside the INSERT so two
   * concurrent enrollments cannot overbook. Re-registering a driver whose
   * enrollment was cancelled reuses the row (UNIQUE pair).
   */
  async enroll(trainingId: number, driverId: string, registeredBy: string): Promise<'ok' | 'full'> {
    const { rowCount } = await this.db.query(
      `INSERT INTO training_attendees (training_id, driver_id, registered_by)
       SELECT $1, $2, $3
       WHERE (SELECT capacity FROM trainings WHERE id = $1) IS NULL
          OR (SELECT count(*) FROM training_attendees
              WHERE training_id = $1 AND status <> 'cancelled')
             < (SELECT capacity FROM trainings WHERE id = $1)
       ON CONFLICT (training_id, driver_id)
       DO UPDATE SET status = 'registered', registered_by = EXCLUDED.registered_by
       WHERE training_attendees.status = 'cancelled'`,
      [trainingId, driverId, registeredBy],
    );
    return (rowCount ?? 0) > 0 ? 'ok' : 'full';
  }

  async setAttendeeStatus(
    trainingId: number,
    attendeeId: string,
    status: 'attended' | 'absent' | 'cancelled',
  ): Promise<AttendeeRow | null> {
    const { rows } = await this.db.query<AttendeeRow>(
      `UPDATE training_attendees SET status = $3
       WHERE id = $1 AND training_id = $2
       RETURNING id, training_id AS "trainingId", driver_id AS "driverId", status,
                 registered_by AS "registeredBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [attendeeId, trainingId, status],
    );
    return rows[0] ?? null;
  }
}
