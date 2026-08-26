import type { FastifyPluginAsync } from 'fastify';
import { LocationsRepository, type LocationPoint } from './locations.repository.js';
import { LocationsService } from './locations.service.js';

/**
 * Where the app reports the driver's position (proposal:
 * docs/proposals/ubicacion-afiliados). Mounted under `/driver-auth`, like the
 * notification routes.
 */

/**
 * A BATCH, never a single point. The phone keeps a local queue while it has no
 * signal, and flushing it one request per point turns a reconnection into
 * twenty round trips.
 *
 * 200 is roughly a day and a half of queue at the default ten-minute interval —
 * past that the oldest points are beyond the backdating window anyway.
 */
const MAX_POINTS = 200;

const reportSchema = {
  body: {
    type: 'object',
    required: ['points'],
    additionalProperties: false,
    properties: {
      points: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_POINTS,
        items: {
          type: 'object',
          required: ['lat', 'lon', 'recordedAt'],
          additionalProperties: false,
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lon: { type: 'number', minimum: -180, maximum: 180 },
            /** Metres of error the phone reported. Absent when it did not say. */
            accuracyM: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
            recordedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        accepted: { type: 'integer' },
        rejected: { type: 'integer' },
        // Declared on purpose: Fastify serialises against the schema, and an
        // undeclared field is dropped in silence. This one is how a change of
        // pace reaches every phone without publishing an APK.
        intervalSeconds: { type: 'integer' },
      },
    },
  },
} as const;

interface ReportBody {
  points: { lat: number; lon: number; accuracyM?: number | null; recordedAt: string }[];
}

const locationsRoutes: FastifyPluginAsync = async (app) => {
  const service = new LocationsService(app, new LocationsRepository(app.db));

  app.post<{ Body: ReportBody }>(
    '/me/locations',
    { onRequest: [app.authenticateDriver], schema: reportSchema },
    async (req) => {
      const points: LocationPoint[] = req.body.points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        accuracyM: p.accuracyM ?? null,
        recordedAt: new Date(p.recordedAt),
      }));
      // driverId comes from the TOKEN, never the body: a driver reports his own
      // position and nobody else's.
      return service.report(req.user.sub, points);
    },
  );
};

export default locationsRoutes;
