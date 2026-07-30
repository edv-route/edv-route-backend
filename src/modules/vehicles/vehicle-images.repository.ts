import type pg from 'pg';

export interface VehicleImageRow {
  id: string;
  position: number;
}

/** Vehicle photos (max 3). The binary lives in the private bucket; here only the reference. */
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
    const used = new Set(rows.map((r) => r.position));
    for (let p = 1; p <= 3; p++) if (!used.has(p)) return p;
    return null;
  }

  async insert(
    vehicleId: string,
    fileUrl: string,
    position: number,
    uploadedBy: string,
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
