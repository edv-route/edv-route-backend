import type { FastifyInstance } from 'fastify';
import type { DriversRepository, DriverListResult } from './drivers.repository.js';
import type { EnrollmentRepository, RejectionResult } from './enrollment.repository.js';

const UNIQUE_VIOLATION = '23505';

const PERIOD_INTERVALS: Record<string, string> = {
  daily: '1 day',
  weekly: '7 days',
  monthly: '1 month',
  annual: '1 year',
};

export interface CreateDriverInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  nationalId?: string | null;
}

export interface VehicleInput {
  vehicleTypeId?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  color?: string | null;
  plate?: string | null;
}

export interface DocumentInput {
  requirementId: number;
  vehicleId?: string | null;
  fileUrl?: string | null;
  expiresAt?: string | null;
}

export interface EnrollInput {
  planId: number;
  periods: number;
}

export class DriversService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly drivers: DriversRepository,
    private readonly enrollment: EnrollmentRepository,
  ) {}

  async list(opts: { status?: string; search?: string; page: number; limit: number }): Promise<DriverListResult> {
    const reminderDays = await this.getSetting('payment_reminder_days', 3);
    return this.drivers.list({ ...opts, reminderDays: Number(reminderDays) });
  }

  async getDetail(driverId: string): Promise<Record<string, unknown>> {
    const detail = await this.drivers.findDetail(driverId);
    if (!detail) throw this.app.httpErrors.notFound('Afiliado no encontrado');
    return detail;
  }

  /** Wizard step 1 (admin origin: national_id optional, nothing blocks). */
  async create(input: CreateDriverInput, adminId: string): Promise<Record<string, unknown>> {
    try {
      const userId = await this.drivers.createWithUser({
        fullName: input.fullName.trim(),
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        nationalId: input.nationalId?.trim() || null,
        registeredBy: adminId,
      });
      await this.audit(adminId, 'driver.created', 'drivers', userId, { source: 'admin' });
      return this.getDetail(userId);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un afiliado con esa cédula o email');
      }
      throw err;
    }
  }

  /** Wizard step 3: vehicle (admin-registered vehicles are approved directly). */
  async addVehicle(driverId: string, input: VehicleInput, adminId: string): Promise<void> {
    await this.assertDriver(driverId);
    try {
      await this.app.db.query(
        `INSERT INTO vehicles
           (driver_id, vehicle_type_id, brand, model, year, color, plate, approval_status, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8)`,
        [
          driverId,
          input.vehicleTypeId ?? null,
          input.brand ?? null,
          input.model ?? null,
          input.year ?? null,
          input.color ?? null,
          input.plate?.trim().toUpperCase() || null,
          adminId,
        ],
      );
      await this.audit(adminId, 'vehicle.registered', 'drivers', driverId, { plate: input.plate });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un vehículo con esa placa');
      }
      throw err;
    }
  }

  /** Wizard step 2 (optional via admin): document metadata against a requirement. */
  async addDocument(driverId: string, input: DocumentInput, adminId: string): Promise<void> {
    await this.assertDriver(driverId);
    const { rows } = await this.app.db.query<{ appliesTo: string }>(
      'SELECT applies_to AS "appliesTo" FROM requirements WHERE id = $1 AND active',
      [input.requirementId],
    );
    const requirement = rows[0];
    if (!requirement) throw this.app.httpErrors.badRequest('Requerimiento no válido');

    const isVehicleDoc = requirement.appliesTo === 'vehicle';
    if (isVehicleDoc && !input.vehicleId) {
      throw this.app.httpErrors.badRequest('Este requerimiento aplica a un vehículo: indica cuál');
    }

    await this.app.db.query(
      `INSERT INTO documents (requirement_id, driver_id, vehicle_id, file_url, expires_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.requirementId,
        isVehicleDoc ? null : driverId,
        isVehicleDoc ? input.vehicleId : null,
        input.fileUrl ?? null,
        input.expiresAt ?? null,
        adminId,
      ],
    );
    await this.audit(adminId, 'document.registered', 'drivers', driverId, {
      requirementId: input.requirementId,
    });
  }

  /** Wizard step 4: membership + tariff (basic or advance xN) with invoices. */
  async enroll(driverId: string, input: EnrollInput, adminId: string): Promise<{ invoiceNumbers: string[] }> {
    const driver = await this.getDetail(driverId);
    if (driver['membershipPayment']) {
      throw this.app.httpErrors.conflict('Este afiliado ya pagó la membresía');
    }

    const { rows: mRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
      'SELECT id, price_usd AS "priceUsd" FROM memberships WHERE active',
    );
    const membership = mRows[0];
    if (!membership) throw this.app.httpErrors.conflict('No existe una membresía vigente');

    const { rows: pRows } = await this.app.db.query<{ id: number; priceUsd: string; billingPeriod: string }>(
      'SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod" FROM subscription_plans WHERE id = $1 AND active',
      [input.planId],
    );
    const plan = pRows[0];
    if (!plan) throw this.app.httpErrors.badRequest('La tarifa no existe o está archivada');

    const result = await this.enrollment.enroll({
      driverId,
      membershipId: membership.id,
      membershipPriceUsd: Number(membership.priceUsd),
      planId: plan.id,
      planPriceUsd: Number(plan.priceUsd),
      periods: input.periods,
      periodInterval: PERIOD_INTERVALS[plan.billingPeriod]!,
      registeredBy: adminId,
    });

    await this.audit(adminId, 'driver.enrolled', 'drivers', driverId, {
      planId: plan.id,
      periods: input.periods,
      invoices: result.invoiceNumbers,
    });
    return result;
  }

  /** Approval requires both wizard payments (doc v7: money, not papers). */
  async approve(driverId: string, adminId: string): Promise<void> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'pending') {
      throw this.app.httpErrors.conflict('Solo se puede aprobar un afiliado pendiente');
    }
    const membershipPayment = detail['membershipPayment'] as { status: string } | null;
    const subscription = detail['subscription'] as { billingPeriod: string } | null;
    if (!membershipPayment || membershipPayment.status !== 'paid' || !subscription) {
      throw this.app.httpErrors.conflict(
        'No se puede aprobar: faltan los pagos de membresía y tarifa (paso 4)',
      );
    }

    const timezone = await this.getSetting('business_timezone', 'America/Caracas');
    await this.enrollment.approve(
      driverId,
      PERIOD_INTERVALS[subscription.billingPeriod]!,
      String(timezone),
    );
    await this.audit(adminId, 'driver.approved', 'drivers', driverId, null);
  }

  /**
   * Registers a tariff renewal (advance xN allowed). If the subscription is
   * expired, the payment reactivates the driver's operation instantly -
   * no admin status change involved (business decision 2026-07-10).
   */
  async renewSubscription(
    driverId: string,
    periods: number,
    adminId: string,
  ): Promise<{ invoiceNumbers: string[]; reactivated: boolean }> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'approved') {
      throw this.app.httpErrors.conflict('Solo se renueva la tarifa de afiliados aprobados');
    }
    const subscription = detail['subscription'] as {
      id: string;
      planId: number;
      status: string;
      billingPeriod: string;
    } | null;
    if (!subscription || !['active', 'expired'].includes(subscription.status)) {
      throw this.app.httpErrors.conflict('El afiliado no tiene una tarifa activa ni vencida que renovar');
    }

    const { rows } = await this.app.db.query<{ priceUsd: string; active: boolean }>(
      'SELECT price_usd AS "priceUsd", active FROM subscription_plans WHERE id = $1',
      [subscription.planId],
    );
    const plan = rows[0]!;
    if (!plan.active) {
      throw this.app.httpErrors.conflict(
        'La tarifa del afiliado fue retirada del catálogo. El cambio de plan estará disponible próximamente.',
      );
    }

    const timezone = await this.getSetting('business_timezone', 'America/Caracas');
    const reactivate = subscription.status === 'expired';

    const result = await this.enrollment.renew({
      subscriptionId: subscription.id,
      driverId,
      planPriceUsd: Number(plan.priceUsd),
      periods,
      periodInterval: PERIOD_INTERVALS[subscription.billingPeriod]!,
      timezone: String(timezone),
      reactivate,
      registeredBy: adminId,
    });

    await this.audit(adminId, 'subscription.renewed', 'drivers', driverId, {
      periods,
      invoices: result.invoiceNumbers,
      reactivated: reactivate,
    });
    return { ...result, reactivated: reactivate };
  }

  private async getSetting(key: string, fallback: unknown): Promise<unknown> {
    const { rows } = await this.app.db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? fallback;
  }

  async reject(driverId: string, adminId: string): Promise<RejectionResult> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'pending') {
      throw this.app.httpErrors.conflict('Solo se puede rechazar un afiliado pendiente');
    }
    const result = await this.enrollment.reject(driverId, adminId);
    await this.audit(adminId, 'driver.rejected', 'drivers', driverId, { ...result });
    return result;
  }

  async updateProfile(
    driverId: string,
    input: CreateDriverInput & { status?: 'approved' | 'suspended' },
    adminId: string,
  ): Promise<Record<string, unknown>> {
    await this.assertDriver(driverId);
    try {
      if (input.fullName !== undefined || input.email !== undefined || input.phone !== undefined) {
        await this.app.db.query(
          `UPDATE users SET
             full_name = COALESCE($2, full_name),
             email = COALESCE($3, email),
             phone = COALESCE($4, phone)
           WHERE id = $1`,
          [driverId, input.fullName ?? null, input.email ?? null, input.phone ?? null],
        );
      }
      if (input.nationalId !== undefined || input.status !== undefined) {
        await this.app.db.query(
          `UPDATE drivers SET
             national_id = COALESCE($2, national_id),
             status = COALESCE($3, status)
           WHERE user_id = $1`,
          [driverId, input.nationalId ?? null, input.status ?? null],
        );
      }
      await this.audit(adminId, 'driver.updated', 'drivers', driverId, { fields: Object.keys(input) });
      return this.getDetail(driverId);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Cédula o email ya en uso por otro afiliado');
      }
      throw err;
    }
  }

  private async assertDriver(driverId: string): Promise<void> {
    const { rows } = await this.app.db.query('SELECT 1 FROM drivers WHERE user_id = $1', [driverId]);
    if (rows.length === 0) throw this.app.httpErrors.notFound('Afiliado no encontrado');
  }

  private async audit(
    adminId: string,
    eventType: string,
    entity: string,
    entityId: string,
    data: unknown,
  ): Promise<void> {
    await this.app.db.query(
      `INSERT INTO audit_logs (actor_admin_id, event_type, entity, entity_id, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, eventType, entity, entityId, data === null ? null : JSON.stringify(data)],
    );
  }
}
