import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../../db/tx.js';
import { notify } from '../notifications/notification-writer.js';
import { writeAudit } from '../audit-logs/audit-writer.js';
import {
  extensionFor,
  isAllowedMimeType,
  MAX_FILE_BYTES,
  sniffMimeType,
  type AllowedMimeType,
  type StorageProvider,
} from '../../storage/storage-provider.js';
import type { EnrollmentRepository } from './enrollment.repository.js';
import type { DriversService, DocumentInput, VehicleInput } from './drivers.service.js';

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

/** One uploaded part of a vehicle submission. */
export interface SubmittedFile {
  buffer: Buffer;
  mimeType: string;
}

/** A validated document, already uploaded, waiting for its row. */
interface PreparedDocument {
  id: string;
  requirementId: number;
  file: SubmittedFile;
  mimeType: AllowedMimeType;
  path: string;
}

/** A whole vehicle as the app sends it: data + one photo + one file per requirement. */
export interface VehicleSubmission {
  vehicle: VehicleInput;
  photo: SubmittedFile;
  /** Keyed by requirement id — every ACTIVE vehicle requirement must be present. */
  documents: Map<number, SubmittedFile>;
}

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
   * App channel: sends a COMPLETE vehicle for review in ONE transaction — data,
   * its photo and one file per active vehicle requirement (2026-08-20).
   *
   * Until now the app built the vehicle on the server piece by piece (create it,
   * upload a photo, create a document, attach its file...): eight round trips
   * where any failure left half a vehicle behind and put an incomplete record in
   * the admin's review queue. The app now keeps a LOCAL draft, editable until the
   * driver decides, and the server only ever sees whole vehicles.
   *
   * Everything is validated BEFORE anything is written, files land in the bucket
   * first (an orphan object is harmless; a half-inserted vehicle is not), and the
   * rows go in together. Born `pending`: what comes from the app is reviewed by
   * an admin, unlike a vehicle the admin registers himself, which is born
   * approved (decisión de Luis).
   */
  async submitVehicleForReview(
    driverId: string,
    input: VehicleSubmission,
  ): Promise<{ id: string; documents: number }> {
    await this.drivers.assertDriverExists(driverId);
    const vehicleId = randomUUID();
    const { photoPath, docs, uploaded } = await this.prepareVehicleFiles(
      driverId,
      vehicleId,
      input,
    );
    try {
      await withTransaction(this.app.db, async (client) => {
        await client.query(
          `INSERT INTO vehicles
             (id, driver_id, vehicle_type_id, brand, model, year, color, plate,
              approval_status, registered_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL)`,
          [
            vehicleId,
            driverId,
            input.vehicle.vehicleTypeId ?? null,
            input.vehicle.brand ?? null,
            input.vehicle.model ?? null,
            input.vehicle.year ?? null,
            input.vehicle.color ?? null,
            input.vehicle.plate?.trim().toUpperCase() || null,
          ],
        );
        await client.query(
          `INSERT INTO vehicle_images (vehicle_id, file_url, position, uploaded_by)
           VALUES ($1, $2, 1, NULL)`,
          [vehicleId, photoPath],
        );
        for (const doc of docs) {
          await client.query(
            `INSERT INTO documents
               (id, requirement_id, driver_id, vehicle_id, file_url, approval_status, uploaded_by)
             VALUES ($1, $2, NULL, $3, $4, 'pending', NULL)`,
            [doc.id, doc.requirementId, vehicleId, doc.path],
          );
        }
      });
    } catch (err) {
      throw await this.discardUploads(uploaded, err);
    }

    await this.audit(
      null,
      'vehicle.submitted_for_review',
      'vehicles',
      vehicleId,
      { driverId, plate: input.vehicle.plate ?? null, documents: docs.length },
      driverId,
    );
    return { id: vehicleId, documents: docs.length };
  }

  /**
   * Sends a REJECTED vehicle back for review with everything corrected.
   *
   * A rejection is usually a mistyped plate or an unreadable photo (decisión de
   * Luis): making him load the vehicle again from zero, with its three papers,
   * punishes him for one field. So a rejected vehicle becomes editable as a
   * whole, and this replaces data, photo and papers in one transaction and puts
   * it back to `pending`. Only a REJECTED one — anything else is the very lock
   * this flow exists to enforce.
   */
  async resubmitVehicle(
    driverId: string,
    vehicleId: string,
    input: VehicleSubmission,
  ): Promise<{ id: string; documents: number }> {
    await this.drivers.assertDriverExists(driverId);
    const { rows: current } = await this.app.db.query<{ approvalStatus: string }>(
      `SELECT approval_status AS "approvalStatus" FROM vehicles
        WHERE id = $1 AND driver_id = $2`,
      [vehicleId, driverId],
    );
    // 404, never 403: it must not reveal another driver's vehicle.
    if (!current[0]) throw this.app.httpErrors.notFound('Vehículo no encontrado');
    if (current[0].approvalStatus !== 'rejected') {
      throw this.app.httpErrors.conflict(
        current[0].approvalStatus === 'approved'
          ? 'Este vehículo ya fue aprobado; no puedes reemplazarlo'
          : 'Este vehículo está en revisión: espera el veredicto',
      );
    }

    const { photoPath, docs, uploaded } = await this.prepareVehicleFiles(
      driverId,
      vehicleId,
      input,
    );
    // Replaced files, gathered inside the transaction and dropped only after it
    // commits: deleting them earlier would leave the driver with nothing to show
    // if the write failed.
    const replaced: string[] = [];
    try {
      await withTransaction(this.app.db, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE vehicles
              SET vehicle_type_id = $3, brand = $4, model = $5, year = $6, color = $7,
                  plate = $8, approval_status = 'pending', rejection_reason = NULL,
                  updated_at = now()
            WHERE id = $1 AND driver_id = $2 AND approval_status = 'rejected'`,
          [
            vehicleId,
            driverId,
            input.vehicle.vehicleTypeId ?? null,
            input.vehicle.brand ?? null,
            input.vehicle.model ?? null,
            input.vehicle.year ?? null,
            input.vehicle.color ?? null,
            input.vehicle.plate?.trim().toUpperCase() || null,
          ],
        );
        // Someone reviewed it between the check and the write.
        if (!rowCount) throw this.app.httpErrors.conflict('El vehículo ya no está rechazado');

        const { rows: oldImages } = await client.query<{ fileUrl: string }>(
          `DELETE FROM vehicle_images WHERE vehicle_id = $1 RETURNING file_url AS "fileUrl"`,
          [vehicleId],
        );
        replaced.push(...oldImages.map((i) => i.fileUrl));
        await client.query(
          `INSERT INTO vehicle_images (vehicle_id, file_url, position, uploaded_by)
           VALUES ($1, $2, 1, NULL)`,
          [vehicleId, photoPath],
        );

        // Read the superseded paths BEFORE overwriting them: inside RETURNING the
        // column already holds the new value, so they have to be taken first or
        // the old objects stay in the bucket forever.
        const { rows: oldDocs } = await client.query<{ fileUrl: string }>(
          `SELECT file_url AS "fileUrl" FROM documents
            WHERE vehicle_id = $1 AND file_url IS NOT NULL`,
          [vehicleId],
        );
        replaced.push(...oldDocs.map((d) => d.fileUrl));

        for (const doc of docs) {
          // Reuse the existing row per requirement so its history stays put; a
          // requirement added since the rejection simply gets a new one.
          const { rows: prev } = await client.query<{ id: string }>(
            `UPDATE documents
                SET file_url = $3, approval_status = 'pending', rejection_reason = NULL,
                    reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
              WHERE vehicle_id = $1 AND requirement_id = $2
              RETURNING id`,
            [vehicleId, doc.requirementId, doc.path],
          );
          if (prev.length === 0) {
            await client.query(
              `INSERT INTO documents
                 (id, requirement_id, driver_id, vehicle_id, file_url, approval_status, uploaded_by)
               VALUES ($1, $2, NULL, $3, $4, 'pending', NULL)`,
              [doc.id, doc.requirementId, vehicleId, doc.path],
            );
          }
        }
      });
    } catch (err) {
      throw await this.discardUploads(uploaded, err);
    }

    // The write is safe now, so the superseded files can go.
    await this.discardUploads(replaced.filter((p) => p !== photoPath));
    await this.audit(
      null,
      'vehicle.resubmitted_for_review',
      'vehicles',
      vehicleId,
      { driverId, plate: input.vehicle.plate ?? null, documents: docs.length },
      driverId,
    );
    return { id: vehicleId, documents: docs.length };
  }

  /**
   * Validates a whole submission and puts its files in the bucket, returning the
   * final paths. Nothing is written to the database here: an orphan object is
   * harmless and gets cleaned up, half a vehicle is not.
   */
  private async prepareVehicleFiles(
    driverId: string,
    vehicleId: string,
    input: VehicleSubmission,
  ): Promise<{ photoPath: string; docs: PreparedDocument[]; uploaded: string[] }> {
    const storage = this.requireStorage();

    // Every ACTIVE vehicle requirement must come with its file: an incomplete
    // vehicle is exactly what this flow exists to stop. Read from the table, so
    // a requirement added tomorrow is demanded without touching this code.
    const { rows: requirements } = await this.app.db.query<{ id: number; name: string }>(
      `SELECT id, name FROM requirements
        WHERE active AND applies_to = 'vehicle' ORDER BY id`,
    );
    const missing = requirements.filter((r) => !input.documents.has(r.id));
    if (missing.length > 0) {
      throw this.app.httpErrors.badRequest(
        `Faltan documentos del vehículo: ${missing.map((r) => r.name).join(', ')}`,
      );
    }
    const unknown = [...input.documents.keys()].filter(
      (id) => !requirements.some((r) => r.id === id),
    );
    if (unknown.length > 0) {
      throw this.app.httpErrors.badRequest('Un documento no corresponde a este vehículo');
    }

    // The photo is REQUIRED (decisión de Luis): the admin must have something to
    // compare against the papers. A PDF is a document, not a photo.
    const photoType = this.assertFile(input.photo, 'La foto del vehículo');
    if (photoType === 'application/pdf') {
      throw this.app.httpErrors.badRequest('La foto del vehículo debe ser JPG o PNG');
    }
    const docTypes = new Map<number, AllowedMimeType>();
    for (const [requirementId, file] of input.documents) {
      const name = requirements.find((r) => r.id === requirementId)?.name ?? 'El documento';
      docTypes.set(requirementId, this.assertFile(file, name));
    }

    // Keys are final before anything is written; the paths keep the shape the
    // other flows already use.
    const photoPath = `${driverId}/vehicles/${vehicleId}/${randomUUID()}.${extensionFor(photoType)}`;
    const docs: PreparedDocument[] = [...input.documents].map(([requirementId, file]) => {
      const id = randomUUID();
      const mimeType = docTypes.get(requirementId)!;
      return { id, requirementId, file, mimeType, path: `${driverId}/${id}.${extensionFor(mimeType)}` };
    });

    const uploaded: string[] = [];
    try {
      await storage.upload(photoPath, input.photo.buffer, photoType);
      uploaded.push(photoPath);
      for (const doc of docs) {
        await storage.upload(doc.path, doc.file.buffer, doc.mimeType);
        uploaded.push(doc.path);
      }
    } catch (err) {
      throw await this.discardUploads(uploaded, err);
    }
    return { photoPath, docs, uploaded };
  }

  /**
   * Drops stored objects best-effort. With [err] it also maps the database's
   * complaint to the right HTTP error and returns it to be thrown.
   */
  private async discardUploads(paths: string[], err?: unknown): Promise<unknown> {
    const storage = this.app.storage;
    if (storage) {
      await Promise.all(
        paths.map((path) =>
          storage.remove(path).catch((e: unknown) => {
            this.app.log.warn({ err: e, path }, 'failed to clean up a superseded upload');
          }),
        ),
      );
    }
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      return this.app.httpErrors.conflict('Ya existe un vehículo con esa placa');
    }
    if ((err as { code?: string })?.code === FK_VIOLATION) {
      return this.app.httpErrors.badRequest('Tipo de vehículo no válido');
    }
    return err;
  }

  /** Shared file gate: not empty, within the size cap, and a real PDF/JPG/PNG. */
  private assertFile(file: SubmittedFile, label: string): AllowedMimeType {
    if (file.buffer.length === 0) throw this.app.httpErrors.badRequest(`${label} está vacío`);
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw this.app.httpErrors.badRequest(`${label} supera el máximo de 10 MB`);
    }
    // By CONTENT, never by the declared type: a .jpg holding something else is
    // the oldest upload trick there is.
    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || !isAllowedMimeType(sniffed)) {
      throw this.app.httpErrors.badRequest(`${label}: formato no admitido (solo PDF, JPG o PNG)`);
    }
    return sniffed;
  }

  private requireStorage(): StorageProvider {
    if (!this.app.storage) {
      throw this.app.httpErrors.serviceUnavailable(
        'El almacenamiento de archivos no está configurado en este entorno',
      );
    }
    return this.app.storage;
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
        // In the same transaction as the approval and its alta debt: if the
        // enrolment fails, the applicant is not told he was approved.
        await notify(client, driverId, { type: 'application_approved' });
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
    await withTransaction(this.app.db, async (client) => {
      await client.query(`UPDATE drivers SET status = 'rejected' WHERE user_id = $1`, [driverId]);
      await notify(client, driverId, { type: 'application_rejected' });
    });
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
   * Re-issues the ALTA DEBT of an affiliate who lost it (2026-08-19).
   *
   * Reversing an alta receipt voids the invoices it had GENERATED and refunds
   * their charges, so the driver falls back to `pending` owing NOTHING. That is
   * right when the payment should never have been registered, and wrong when the
   * payment BOUNCED: there the driver still owes, and until now the business had
   * no way to claim it — no live invoice, and the app never even shows him a
   * payment screen while he is `pending`. This puts the debt back so he can pay
   * it himself, and it is the same debt a panel registration without payment
   * emits (one invoice per concept: membership + first week, no dates yet).
   *
   * Deliberately NOT automatic on reversal: only the admin knows whether the
   * money bounced or the receipt was a mistake.
   */
  async regenerateAltaDebt(driverId: string, adminId: string): Promise<Record<string, unknown>> {
    const detail = await this.drivers.getDetail(driverId);
    const status = detail['status'];
    if (status !== 'pending' && status !== 'approved') {
      throw this.app.httpErrors.conflict(
        'Solo se le puede volver a emitir el alta a un afiliado pendiente o aprobado',
      );
    }
    // A live membership row (anything but `refunded`) means he either owes the
    // alta already or paid it — re-issuing would double-charge him. The partial
    // unique index says the same thing at the database level.
    const { rows: live } = await this.app.db.query<{ status: string }>(
      `SELECT status FROM membership_payments
        WHERE driver_id = $1 AND status <> 'refunded' LIMIT 1`,
      [driverId],
    );
    if (live[0]) {
      throw this.app.httpErrors.conflict(
        live[0].status === 'paid'
          ? 'Este afiliado ya pagó su membresía'
          : 'Este afiliado ya tiene la deuda del alta emitida',
      );
    }

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

    const { invoiceNumbers } = await withTransaction(this.app.db, async (client) =>
      this.enrollment.enrollDebtOnClient(client, {
        driverId,
        membershipId: membership.id,
        membershipPriceUsd: Number(membership.priceUsd),
        planId: plan.id,
        planPriceUsd: Number(plan.priceUsd),
        registeredBy: adminId,
      }),
    );
    await this.audit(adminId, 'driver.alta_debt_regenerated', 'drivers', driverId, {
      invoiceNumbers,
      totalUsd: (Number(membership.priceUsd) + Number(plan.priceUsd)).toFixed(2),
    });
    return this.drivers.getDetail(driverId);
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
