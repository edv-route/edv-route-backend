import type { FastifyInstance } from 'fastify';
import type { MembershipRecord, MembershipsRepository } from './memberships.repository.js';

export interface MembershipInput {
  name: string;
  description: string | null;
  priceUsd: number;
  benefitIds: number[];
}

export class MembershipsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly memberships: MembershipsRepository,
  ) {}

  list(): Promise<MembershipRecord[]> {
    return this.memberships.list();
  }

  async getCurrent(): Promise<MembershipRecord> {
    const current = await this.memberships.findCurrent();
    if (!current) throw this.app.httpErrors.notFound('Aún no se ha creado la membresía');
    return current;
  }

  async create(input: MembershipInput, actorId: string): Promise<MembershipRecord> {
    if (await this.memberships.findCurrent()) {
      throw this.app.httpErrors.conflict(
        'Ya existe una membresía vigente. Edítala: el versionado se maneja automáticamente.',
      );
    }
    await this.validateBenefits(input.benefitIds);
    return this.memberships.createWithBenefits({ ...this.normalize(input), createdBy: actorId });
  }

  /**
   * Conditional versioning (design doc v7 #22): no payments on the current
   * version -> edit in place; payments exist -> archive it and create an
   * active replica. Existing members keep the version (and price) they paid.
   */
  async updateCurrent(input: MembershipInput, actorId: string): Promise<MembershipRecord> {
    const current = await this.getCurrent();
    await this.validateBenefits(input.benefitIds);
    const data = { ...this.normalize(input), createdBy: actorId };

    return (await this.memberships.hasPayments(current.id))
      ? this.memberships.replaceCurrent(current.id, data)
      : this.memberships.updateWithBenefits(current.id, data);
  }

  private normalize(input: MembershipInput): MembershipInput {
    return {
      ...input,
      name: input.name.trim(),
      benefitIds: [...new Set(input.benefitIds)],
    };
  }

  private async validateBenefits(benefitIds: number[]): Promise<void> {
    if (benefitIds.length === 0) return;
    const { rows } = await this.app.db.query<{ id: number }>(
      'SELECT id FROM benefits WHERE id = ANY($1::int[]) AND active',
      [benefitIds],
    );
    if (rows.length !== new Set(benefitIds).size) {
      throw this.app.httpErrors.badRequest('Algún beneficio no existe o está inactivo');
    }
  }
}
