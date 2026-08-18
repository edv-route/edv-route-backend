import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../../db/tx.js';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type { EnrollmentRepository } from './enrollment.repository.js';
import type { DriversService, DocumentInput, VehicleInput } from './drivers.service.js';

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

/**
 * The SOLICITUD channel (proposal: solicitudes-app): everything about a driver
 * who applied from the app and is not an affiliate yet — what he adds to his own
 * application, and the admin's verdict over it.
 *
 * It lives apart from `DriversService` because it is a different life stage with
 * different rules: an applicant has no money, no tariff and no vehicle of record,
 * and approving him is NOT the same gate as approving an affiliate's alta.
 * Keeping both in one class was most of the reason that file grew past its limit.
 */
export class ApplicationsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly enrollment: EnrollmentRepository,
    /** Read side (detail) and the shared driver guard live in the main service. */
    private readonly drivers: DriversService,
  ) {}

  /**
   * App channel (solicitudes-app): the applicant adds a vehicle to his OWN
   * solicitud (driverId from the token). Born `pending` (the admin reviews it);
   * no admin actor. Files/images are uploaded afterwards.
   */
  async addApplicantVehicle(driverId: string, input: VehicleInput): Promise<{ id: string }> {
    await this.drivers.assertDriverExists(driverId);
    try {
      const { rows } = await this.app.db.query<{ id: string }>(
        `INSERT INTO vehicles
           (driver_id, vehicle_type_id, brand, model, year, color, plate, approval_status, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL) RETURNING id`,
        [
          driverId,
          input.vehicleTypeId ?? null,
          input.brand ?? null,
          input.model ?? null,
          input.year ?? null,
          input.color ?? null,
          input.plate?.trim().toUpperCase() || null,
        ],
      );
      await this.audit(null, 'vehicle.registered', 'drivers', driverId, { plate: input.plate ?? null }, driverId);
      return { id: rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Ya existe un vehículo con esa placa');
      }
      throw err;
    }
  }

  /**
   * App channel (solicitudes-app): the applicant adds a document to his OWN
   * solicitud (driverId from the token). Born `pending`; vehicle documents must
   * reference a vehicle that belongs to him. The file is uploaded afterwards.
   */
  async addApplicantDocument(driverId: string, input: DocumentInput): Promise<{ id: string }> {
    await this.drivers.assertDriverExists(driverId);
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
    if (isVehicleDoc) {
      const { rowCount } = await this.app.db.query(
        'SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = $2',
        [input.vehicleId, driverId],
      );
      if (!rowCount) throw this.app.httpErrors.notFound('Vehículo no encontrado');
    }
    const { rows: created } = await this.app.db.query<{ id: string }>(
      `INSERT INTO documents
         (requirement_id, driver_id, vehicle_id, file_url, expires_at, approval_status, uploaded_by)
       VALUES ($1, $2, $3, NULL, $4, 'pending', NULL) RETURNING id`,
      [
        input.requirementId,
        isVehicleDoc ? null : driverId,
        isVehicleDoc ? input.vehicleId : null,
        input.expiresAt ?? null,
      ],
    );
    await this.audit(null, 'document.registered', 'drivers', driverId, { requirementId: input.requirementId }, driverId);
    return { id: created[0]!.id };
  }


  /**
   * Approves a SOLICITUD from the app (proposal: solicitudes-app): the applicant
   * becomes an affiliate at once — `applicant` → `approved` WITH his base debt
   * (membership + 1 week). Unlike the panel this does NOT require zero debt (D6):
   * the debt is settled later by the payment. Requires every document and vehicle
   * approved and at least one vehicle. Tariff start stays decoupled (startTariff),
   * so the debt engine leaves him frozen (tariff_start_set_at null) until then.
   */
  async approveApplication(driverId: string, adminId: string): Promise<Record<string, unknown>> {
    const detail = await this.drivers.getDetail(driverId);
    if (detail['status'] !== 'applicant') {
      throw this.app.httpErrors.conflict('Solo se puede aprobar una solicitud en revisión');
    }
    await this.assertApplicationComplete(driverId);

    const { rows: mRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
      'SELECT id, price_usd AS "priceUsd" FROM memberships WHERE active',
    );
    const membership = mRows[0];
    const { rows: pRows } = await this.app.db.query<{ id: number; priceUsd: string }>(
      `SELECT id, price_usd AS "priceUsd" FROM subscription_plans
        WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`,
    );
    const plan = pRows[0];
    if (!membership || !plan) {
      throw this.app.httpErrors.conflict(
        'No hay membresía o tarifa semanal vigente para emitir la deuda del alta',
      );
    }
    try {
      await withTransaction(this.app.db, async (client) => {
        // Guard the transition INSIDE the tx (the status read above is outside it):
        // a concurrent approve/reject can only win once. rowCount 0 = no longer an
        // applicant (double-click, or a rejection landed first) → conflict, not a
        // second approval that would revert the reject.
        const { rowCount } = await client.query(
          `UPDATE drivers SET status = 'approved' WHERE user_id = $1 AND status = 'applicant'`,
          [driverId],
        );
        if (!rowCount) {
          throw this.app.httpErrors.conflict('La solicitud ya no está en revisión');
        }
        await this.enrollment.enrollDebtOnClient(client, {
          driverId,
          membershipId: membership.id,
          membershipPriceUsd: Number(membership.priceUsd),
          planId: plan.id,
          planPriceUsd: Number(plan.priceUsd),
          registeredBy: adminId,
        });
      });
    } catch (err) {
      // The base-debt unique indexes (membership/subscription) turn a race that
      // slipped past the status guard into a clean 409 instead of a raw 500.
      if ((err as { code?: string }).code === '23505') {
        throw this.app.httpErrors.conflict('La solicitud ya fue aprobada');
      }
      throw err;
    }

    await this.audit(adminId, 'application.approved', 'drivers', driverId, {});
    return this.drivers.getDetail(driverId);
  }

  /**
   * Rejects a SOLICITUD (app): applicant → rejected. Policy 2026-08-13: a rejected
   * solicitud is kept on file (not purged) and its cédula stays blocked from
   * self-service re-registration; the applicant must contact an admin, who may
   * reopen it with `reopenApplication`.
   */
  async rejectApplication(driverId: string, adminId: string): Promise<void> {
    const detail = await this.drivers.getDetail(driverId);
    if (detail['status'] !== 'applicant') {
      throw this.app.httpErrors.conflict('Solo se puede rechazar una solicitud en revisión');
    }
    await this.app.db.query(`UPDATE drivers SET status = 'rejected' WHERE user_id = $1`, [driverId]);
    await this.audit(adminId, 'application.rejected', 'drivers', driverId, {});
  }

  /**
   * Reopens a REJECTED solicitud back to `applicant` so the admin can review it
   * again (policy 2026-08-13). Its documents/vehicles are kept (they were never
   * purged), so the review resumes where it left off. Atomic status guard.
   */
  async reopenApplication(driverId: string, adminId: string): Promise<void> {
    const { rowCount } = await this.app.db.query(
      `UPDATE drivers SET status = 'applicant' WHERE user_id = $1 AND status = 'rejected'`,
      [driverId],
    );
    if (!rowCount) {
      throw this.app.httpErrors.conflict('Solo se puede reabrir una solicitud rechazada');
    }
    await this.audit(adminId, 'application.reopened', 'drivers', driverId, {});
  }

  /**
   * Completeness gate for approving a solicitud: at least one vehicle, every
   * vehicle approved, no document left pending/rejected, and every required
   * requirement (driver + per-vehicle) satisfied by an APPROVED document.
   */
  private async assertApplicationComplete(driverId: string): Promise<void> {
    const { httpErrors } = this.app;

    const { rows: vRows } = await this.app.db.query<{ total: string; approved: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE approval_status = 'approved') AS approved
         FROM vehicles WHERE driver_id = $1`,
      [driverId],
    );
    if (Number(vRows[0]!.total) === 0) {
      throw httpErrors.conflict('La solicitud no tiene vehículos registrados');
    }
    if (Number(vRows[0]!.approved) < Number(vRows[0]!.total)) {
      throw httpErrors.conflict('Faltan vehículos por aprobar');
    }

    const { rows: dRows } = await this.app.db.query<{ notApproved: string }>(
      `SELECT count(*) AS "notApproved"
         FROM documents doc
         LEFT JOIN vehicles v ON v.id = doc.vehicle_id
        WHERE (doc.driver_id = $1 OR v.driver_id = $1)
          AND doc.approval_status <> 'approved'`,
      [driverId],
    );
    if (Number(dRows[0]!.notApproved) > 0) {
      throw httpErrors.conflict('Faltan documentos por aprobar');
    }

    const { rows: missDriver } = await this.app.db.query<{ name: string }>(
      `SELECT r.name FROM requirements r
        WHERE r.applies_to = 'driver' AND r.is_required AND r.active
          AND NOT EXISTS (
            SELECT 1 FROM documents doc
             WHERE doc.driver_id = $1 AND doc.requirement_id = r.id
               AND doc.approval_status = 'approved')
        LIMIT 1`,
      [driverId],
    );
    if (missDriver[0]) {
      throw httpErrors.conflict(`Falta el documento obligatorio aprobado: ${missDriver[0].name}`);
    }

    const { rows: missVehicle } = await this.app.db.query<{ name: string }>(
      `SELECT r.name FROM vehicles v
         CROSS JOIN requirements r
        WHERE v.driver_id = $1 AND r.applies_to = 'vehicle' AND r.is_required AND r.active
          AND NOT EXISTS (
            SELECT 1 FROM documents doc
             WHERE doc.vehicle_id = v.id AND doc.requirement_id = r.id
               AND doc.approval_status = 'approved')
        LIMIT 1`,
      [driverId],
    );
    if (missVehicle[0]) {
      throw httpErrors.conflict(
        `Falta un documento obligatorio de vehículo aprobado: ${missVehicle[0].name}`,
      );
    }
  }

  /** Audit entry for an admin action over a solicitud. */
  private async audit(
    adminId: string | null,
    eventType: string,
    entity: string,
    entityId: string,
    data: Record<string, unknown>,
    actorUserId: string | null = null,
  ): Promise<void> {
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      actorUserId,
      eventType,
      entity,
      entityId,
      data,
    });
  }
}
