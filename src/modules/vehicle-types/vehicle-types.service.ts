import type { FastifyInstance } from 'fastify';
import type {
  VehicleTypeRecord,
  VehicleTypesRepository,
} from './vehicle-types.repository.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export class VehicleTypesService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly vehicleTypes: VehicleTypesRepository,
  ) {}

  list(): Promise<VehicleTypeRecord[]> {
    return this.vehicleTypes.list();
  }

  async create(name: string): Promise<VehicleTypeRecord> {
    try {
      return await this.vehicleTypes.create(name.trim().toLowerCase());
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un tipo de vehículo con ese nombre');
      }
      throw err;
    }
  }

  async update(
    id: number,
    data: { name?: string; active?: boolean },
  ): Promise<VehicleTypeRecord> {
    try {
      const record = await this.vehicleTypes.update(id, {
        ...data,
        ...(data.name !== undefined ? { name: data.name.trim().toLowerCase() } : {}),
      });
      if (!record) throw this.app.httpErrors.notFound('Tipo de vehículo no encontrado');
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un tipo de vehículo con ese nombre');
      }
      throw err;
    }
  }

  async delete(id: number): Promise<void> {
    try {
      const deleted = await this.vehicleTypes.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Tipo de vehículo no encontrado');
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'No se puede eliminar: hay registros que usan este tipo. Desactívalo en su lugar.',
        );
      }
      throw err;
    }
  }
}
