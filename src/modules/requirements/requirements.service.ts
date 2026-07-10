import type { FastifyInstance } from 'fastify';
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
      return await this.requirements.create({ ...data, name: data.name.trim() });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'Ya existe un requerimiento con ese nombre para ese destinatario',
        );
      }
      throw err;
    }
  }

  async update(id: number, data: UpdateRequirementData): Promise<RequirementRecord> {
    try {
      const record = await this.requirements.update(id, {
        ...data,
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      });
      if (!record) throw this.app.httpErrors.notFound('Requerimiento no encontrado');
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

  async delete(id: number): Promise<void> {
    try {
      const deleted = await this.requirements.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Requerimiento no encontrado');
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
