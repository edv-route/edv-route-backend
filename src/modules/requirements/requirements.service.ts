import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type {
  CreateRequirementData,
  RequirementRecord,
  RequirementsRepository,
  UpdateRequirementData,
} from './requirements.repository.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export class RequirementsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly requirements: RequirementsRepository,
  ) {}

  list(): Promise<RequirementRecord[]> {
    return this.requirements.list();
  }

  async create(data: CreateRequirementData): Promise<RequirementRecord> {
    try {
      const record = await this.requirements.create({ ...data, name: data.name.trim() });
      await writeAudit(this.app.db, {
        actorAdminId: data.createdBy,
        eventType: 'requirement.created',
        entity: 'requirements',
        entityId: record.id,
        data: { name: record.name, appliesTo: record.appliesTo },
      });
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'Ya existe un requerimiento con ese nombre para ese destinatario',
        );
      }
      throw err;
    }
  }

  async update(id: number, data: UpdateRequirementData, actorId: string): Promise<RequirementRecord> {
    try {
      const record = await this.requirements.update(id, {
        ...data,
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      });
      if (!record) throw this.app.httpErrors.notFound('Requerimiento no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'requirement.updated',
        entity: 'requirements',
        entityId: id,
        data: { name: record.name, fields: Object.keys(data) },
      });
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'Ya existe un requerimiento con ese nombre para ese destinatario',
        );
      }
      throw err;
    }
  }

  async delete(id: number, actorId: string): Promise<void> {
    try {
      const deleted = await this.requirements.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Requerimiento no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'requirement.deleted',
        entity: 'requirements',
        entityId: id,
      });
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'No se puede eliminar: hay documentos asociados. Desactívalo en su lugar.',
        );
      }
      throw err;
    }
  }
}
