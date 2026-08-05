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

/**
 * Payment details captured at cobro time; stamped on the primary invoice.
 * `paidOn`/`payerPhone`/`payerId` added 2026-07-31 (payer details): the phone
 * and id are Pago-Móvil-only in the UI but the type carries them for every cobro.
 */
export interface PaymentMeta {
  paymentMethodId?: number | null;
  reference?: string | null;
  payerBank?: string | null;
  paidOn?: string | null;
  payerPhone?: string | null;
  payerId?: string | null;
  /** Email or name the payment came FROM (Zelle/Binance). */
  payerAccount?: string | null;
}

export interface EnrollInput extends PaymentMeta {
  planId: number;
  periods: number;
}

export interface RegisterDocumentInput {
  requirementId: number;
  expiresAt?: string | null;
}

export interface RegisterVehicleInput extends VehicleInput {
  /** Vehicle documents created against this vehicle (files uploaded afterwards). */
  documents?: RegisterDocumentInput[];
}

/** Everything beyond the person that the transactional registration may carry. */
export interface RegisterInput {
  payment: EnrollInput | null;
  vehicles: RegisterVehicleInput[];
  documents: RegisterDocumentInput[];
  /**
   * v9 (2026-08-04): the alta is paid up front via a pending `enroll` submission
   * (membership + N weeks, one invoice on approval). When true the registration
   * leaves the driver pending WITHOUT the base alta debt — the submission covers it.
   */
  deferredEnrollment?: boolean;
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
    adminId: string | null,
    opts?: { source?: 'admin' | 'app' },
  ): Promise<Record<string, unknown>> {
    const person = await this.validatePersonalData(input);
    const { payment, vehicles, documents, deferredEnrollment } = extras;
    // Registration channel: admin panel vs self-service app. Drives the
    // traceability FKs (registered_by null for app) and the audit actor
    // (a driver/user for app, an admin for the panel).
    const source = opts?.source ?? 'admin';
    const registeredBy = source === 'app' ? null : adminId;

    // Resolve catalog prices before opening the transaction (read-only lookups;
    // amounts are snapshotted at insert time). Mirrors the checks in `enroll`.
    let money: Omit<Parameters<EnrollmentRepository['enrollOnClient']>[1], 'driverId'> | null = null;
    // Registration WITHOUT payment (option A): the alta is emitted as DEBT
    // (membership + 1 week, unpaid) whenever a membership and a weekly tariff
    // exist; otherwise the driver stays pending with nothing to owe.
    let debtAlta: Omit<Parameters<EnrollmentRepository['enrollDebtOnClient']>[1], 'driverId'> | null = null;
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
        registeredBy,
      };
    } else if (!deferredEnrollment) {
      // No payment AND not deferred: emit the base alta debt (membership + 1 week).
      // Deferred means a pending `enroll` submission will materialize the alta
      // (membership + N weeks) on approval, so nothing is owed here yet.
      const { rows: mRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
        'SELECT id, price_usd AS "priceUsd" FROM memberships WHERE active',
      );
      const membership = mRows[0];
      const { rows: pRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
        `SELECT id, price_usd AS "priceUsd" FROM subscription_plans
         WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`,
      );
      const plan = pRows[0];
      if (membership && plan) {
        // The debt plan is weekly by query; anchor to Monday when the engine is on.
        const anchorWeekly = await this.isDebtEngineOn();
        const timezone = String(await this.getSetting('business_timezone', 'America/Caracas'));
        debtAlta = {
          membershipId: membership.id,
          membershipPriceUsd: Number(membership.priceUsd),
          planId: plan.id,
          planPriceUsd: Number(plan.priceUsd),
          registeredBy,
          anchorWeekly,
          timezone,
        };
      }
    }

    // Validate document requirements up front: top-level = DRIVER documents,
    // per-vehicle = VEHICLE documents. Nothing is written until they all check.
    const vehicleDocs = vehicles.flatMap((v) => v.documents ?? []);
    if (documents.length > 0 || vehicleDocs.length > 0) {
      const { rows } = await this.app.db.query<{ id: number; appliesTo: string }>(
        `SELECT id, applies_to AS "appliesTo" FROM requirements WHERE active`,
      );
      const driverReqs = new Set(rows.filter((r) => r.appliesTo === 'driver').map((r) => r.id));
      const vehicleReqs = new Set(rows.filter((r) => r.appliesTo === 'vehicle').map((r) => r.id));
      for (const doc of documents) {
        if (!driverReqs.has(doc.requirementId)) {
          throw this.app.httpErrors.badRequest(
            'Uno de los documentos no corresponde a un requerimiento de chofer vigente',
          );
        }
      }
      for (const doc of vehicleDocs) {
        if (!vehicleReqs.has(doc.requirementId)) {
          throw this.app.httpErrors.badRequest(
            'Uno de los documentos de vehículo no corresponde a un requerimiento vigente',
          );
        }
      }
    }

    let result: {
      userId: string;
      invoiceNumbers: string[];
      documentIds: string[];
      createdVehicles: { id: string; documentIds: string[] }[];
    };
    try {
      result = await withTransaction(this.app.db, async (client) => {
        // The whole alta is transactional: no incremental step to resume (null).
        const userId = await this.drivers.insertUserAndDriver(
          client,
          { ...person, registeredBy, source },
          null,
        );
        const createdVehicles: { id: string; documentIds: string[] }[] = [];
        for (const vehicle of vehicles) {
          const vehicleId = await this.drivers.insertVehicle(client, userId, vehicle, registeredBy);
          const vDocIds: string[] = [];
          for (const doc of vehicle.documents ?? []) {
            vDocIds.push(await this.drivers.insertDocument(client, { vehicleId }, doc, registeredBy));
          }
          createdVehicles.push({ id: vehicleId, documentIds: vDocIds });
        }
        const documentIds: string[] = [];
        for (const doc of documents) {
          documentIds.push(
            await this.drivers.insertDocument(client, { driverId: userId }, doc, registeredBy),
          );
        }
        let invoiceNumbers: string[] = [];
        if (money) {
          const enrolled = await this.enrollment.enrollOnClient(client, { ...money, driverId: userId });
          invoiceNumbers = enrolled.invoiceNumbers;
        } else if (debtAlta) {
          const debt = await this.enrollment.enrollDebtOnClient(client, { ...debtAlta, driverId: userId });
          invoiceNumbers = debt.invoiceNumbers;
        }
        return { userId, invoiceNumbers, documentIds, createdVehicles };
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

    // App registrations have no admin actor: the driver himself is the actor,
    // recorded on audit_logs.actor_user_id (FK users); registered_by stays null.
    const auditUserId = source === 'app' ? result.userId : null;
    await this.audit(registeredBy, 'driver.created', 'drivers', result.userId, {
      source,
      withPayment: payment !== null,
      vehicles: vehicles.length,
      documents: documents.length,
    }, auditUserId);
    for (const vehicle of vehicles) {
      await this.audit(registeredBy, 'vehicle.registered', 'drivers', result.userId, {
        plate: vehicle.plate ?? null,
      }, auditUserId);
    }
    for (const doc of documents) {
      await this.audit(registeredBy, 'document.registered', 'drivers', result.userId, {
        requirementId: doc.requirementId,
      }, auditUserId);
    }
    let primaryInvoiceId: string | null = null;
    if (payment) {
      if (result.invoiceNumbers[0]) {
        primaryInvoiceId = await this.enrollment.setInvoicePaymentMeta(
          result.invoiceNumbers[0],
          this.normalizeMeta(payment),
        );
      }
      await this.audit(registeredBy, 'driver.enrolled', 'drivers', result.userId, {
        planId: payment.planId,
        periods: payment.periods,
        invoices: result.invoiceNumbers,
      }, auditUserId);
    }

    const detail = await this.getDetail(result.userId);
    return {
      ...detail,
      userId: result.userId,
      invoiceNumbers: result.invoiceNumbers,
      createdDocumentIds: result.documentIds,
      createdVehicles: result.createdVehicles,
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
  async addVehicle(driverId: string, input: VehicleInput, adminId: string): Promise<{ id: string }> {
    await this.assertDriver(driverId);
    try {
      const { rows } = await this.app.db.query<{ id: string }>(
        `INSERT INTO vehicles
           (driver_id, vehicle_type_id, brand, model, year, color, plate, approval_status, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8) RETURNING id`,
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
      return { id: rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un vehículo con esa placa');
      }
      throw err;
    }
  }

  /** Edits a vehicle's data (from the profile / vehicle detail). */
  async updateVehicle(
    driverId: string,
    vehicleId: string,
    input: VehicleInput,
    adminId: string,
  ): Promise<void> {
    await this.assertDriver(driverId);
    try {
      const { rowCount } = await this.app.db.query(
        `UPDATE vehicles
            SET vehicle_type_id = $3, brand = $4, model = $5, year = $6, color = $7, plate = $8,
                updated_at = now()
          WHERE id = $1 AND driver_id = $2`,
        [
          vehicleId,
          driverId,
          input.vehicleTypeId ?? null,
          input.brand ?? null,
          input.model ?? null,
          input.year ?? null,
          input.color ?? null,
          input.plate?.trim().toUpperCase() || null,
        ],
      );
      if (rowCount === 0) throw this.app.httpErrors.notFound('Vehículo no encontrado');
      await this.audit(adminId, 'vehicle.updated', 'drivers', driverId, { vehicleId });
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
    paidOn: string | null;
    payerPhone: string | null;
    payerId: string | null;
    payerAccount: string | null;
  } {
    return {
      paymentMethodId: input.paymentMethodId ?? null,
      reference: input.reference?.trim() || null,
      payerBank: input.payerBank?.trim() || null,
      paidOn: input.paidOn?.trim() || null,
      payerPhone: input.payerPhone?.trim() || null,
      payerId: input.payerId?.trim() || null,
      payerAccount: input.payerAccount?.trim() || null,
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

  /** Outstanding debt (arrears + penalty) in USD; 0 when the driver is clear. */
  private debtTotal(detail: Record<string, unknown>): number {
    const debt = detail['debt'] as { totalUsd?: string } | null;
    return debt ? Number(debt.totalUsd ?? 0) : 0;
  }

  /**
   * Shared gate for every path that moves a driver into `approved`: both wizard
   * payments settled (membership `paid` + a tariff) and zero outstanding debt.
   * Centralised so approve() and the PATCH status change cannot drift apart — a
   * driver with arrears (or with no payment at all) must never reach `approved`.
   */
  private assertApprovable(detail: Record<string, unknown>): void {
    const membershipPayment = detail['membershipPayment'] as { status: string } | null;
    const subscription = detail['subscription'] as { billingPeriod: string } | null;
    if (!membershipPayment || membershipPayment.status !== 'paid' || !subscription) {
      throw this.app.httpErrors.conflict(
        'No se puede aprobar: faltan los pagos de membresía y tarifa',
      );
    }
    if (this.debtTotal(detail) > 0) {
      throw this.app.httpErrors.conflict(
        'No se puede aprobar: el afiliado tiene deuda pendiente por saldar',
      );
    }
  }

  /** Approval requires both wizard payments (doc v7: money, not papers) and zero debt. */
  async approve(driverId: string, adminId: string): Promise<void> {
    const detail = await this.getDetail(driverId);
    if (detail['status'] !== 'pending') {
      throw this.app.httpErrors.conflict('Solo se puede aprobar un afiliado pendiente');
    }
    this.assertApprovable(detail);
    const subscription = detail['subscription'] as { billingPeriod: string };

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
  ): Promise<{ settledCharges: number; totalUsd: string }> {
    await this.assertDriver(driverId);
    // Legacy direct external payment (v8): superseded by the v9 receipt flow. With
    // the billing redesign the payment details live on the receipt, so this path
    // no longer stamps them onto an invoice; it just settles the owed charges.
    const result = await this.enrollment.registerExternalPayment({
      driverId,
      registeredBy: adminId,
    });
    if (!result) {
      throw this.app.httpErrors.conflict('El afiliado no tiene cargos pendientes por saldar');
    }
    await this.audit(adminId, 'driver.external_payment', 'drivers', driverId, {
      ...result,
      note: input.note ?? null,
    });
    return result;
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
    if (this.debtTotal(detail) > 0) {
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
    input: { periods: number; planId?: number; note?: string | null } & PaymentMeta,
    adminId: string,
  ): Promise<{
    invoiceNumbers: string[];
    reactivated: boolean;
    planChanged: boolean;
    startsAt?: string;
    primaryInvoiceId: string | null;
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
      // Stamp the payment details on the renewal's primary invoice (Pieza 2).
      const primaryInvoiceId = result.invoiceNumbers[0]
        ? await this.enrollment.setInvoicePaymentMeta(result.invoiceNumbers[0], this.normalizeMeta(input))
        : null;
      await this.audit(adminId, 'subscription.renewed', 'drivers', driverId, {
        periods: input.periods,
        invoices: result.invoiceNumbers,
        reactivated: reactivate,
        note: input.note ?? null,
      });
      return { ...result, reactivated: reactivate, planChanged: false, primaryInvoiceId };
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

    const primaryInvoiceId = result.invoiceNumbers[0]
      ? await this.enrollment.setInvoicePaymentMeta(result.invoiceNumbers[0], this.normalizeMeta(input))
      : null;
    await this.audit(adminId, 'subscription.plan_changed', 'drivers', driverId, {
      fromPlanId: subscription.planId,
      toPlanId: newPlan.id,
      periods: input.periods,
      invoices: result.invoiceNumbers,
      mode,
      note: input.note ?? null,
    });
    return {
      invoiceNumbers: result.invoiceNumbers,
      reactivated: mode === 'immediate',
      planChanged: true,
      startsAt: result.startsAt.toISOString(),
      primaryInvoiceId,
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
        // Forcing "approved" via PATCH (e.g. lifting a suspension) must honour the
        // same gate as approve(): membership + tariff paid and zero debt. Without
        // this the endpoint would bypass every approval rule (approve with arrears,
        // or with no payment at all).
        if (input.status === 'approved') {
          this.assertApprovable(await this.getDetail(driverId));
        }
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
    adminId: string | null,
    eventType: string,
    entity: string,
    entityId: string,
    data: unknown,
    actorUserId: string | null = null,
  ): Promise<void> {
    await writeAudit(this.app.db, { actorAdminId: adminId, actorUserId, eventType, entity, entityId, data });
  }
}
