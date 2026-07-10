import type { FastifyInstance } from 'fastify';
import type {
  BillingPeriod,
  SubscriptionPlanRecord,
  SubscriptionPlansRepository,
} from './subscription-plans.repository.js';

export interface SubscriptionPlanInput {
  name: string;
  description: string | null;
  billingPeriod: BillingPeriod;
  priceUsd: number;
  /** null or [] = all vehicle types (backend normalizes [] to null per doc v7). */
  allowedVehicleTypeIds: number[] | null;
}

export class SubscriptionPlansService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly plans: SubscriptionPlansRepository,
  ) {}

  list(): Promise<SubscriptionPlanRecord[]> {
    return this.plans.list();
  }

  async create(input: SubscriptionPlanInput, actorId: string): Promise<SubscriptionPlanRecord> {
    const allowed = await this.normalizeVehicleTypes(input.allowedVehicleTypeIds);
    return this.plans.create({
      name: input.name.trim(),
      description: input.description,
      billingPeriod: input.billingPeriod,
      priceUsd: input.priceUsd,
      allowedVehicleTypes: allowed,
      createdBy: actorId,
    });
  }

  /** Conditional versioning: in-place without payments, replica with them. */
  async update(
    id: number,
    input: SubscriptionPlanInput,
    actorId: string,
  ): Promise<SubscriptionPlanRecord> {
    const existing = await this.plans.findById(id);
    if (!existing) throw this.app.httpErrors.notFound('Tarifa no encontrada');

    const allowed = await this.normalizeVehicleTypes(input.allowedVehicleTypeIds);
    const data = {
      name: input.name.trim(),
      description: input.description,
      billingPeriod: input.billingPeriod,
      priceUsd: input.priceUsd,
      allowedVehicleTypes: allowed,
      createdBy: actorId,
    };

    if (await this.plans.hasPayments(id)) {
      return this.plans.replace(id, data);
    }
    return (await this.plans.update(id, data))!;
  }

  async setActive(id: number, active: boolean): Promise<SubscriptionPlanRecord> {
    const record = await this.plans.setActive(id, active);
    if (!record) throw this.app.httpErrors.notFound('Tarifa no encontrada');
    return record;
  }

  private async normalizeVehicleTypes(ids: number[] | null): Promise<number[] | null> {
    if (ids === null || ids.length === 0) return null;
    const unique = [...new Set(ids)];
    const { rows } = await this.app.db.query<{ id: number }>(
      'SELECT id FROM vehicle_types WHERE id = ANY($1::smallint[]) AND active',
      [unique],
    );
    if (rows.length !== unique.length) {
      throw this.app.httpErrors.badRequest('Algún tipo de vehículo no existe o está inactivo');
    }
    return unique;
  }
}
