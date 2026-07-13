import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type { BenefitRecord, BenefitsRepository } from './benefits.repository.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export class BenefitsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly benefits: BenefitsRepository,
  ) {}

  list(): Promise<BenefitRecord[]> {
    return this.benefits.list();
  }

  async create(name: string, description: string | null, actorId: string): Promise<BenefitRecord> {
    try {
      const record = await this.benefits.create(name.trim(), description);
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'benefit.created',
        entity: 'benefits',
        entityId: record.id,
        data: { name: record.name },
      });
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un beneficio con ese nombre');
      }
      throw err;
    }
  }

  async update(
    id: number,
    data: { name?: string; description?: string | null; active?: boolean },
    actorId: string,
  ): Promise<BenefitRecord> {
    try {
      const record = await this.benefits.update(id, {
        ...data,
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      });
      if (!record) throw this.app.httpErrors.notFound('Beneficio no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'benefit.updated',
        entity: 'benefits',
        entityId: id,
        data: { name: record.name, fields: Object.keys(data) },
      });
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un beneficio con ese nombre');
      }
      throw err;
    }
  }

  async delete(id: number, actorId: string): Promise<void> {
    try {
      const deleted = await this.benefits.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Beneficio no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'benefit.deleted',
        entity: 'benefits',
        entityId: id,
      });
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'No se puede eliminar: el beneficio está asociado a una membresía. Desactívalo en su lugar.',
        );
      }
      throw err;
    }
  }
}
