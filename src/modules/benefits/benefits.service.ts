import type { FastifyInstance } from 'fastify';
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

  async create(name: string, description: string | null): Promise<BenefitRecord> {
    try {
      return await this.benefits.create(name.trim(), description);
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
  ): Promise<BenefitRecord> {
    try {
      const record = await this.benefits.update(id, {
        ...data,
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      });
      if (!record) throw this.app.httpErrors.notFound('Beneficio no encontrado');
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un beneficio con ese nombre');
      }
      throw err;
    }
  }

  async delete(id: number): Promise<void> {
    try {
      const deleted = await this.benefits.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Beneficio no encontrado');
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
