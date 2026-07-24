import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../../db/tx.js';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type { DriversRepository, DriverListResult } from './drivers.repository.js';
import type { EnrollmentRepository, RejectionResult } from './enrollment.repository.js';

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const ADULT_AGE_YEARS = 18;

const PERIOD_INTERVALS: Record<string, string> = {
  daily: '1 day',
  weekly: '7 days',
  monthly: '1 month',
  annual: '1 year',
};

export interface CreateDriverInput {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  secondLastName?: string | null;
  birthDate?: string | null;
  address?: string | null;
  email?: string | null;
  /** E.164 (+58...), composed by the panel from the locked country code. */
  phone?: string | null;
  /** Canonical "V-12345678" composed from type + number in the UI. */
  nationalId?: string | null;
  /** App login (username = national_id); requires nationalId when present. */
  password?: string | null;
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
  /** Payment details (v8, Pieza 2): stamped on the primary invoice. Optional. */
  paymentMethodId?: number | null;
  reference?: string | null;
  payerBank?: string | null;
}

/** Payment details captured at cobro time; stamped on the primary invoice. */
export interface PaymentMeta {
  paymentMethodId?: number | null;
  reference?: string | null;
  payerBank?: string | null;
}

export interface RegisterDocumentInput {
  requirementId: number;
  expiresAt?: string | null;
}

/** Everything beyond the person that the transactional registration may carry. */
export interface RegisterInput {
  payment: EnrollInput | null;
  vehicles: VehicleInput[];
  documents: RegisterDocumentInput[];
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

  /** Wizard step 1 (admin origin: only names block; the rest validates if given). */
  async create(input: CreateDriverInput, adminId: string): Promise<Record<string, unknown>> {
    const person = await this.validatePersonalData(input);
    try {
      const userId = await this.drivers.createWithUser({
        ...person,
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

  /**
   * Transactional registration (wizard, decision 2026-07-21): creates the
   * identity + driver and, in the SAME transaction, its vehicles, its document
   * metadata and - when a payment is given - membership + tariff with invoices.
   * If any step fails nothing persists (no orphan driver/vehicle/invoice). The
   * document FILES are uploaded by the client afterwards against the returned
   * `createdDocumentIds` (a document may exist without a file, exactly like the
   * profile). `payment` null = the driver stays `pending` (approval will
   * require the payments later).
   */
  async register(
    input: CreateDriverInput,
    extras: RegisterInput,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const person = await this.validatePersonalData(input);
    const { payment, vehicles, documents } = extras;

    // Resolve catalog prices before opening the transaction (read-only lookups;
    // amounts are snapshotted at insert time). Mirrors the checks in `enroll`.
    let money: Omit<Parameters<EnrollmentRepository['enrollOnClient']>[1], 'driverId'> | null = null;
    if (payment) {
      const { rows: mRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
        'SELECT id, price_usd AS "priceUsd" FROM memberships WHERE active',
      );
      const membership = mRows[0];
      if (!membership) throw this.app.httpErrors.conflict('No existe una membresía vigente');

      const { rows: pRows } = await this.app.db.query<{
        id: number;
        priceUsd: string;
        billingPeriod: string;
      }>(
        'SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod" FROM subscription_plans WHERE id = $1 AND active',
        [payment.planId],
      );
      const plan = pRows[0];
      if (!plan) throw this.app.httpErrors.badRequest('La tarifa no existe o está archivada');

      money = {
        membershipId: membership.id,
        membershipPriceUsd: Number(membership.priceUsd),
        planId: plan.id,
        planPriceUsd: Number(plan.priceUsd),
        periods: payment.periods,
        periodInterval: PERIOD_INTERVALS[plan.billingPeriod]!,
        registeredBy: adminId,
      };
    }

    // Documents in the alta are DRIVER documents (vehicle docs live in the
    // profile): validate every requirement is an active driver requirement
    // before writing anything.
    if (documents.length > 0) {
      const { rows } = await this.app.db.query<{ id: number }>(
        `SELECT id FROM requirements WHERE active AND applies_to = 'driver'`,
      );
      const valid = new Set(rows.map((r) => r.id));
      for (const doc of documents) {
        if (!valid.has(doc.requirementId)) {
          throw this.app.httpErrors.badRequest(
            'Uno de los documentos no corresponde a un requerimiento de chofer vigente',
          );
        }
      }
    }

    let result: { userId: string; invoiceNumbers: string[]; documentIds: string[] };
    try {
      result = await withTransaction(this.app.db, async (client) => {
        // The whole alta is transactional: no incremental step to resume (null).
        const userId = await this.drivers.insertUserAndDriver(
          client,
          { ...person, registeredBy: adminId },
          null,
        );
        for (const vehicle of vehicles) {
          await this.drivers.insertVehicle(client, userId, vehicle, adminId);
        }
        const documentIds: string[] = [];
        for (const doc of documents) {
          documentIds.push(await this.drivers.insertDocument(client, userId, doc, adminId));
        }
        let invoiceNumbers: string[] = [];
        if (money) {
          const enrolled = await this.enrollment.enrollOnClient(client, { ...money, driverId: userId });
          invoiceNumbers = enrolled.invoiceNumbers;
        }
        return { userId, invoiceNumbers, documentIds };
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === UNIQUE_VIOLATION) {
        if (e.constraint?.includes('plate')) {
          throw this.app.httpErrors.conflict('Ya existe un vehículo con esa placa');
        }
        throw this.app.httpErrors.conflict('Ya existe un afiliado con esa cédula o email');
      }
      if (e.code === FK_VIOLATION) {
        throw this.app.httpErrors.badRequest('Referencia inválida (tipo de vehículo o requerimiento)');
      }
      throw err;
    }

    await this.audit(adminId, 'driver.created', 'drivers', result.userId, {
      source: 'admin',
      withPayment: payment !== null,
      vehicles: vehicles.length,
      documents: documents.length,
    });
    for (const vehicle of vehicles) {
      await this.audit(adminId, 'vehicle.registered', 'drivers', result.userId, {
        plate: vehicle.plate ?? null,
      });
    }
    for (const doc of documents) {
      await this.audit(adminId, 'document.registered', 'drivers', result.userId, {
        requirementId: doc.requirementId,
      });
    }
    let primaryInvoiceId: string | null = null;
    if (payment) {
      if (result.invoiceNumbers[0]) {
        primaryInvoiceId = await this.enrollment.setInvoicePaymentMeta(
          result.invoiceNumbers[0],
          this.normalizeMeta(payment),
        );
      }
      await this.audit(adminId, 'driver.enrolled', 'drivers', result.userId, {
        planId: payment.planId,
        periods: payment.periods,
        invoices: result.invoiceNumbers,
      });
    }

    const detail = await this.getDetail(result.userId);
    return {
      ...detail,
      invoiceNumbers: result.invoiceNumbers,
      createdDocumentIds: result.documentIds,
      primaryInvoiceId,
    };
  }

  /**
   * Shared personal-data rules (create and profile edit): composes full_name
   * from the four parts, enforces adulthood and hashes the app password.
   * The password is never logged nor returned.
   */
  private async validatePersonalData(input: CreateDriverInput): Promise<{
    firstName: string;
    middleName: string | null;
    lastName: string;
    secondLastName: string | null;
    fullName: string;
    birthDate: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
    nationalId: string | null;
    passwordHash: string | null;
  }> {
    const firstName = input.firstName.trim();
    const middleName = input.middleName?.trim() || null;
    const lastName = input.lastName.trim();
    const secondLastName = input.secondLastName?.trim() || null;
    const nationalId = input.nationalId?.trim().toUpperCase() || null;

    if (input.birthDate) {
      const adultThreshold = new Date();
      adultThreshold.setFullYear(adultThreshold.getFullYear() - ADULT_AGE_YEARS);
      if (new Date(input.birthDate) > adultThreshold) {
        throw this.app.httpErrors.badRequest('El afiliado debe ser mayor de 18 años');
      }
    }

    let passwordHash: string | null = null;
    if (input.password) {
      if (!nationalId) {
        throw this.app.httpErrors.badRequest(
          'Para crear la contraseña de la app se necesita el documento de identidad (es el usuario de acceso)',
        );
      }
      passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    }

    return {
      firstName,
      middleName,
      lastName,
      secondLastName,
      fullName: [firstName, middleName, lastName, secondLastName].filter(Boolean).join(' '),
      birthDate: input.birthDate ?? null,
      address: input.address?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      nationalId,
      passwordHash,
    };
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
  async addDocument(driverId: string, input: DocumentInput, adminId: string): Promise<{ id: string }> {
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

    const { rows: created } = await this.app.db.query<{ id: string }>(
      `INSERT INTO documents (requirement_id, driver_id, vehicle_id, file_url, expires_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
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
    return { id: created[0]!.id };
  }

  /** Normalizes optional payment details for stamping on the invoice. */
  private normalizeMeta(input: PaymentMeta): {
    paymentMethodId: number | null;
    reference: string | null;
    payerBank: string | null;
  } {
    return {
      paymentMethodId: input.paymentMethodId ?? null,
      reference: input.reference?.trim() || null,
      payerBank: input.payerBank?.trim() || null,
    };
  }

  /** Wizard step 4: membership + tariff (basic or advance xN) with invoices. */
  async enroll(
    driverId: string,
    input: EnrollInput,
    adminId: string,
  ): Promise<{ invoiceNumbers: string[]; primaryInvoiceId: string | null }> {
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

    const primaryInvoiceId = result.invoiceNumbers[0]
      ? await this.enrollment.setInvoicePaymentMeta(result.invoiceNumbers[0], this.normalizeMeta(input))
      : null;

    await this.audit(adminId, 'driver.enrolled', 'drivers', driverId, {
      planId: plan.id,
      periods: input.periods,
      invoices: result.invoiceNumbers,
    });
    return { ...result, primaryInvoiceId };
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
    const anchorWeekly =
      subscription.billingPeriod === 'weekly' && (await this.isDebtEngineOn());
    await this.enrollment.approve(
      driverId,
      PERIOD_INTERVALS[subscription.billingPeriod]!,
      String(timezone),
      anchorWeekly,
    );
    await this.audit(adminId, 'driver.approved', 'drivers', driverId, null);
  }

  /**
   * Administrative pause (licencia, decision 2026-07-23): the admin pauses an
   * approved driver whose tariff is up to date (zero debt). The tariff is frozen
   * (the scheduler skips paused drivers); `resume` shifts the remaining coverage
   * forward by the pause duration. `is_available` is untouched: pausing is an
   * administrative state, not the driver's voluntary availability toggle.
   */
  async pause(driverId: string, adminId: string): Promise<Record<string, unknown>> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'approved') {
      throw this.app.httpErrors.conflict('Solo se puede pausar a un afiliado aprobado');
    }
    const subscription = detail['subscription'] as { status: string } | null;
    if (!subscription || subscription.status !== 'active') {
      throw this.app.httpErrors.conflict(
        'Solo se puede pausar con la tarifa al día (sin deuda pendiente)',
      );
    }
    await this.app.db.query(
      `UPDATE drivers SET status = 'paused', paused_at = now() WHERE user_id = $1`,
      [driverId],
    );
    await this.audit(adminId, 'driver.paused', 'drivers', driverId, null);
    return this.getDetail(driverId);
  }

  /**
   * External payment (design v8): registers money the driver handed to the
   * admin outside the system. It settles every outstanding charge (arrears +
   * penalty fine) and emits its invoice; the debt engine then derives the
   * driver out of `overdue`/`penalized`. The admin never writes the state by
   * hand - the debt is what changes. `note` leaves the reason on the record.
   */
  async registerExternalPayment(
    driverId: string,
    input: PaymentMeta & { note?: string | null },
    adminId: string,
  ): Promise<{
    invoiceNumber: string;
    primaryInvoiceId: string | null;
    settledCharges: number;
    totalUsd: string;
  }> {
    await this.assertDriver(driverId);
    const result = await this.enrollment.registerExternalPayment({
      driverId,
      registeredBy: adminId,
    });
    if (!result) {
      throw this.app.httpErrors.conflict('El afiliado no tiene cargos pendientes por saldar');
    }
    const primaryInvoiceId = await this.enrollment.setInvoicePaymentMeta(
      result.invoiceNumber,
      this.normalizeMeta(input),
    );
    await this.audit(adminId, 'driver.external_payment', 'drivers', driverId, {
      ...result,
      note: input.note ?? null,
    });
    return { ...result, primaryInvoiceId };
  }

  /**
   * Manual reactivation (design v8): puts a settled driver back on the road
   * immediately instead of waiting for the automatic reactivation moment
   * (`reactivation_mode = auto` rejoins on the next anchor day). Requires the
   * debt to be zero - money first, state second.
   */
  async reactivate(driverId: string, adminId: string): Promise<Record<string, unknown>> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'penalized') {
      throw this.app.httpErrors.conflict('Solo se puede reactivar a un afiliado penalizado');
    }
    const { rows } = await this.app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE ds.driver_id = $1 AND sp.status = 'overdue'`,
      [driverId],
    );
    if (rows[0]!.n !== '0') {
      throw this.app.httpErrors.conflict(
        'No se puede reactivar: el afiliado todavía tiene deuda pendiente',
      );
    }
    await this.app.db.query(
      `UPDATE drivers SET status = 'approved', is_available = true, reactivates_at = NULL
       WHERE user_id = $1`,
      [driverId],
    );
    await this.audit(adminId, 'driver.reactivated', 'drivers', driverId, null);
    return this.getDetail(driverId);
  }

  /**
   * Lift an administrative pause: the driver returns to `approved` + available
   * and the frozen tariff windows resume running (shifted by the pause length).
   */
  async resume(driverId: string, adminId: string): Promise<Record<string, unknown>> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'paused') {
      throw this.app.httpErrors.conflict('Solo se puede reanudar a un afiliado en pausa');
    }
    const subscription = detail['subscription'] as { billingPeriod: string } | null;
    const timezone = String(await this.getSetting('business_timezone', 'America/Caracas'));
    const anchorWeekly =
      subscription?.billingPeriod === 'weekly' && (await this.isDebtEngineOn());
    await this.enrollment.resume(driverId, timezone, anchorWeekly);
    await this.audit(adminId, 'driver.resumed', 'drivers', driverId, null);
    return this.getDetail(driverId);
  }

  /**
   * Registers a tariff renewal (advance xN allowed). If the subscription is
   * expired, the payment reactivates the driver's operation instantly -
   * no admin status change involved (business decision 2026-07-10).
   *
   * With `planId` it changes plan instead (decision 2026-07-15): with paid
   * coverage left the new plan is scheduled and starts when that coverage
   * runs out; without coverage it starts immediately.
   */
  async renewSubscription(
    driverId: string,
    input: { periods: number; planId?: number },
    adminId: string,
  ): Promise<{
    invoiceNumbers: string[];
    reactivated: boolean;
    planChanged: boolean;
    startsAt?: string;
  }> {
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

    const currentPlan = await this.findPlan(subscription.planId);
    const timezone = String(await this.getSetting('business_timezone', 'America/Caracas'));
    const isPlanChange = input.planId !== undefined && input.planId !== subscription.planId;

    // A programmed change already owns the coverage that follows: paying more
    // periods now (of either plan) would overlap them.
    if (detail['scheduledPlan']) {
      throw this.app.httpErrors.conflict(
        'Ya hay un cambio de tarifa programado. Cancélalo si necesitas cobrar otra cosa.',
      );
    }

    if (!isPlanChange) {
      if (!currentPlan.active) {
        throw this.app.httpErrors.conflict(
          'La tarifa del afiliado fue retirada del catálogo: elige una tarifa vigente para renovar',
        );
      }
      const reactivate = subscription.status === 'expired';
      const result = await this.enrollment.renew({
        subscriptionId: subscription.id,
        driverId,
        planPriceUsd: Number(currentPlan.priceUsd),
        periods: input.periods,
        periodInterval: PERIOD_INTERVALS[subscription.billingPeriod]!,
        timezone,
        reactivate,
        anchorWeekly: subscription.billingPeriod === 'weekly' && (await this.isDebtEngineOn()),
        registeredBy: adminId,
      });
      await this.audit(adminId, 'subscription.renewed', 'drivers', driverId, {
        periods: input.periods,
        invoices: result.invoiceNumbers,
        reactivated: reactivate,
      });
      return { ...result, reactivated: reactivate, planChanged: false };
    }

    // --- plan change ---
    const newPlan = await this.findPlan(input.planId!);
    if (!newPlan.active) {
      throw this.app.httpErrors.badRequest('La tarifa elegida está archivada: elige una vigente');
    }

    const mode = subscription.status === 'expired' ? 'immediate' : 'scheduled';
    const result = await this.enrollment.changePlan({
      driverId,
      currentSubscriptionId: subscription.id,
      newPlanId: newPlan.id,
      planPriceUsd: Number(newPlan.priceUsd),
      periods: input.periods,
      periodInterval: PERIOD_INTERVALS[newPlan.billingPeriod]!,
      timezone,
      mode,
      anchorWeekly: newPlan.billingPeriod === 'weekly' && (await this.isDebtEngineOn()),
      registeredBy: adminId,
    });

    await this.audit(adminId, 'subscription.plan_changed', 'drivers', driverId, {
      fromPlanId: subscription.planId,
      toPlanId: newPlan.id,
      periods: input.periods,
      invoices: result.invoiceNumbers,
      mode,
    });
    return {
      invoiceNumbers: result.invoiceNumbers,
      reactivated: mode === 'immediate',
      planChanged: true,
      startsAt: result.startsAt.toISOString(),
    };
  }

  /** Undo a programmed plan change: refunds its periods and voids invoices. */
  async cancelScheduledChange(
    driverId: string,
    adminId: string,
  ): Promise<{ refundedPayments: number; voidedInvoices: number }> {
    await this.assertDriver(driverId);
    const result = await this.enrollment.cancelScheduledChange(driverId, adminId);
    if (!result) {
      throw this.app.httpErrors.conflict('Este afiliado no tiene un cambio de tarifa programado');
    }
    await this.audit(adminId, 'subscription.plan_change_cancelled', 'drivers', driverId, result);
    return result;
  }

  private async findPlan(
    id: number,
  ): Promise<{ id: number; priceUsd: string; active: boolean; billingPeriod: string }> {
    const { rows } = await this.app.db.query<{
      id: number;
      priceUsd: string;
      active: boolean;
      billingPeriod: string;
    }>(
      `SELECT id, price_usd AS "priceUsd", active, billing_period AS "billingPeriod"
       FROM subscription_plans WHERE id = $1`,
      [id],
    );
    const plan = rows[0];
    if (!plan) throw this.app.httpErrors.badRequest('La tarifa no existe');
    return plan;
  }

  private async getSetting(key: string, fallback: unknown): Promise<unknown> {
    const { rows } = await this.app.db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? fallback;
  }

  /** Debt engine master switch (v8): gates the Monday-anchoring of weekly periods. */
  private async isDebtEngineOn(): Promise<boolean> {
    return (await this.getSetting('debt_engine_enabled', false)) === true;
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

  /**
   * Two shapes share this PATCH: the edit modal sends the full personal data
   * set (names required); suspend/reactivate sends only `status`.
   */
  async updateProfile(
    driverId: string,
    input: Partial<CreateDriverInput> & { status?: 'approved' | 'suspended' },
    adminId: string,
  ): Promise<Record<string, unknown>> {
    await this.assertDriver(driverId);
    const hasPersonalData = input.firstName !== undefined || input.lastName !== undefined;
    if (hasPersonalData && (!input.firstName || !input.lastName)) {
      throw this.app.httpErrors.badRequest('Primer nombre y primer apellido son obligatorios');
    }

    try {
      if (hasPersonalData) {
        const person = await this.validatePersonalData(input as CreateDriverInput);
        await this.app.db.query(
          `UPDATE users SET
             first_name = $2, middle_name = $3, last_name = $4, second_last_name = $5,
             full_name = $6, birth_date = $7, address = $8, email = $9, phone = $10,
             password_hash = COALESCE($11, password_hash)
           WHERE id = $1`,
          [
            driverId,
            person.firstName,
            person.middleName,
            person.lastName,
            person.secondLastName,
            person.fullName,
            person.birthDate,
            person.address,
            person.email,
            person.phone,
            person.passwordHash, // null = keep the current app password
          ],
        );
        await this.app.db.query(
          `UPDATE drivers SET national_id = $2 WHERE user_id = $1`,
          [driverId, person.nationalId],
        );
      }
      if (input.status !== undefined) {
        // Clear the pause anchor on any status change: the PATCH only sets
        // approved/suspended (pause/resume have their own endpoints), so leaving
        // `paused` this way must not leave an orphan `paused_at` behind.
        await this.app.db.query(
          `UPDATE drivers SET status = $2, paused_at = NULL WHERE user_id = $1`,
          [driverId, input.status],
        );
      }
      await this.audit(adminId, 'driver.updated', 'drivers', driverId, {
        fields: Object.keys(input).filter((k) => k !== 'password'),
      });
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
    await writeAudit(this.app.db, { actorAdminId: adminId, eventType, entity, entityId, data });
  }
}
