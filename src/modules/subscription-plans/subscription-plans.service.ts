import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
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
    const record = await this.plans.create({
      name: input.name.trim(),
      description: input.description,
      billingPeriod: input.billingPeriod,
      priceUsd: input.priceUsd,
      allowedVehicleTypes: allowed,
      createdBy: actorId,
    });
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'plan.created',
      entity: 'subscription_plans',
      entityId: record.id,
      data: { name: record.name, billingPeriod: record.billingPeriod, priceUsd: record.priceUsd },
    });
    return record;
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

    const versioned = await this.plans.hasPayments(id);
    const record = versioned ? await this.plans.replace(id, data) : (await this.plans.update(id, data))!;

    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: versioned ? 'plan.versioned' : 'plan.updated',
      entity: 'subscription_plans',
      entityId: record.id,
      data: {
        name: record.name,
        priceUsd: record.priceUsd,
        ...(versioned ? { previousId: id } : {}),
      },
    });
    return record;
  }

  async setActive(id: number, active: boolean, actorId: string): Promise<SubscriptionPlanRecord> {
    const record = await this.plans.setActive(id, active);
    if (!record) throw this.app.httpErrors.notFound('Tarifa no encontrada');
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: active ? 'plan.reactivated' : 'plan.archived',
      entity: 'subscription_plans',
      entityId: id,
      data: { name: record.name },
    });
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
