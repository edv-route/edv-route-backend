import type pg from 'pg';

export interface VehicleImageRow {
  id: string;
  position: number;
}

/**
 * Photos allowed per vehicle. Dropped from 3 to ONE on 2026-08-20 (decisión de
 * Luis, app and panel alike): the driver sends one picture with his vehicle and
 * that is what the admin compares against the papers. Vehicles photographed
 * under the old limit KEEP their photos — nothing is deleted — they just cannot
 * take another one.
 */
export const MAX_IMAGES = 1;

/** Vehicle photos (see MAX_IMAGES). The binary lives in the private bucket; here only the reference. */
export class VehicleImagesRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Verifies the vehicle exists and belongs to the driver. */
  async vehicleBelongsToDriver(vehicleId: string, driverId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = $2',
      [vehicleId, driverId],
    );
    return rows.length > 0;
  }

  async listByVehicle(vehicleId: string): Promise<VehicleImageRow[]> {
    const { rows } = await this.db.query<VehicleImageRow>(
      'SELECT id, position FROM vehicle_images WHERE vehicle_id = $1 ORDER BY position',
      [vehicleId],
    );
    return rows;
  }

  /** First free slot in 1..3, or null when the vehicle already has three. */
  async nextPosition(vehicleId: string): Promise<number | null> {
    const rows = await this.listByVehicle(vehicleId);
    // COUNT, not "first free slot": a vehicle photographed back when three were
    // allowed keeps its three (they are never deleted behind the user's back),
    // and simply cannot take another. Checking for a free slot would let one
    // deleted photo be replaced by a new one and land back at three.
    if (rows.length >= MAX_IMAGES) return null;
    const used = new Set(rows.map((r) => r.position));
    for (let p = 1; p <= MAX_IMAGES; p++) if (!used.has(p)) return p;
    return null;
  }

  async insert(
    vehicleId: string,
    fileUrl: string,
    position: number,
    uploadedBy: string | null,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO vehicle_images (vehicle_id, file_url, position, uploaded_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [vehicleId, fileUrl, position, uploadedBy],
    );
    return rows[0]!.id;
  }

  /** Ownership-scoped lookup: the image must belong to the given vehicle. */
  async findForVehicle(vehicleId: string, imageId: string): Promise<{ fileUrl: string } | null> {
    const { rows } = await this.db.query<{ fileUrl: string }>(
      'SELECT file_url AS "fileUrl" FROM vehicle_images WHERE id = $1 AND vehicle_id = $2',
      [imageId, vehicleId],
    );
    return rows[0] ?? null;
  }

  async delete(imageId: string): Promise<void> {
    await this.db.query('DELETE FROM vehicle_images WHERE id = $1', [imageId]);
  }
}
