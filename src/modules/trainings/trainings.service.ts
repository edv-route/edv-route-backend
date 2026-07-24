import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type {
  TrainingsRepository,
  TrainingDetail,
  TrainingInput,
  TrainingRecord,
} from './trainings.repository.js';

export class TrainingsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly trainings: TrainingsRepository,
  ) {}

  list(opts: { status?: string; page: number; limit: number }): Promise<{
    items: TrainingRecord[];
    total: number;
  }> {
    return this.trainings.list(opts);
  }

  async getDetail(id: number): Promise<TrainingDetail> {
    const detail = await this.trainings.findDetail(id);
    if (!detail) throw this.app.httpErrors.notFound('Capacitación no encontrada');
    return detail;
  }

  async create(input: TrainingInput, actorId: string): Promise<TrainingDetail> {
    const id = await this.trainings.create(this.normalize(input), actorId);
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'training.created',
      entity: 'trainings',
      entityId: id,
      data: { title: input.title, startsAt: input.startsAt },
    });
    return this.getDetail(id);
  }

  async update(id: number, input: TrainingInput, actorId: string): Promise<TrainingDetail> {
    const current = await this.getDetail(id);
    if (current.status !== 'scheduled') {
      throw this.app.httpErrors.conflict('Solo se puede editar una capacitación programada');
    }
    if (input.capacity !== null && input.capacity < current.enrolledCount) {
      throw this.app.httpErrors.conflict(
        `El cupo no puede ser menor que los ${current.enrolledCount} inscritos actuales`,
      );
    }
    await this.trainings.update(id, this.normalize(input));
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'training.updated',
      entity: 'trainings',
      entityId: id,
      data: { title: input.title },
    });
    return this.getDetail(id);
  }

  /** Trainings are cancelled or completed, never deleted (history stays). */
  async setStatus(
    id: number,
    status: 'cancelled' | 'completed',
    actorId: string,
  ): Promise<TrainingDetail> {
    const current = await this.getDetail(id);
    if (current.status !== 'scheduled') {
      throw this.app.httpErrors.conflict('La capacitación ya fue cancelada o completada');
    }
    await this.trainings.setStatus(id, status);
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: status === 'cancelled' ? 'training.cancelled' : 'training.completed',
      entity: 'trainings',
      entityId: id,
      data: { title: current.title },
    });
    return this.getDetail(id);
  }

  async enroll(trainingId: number, driverId: string, actorId: string): Promise<TrainingDetail> {
    const training = await this.getDetail(trainingId);
    if (training.status !== 'scheduled') {
      throw this.app.httpErrors.conflict('Solo se puede inscribir en capacitaciones programadas');
    }

    const { rows } = await this.app.db.query<{ status: string }>(
      'SELECT status FROM drivers WHERE user_id = $1',
      [driverId],
    );
    if (!rows[0]) throw this.app.httpErrors.notFound('Afiliado no encontrado');
    // Approved and paused (licencia) drivers may enroll: a paused driver is
    // still a member, only temporarily on leave (decision 2026-07-23).
    if (!['approved', 'paused'].includes(rows[0].status)) {
      throw this.app.httpErrors.conflict('Solo se pueden inscribir afiliados aprobados o en pausa');
    }

    const existing = training.attendees.find((a) => a.driverId === driverId);
    if (existing && existing.status !== 'cancelled') {
      throw this.app.httpErrors.conflict('El afiliado ya está inscrito en esta capacitación');
    }

    const result = await this.trainings.enroll(trainingId, driverId, actorId);
    if (result === 'full') {
      throw this.app.httpErrors.conflict('No hay cupo disponible en esta capacitación');
    }

    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'training.enrolled',
      entity: 'trainings',
      entityId: trainingId,
      data: { driverId, title: training.title },
    });
    return this.getDetail(trainingId);
  }

  async setAttendeeStatus(
    trainingId: number,
    attendeeId: string,
    status: 'attended' | 'absent' | 'cancelled',
    actorId: string,
  ): Promise<TrainingDetail> {
    const attendee = await this.trainings.setAttendeeStatus(trainingId, attendeeId, status);
    if (!attendee) throw this.app.httpErrors.notFound('Inscripción no encontrada');

    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'training.attendance',
      entity: 'trainings',
      entityId: trainingId,
      data: { driverId: attendee.driverId, status },
    });
    return this.getDetail(trainingId);
  }

  private normalize(input: TrainingInput): TrainingInput {
    return { ...input, title: input.title.trim() };
  }
}
