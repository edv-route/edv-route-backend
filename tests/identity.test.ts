import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { IdentityRepository } from '../src/modules/identity/identity.repository.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { summarize, workBlockReason } from '../src/modules/identity/identity.policy.js';

/**
 * Identity photos (2026-11-12): selfie + cédula front/back, owned by the
 * PERSON, reviewed by the office, final once in review or approved.
 *
 * Runs against the shared database with throwaway people (deleted at the end)
 * and an in-memory bucket. It never flips `identity_required_enabled`: that
 * switch is global and production reads it — the flag-dependent wording is
 * covered through the pure functions instead.
 */

class MemoryStorage {
  readonly objects = new Map<string, Buffer>();
  readonly removed: string[] = [];
  async upload(path: string, body: Buffer): Promise<{ path: string }> {
    this.objects.set(path, body);
    return { path };
  }
  async getSignedUrl(path: string): Promise<string> {
    return `signed://${path}`;
  }
  async getSignedUrls(paths: string[]): Promise<Map<string, string>> {
    return new Map(paths.map((p) => [p, `signed://${p}`]));
  }
  async remove(path: string): Promise<void> {
    this.objects.delete(path);
    this.removed.push(path);
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.4 not a photo');

let pool: pg.Pool;
let repo: IdentityRepository;
let service: IdentityService;
let storage: MemoryStorage;
let adminId: string;
const people: string[] = [];
const stamp = Date.now();

const httpError = (statusCode: number) => (m: string) => Object.assign(new Error(m), { statusCode });

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  storage = new MemoryStorage();
  const app = {
    db: pool,
    storage,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    httpErrors: {
      badRequest: httpError(400),
      unauthorized: httpError(401),
      forbidden: httpError(403),
      notFound: httpError(404),
      conflict: httpError(409),
      serviceUnavailable: httpError(503),
    },
  } as unknown as FastifyInstance;
  repo = new IdentityRepository(pool);
  service = new IdentityService(app, repo);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO admins (username, full_name, password_hash)
     VALUES ($1, 'TEST Revisor', 'x') RETURNING id`,
    [`test-identity-${stamp}`],
  );
  adminId = rows[0]!.id;
});

after(async () => {
  for (const id of people) {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [id]).catch(() => {});
    await pool.query(`DELETE FROM audit_logs WHERE data->>'userId' = $1`, [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch((e) => {
      console.error('limpieza users falló:', id, e.message);
    });
  }
  await pool.query('DELETE FROM audit_logs WHERE actor_admin_id = $1', [adminId]).catch(() => {});
  await pool.query('DELETE FROM admins WHERE id = $1', [adminId]).catch((e) => {
    console.error('limpieza admins falló:', adminId, e.message);
  });
  await pool.end();
});

/** A throwaway affiliate, on duty, optionally with a free-form avatar. */
async function makeDriver(tag: string, avatar: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name) VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const id = rows[0]!.id;
  people.push(id);
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, is_available, tariff_start_set_at)
     VALUES ($1, 'admin', 'approved', true, now())`,
    [id],
  );
  if (avatar) {
    const path = `${id}/profile/${avatar}.jpg`;
    await pool.query('UPDATE users SET photo_url = $2 WHERE id = $1', [id, path]);
    storage.objects.set(path, JPEG);
  }
  return id;
}

async function sendAll(userId: string): Promise<void> {
  for (const kind of ['selfie', 'id_front', 'id_back'] as const) {
    await service.upload(userId, kind, { buffer: JPEG });
  }
}

const photoOf = async (userId: string, kind: string) =>
  (await service.getForAdmin(userId)).photos.find((p) => p.kind === kind)!;

test('the summary follows what the person has to do next', () => {
  const p = (kind: 'selfie' | 'id_front' | 'id_back', status: 'pending' | 'approved' | 'rejected') => ({
    kind,
    status,
  });
  assert.equal(summarize([]), 'missing');
  assert.equal(summarize([p('selfie', 'approved'), p('id_front', 'approved')]), 'missing');
  assert.equal(summarize([p('selfie', 'approved'), p('id_front', 'rejected'), p('id_back', 'pending')]), 'rejected');
  assert.equal(summarize([p('selfie', 'approved'), p('id_front', 'pending'), p('id_back', 'approved')]), 'pending');
  assert.equal(summarize([p('selfie', 'approved'), p('id_front', 'approved'), p('id_back', 'approved')]), 'approved');

  assert.equal(workBlockReason('approved'), null);
  for (const s of ['missing', 'rejected', 'pending'] as const) {
    assert.ok(workBlockReason(s), `${s} must explain why he cannot work`);
  }
});

test('three photos move a person from missing to pending; the selfie becomes the profile photo', async () => {
  const id = await makeDriver('envia', 'viejo');
  assert.equal((await service.getOwn(id)).status, 'missing');

  await sendAll(id);
  const view = await service.getOwn(id);
  assert.equal(view.status, 'pending');
  assert.equal(view.photos.length, 3);
  assert.ok(view.photos.every((p) => p.url?.startsWith('signed://')), 'the app gets short-lived links');
  assert.ok(view.photos.every((p) => p.reviewedByName === undefined), 'the app never sees who reviewed');

  const { rows } = await pool.query<{ photoUrl: string }>(
    'SELECT photo_url AS "photoUrl" FROM users WHERE id = $1',
    [id],
  );
  assert.match(rows[0]!.photoUrl, new RegExp(`^${id}/identity/selfie-`));
  // The free-form avatar went; identity photos never do.
  assert.ok(storage.removed.includes(`${id}/profile/viejo.jpg`));
  assert.ok(!storage.removed.some((p) => p.includes('/identity/')));
  assert.equal(await service.policy.profilePhotoLocked(id), true);
});

test('only real images get in, and nothing is stored when they do not', async () => {
  const id = await makeDriver('formato');
  const before = storage.objects.size;
  await assert.rejects(service.upload(id, 'selfie', { buffer: PDF }), { statusCode: 400 });
  await assert.rejects(service.upload(id, 'selfie', { buffer: Buffer.alloc(0) }), { statusCode: 400 });
  assert.equal(storage.objects.size, before);
  assert.equal(await service.policy.profilePhotoLocked(id), false);
});

test('a photo in review or approved is final; a rejected one can be retaken', async () => {
  const id = await makeDriver('final');
  await sendAll(id);

  await assert.rejects(service.upload(id, 'id_front', { buffer: JPEG }), {
    statusCode: 409,
    message: /en revisión/,
  });

  const selfie = await photoOf(id, 'selfie');
  await service.review(selfie.id, true, null, adminId);
  await assert.rejects(service.upload(id, 'selfie', { buffer: JPEG }), {
    statusCode: 409,
    message: /verificada/,
  });

  const front = await photoOf(id, 'id_front');
  await assert.rejects(service.review(front.id, false, '   ', adminId), { statusCode: 400 });
  const afterReject = await service.review(front.id, false, 'Está borrosa', adminId);
  assert.equal(afterReject.status, 'rejected');
  assert.equal(afterReject.photos.find((p) => p.kind === 'id_front')!.reviewedByName, 'TEST Revisor');

  const { rows: notice } = await pool.query<{ body: string }>(
    `SELECT body FROM notifications WHERE user_id = $1 AND type = 'identity_photo_rejected'`,
    [id],
  );
  assert.equal(notice.length, 1);
  assert.match(notice[0]!.body, /Está borrosa/);

  // Off duty only when the rule is on; never silently while it is off.
  const required = await repo.isRequired();
  const { rows: duty } = await pool.query<{ on: boolean }>(
    'SELECT is_available AS on FROM drivers WHERE user_id = $1',
    [id],
  );
  assert.equal(duty[0]!.on, !required);

  // The retake replaces it and keeps the history.
  const retaken = await service.upload(id, 'id_front', { buffer: JPEG });
  assert.equal(retaken.status, 'pending');
  const { rows: history } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM identity_photos WHERE user_id = $1 AND kind = 'id_front'`,
    [id],
  );
  assert.equal(history[0]!.n, 2);

  // A decision on the replaced photo lands nowhere.
  await assert.rejects(service.review(front.id, true, null, adminId), { statusCode: 409 });
});

test('approving the last photo verifies the identity with ONE notice', async () => {
  const id = await makeDriver('aprobado');
  await sendAll(id);
  for (const kind of ['selfie', 'id_front', 'id_back']) {
    await service.review((await photoOf(id, kind)).id, true, null, adminId);
  }

  assert.equal((await service.getOwn(id)).status, 'approved');
  assert.equal(await service.policy.workBlockReason(id), null);

  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'identity_verified'`,
    [id],
  );
  assert.equal(rows[0]!.n, 1);

  // "Pedir otra foto": revoking an approved photo sends him back to the camera.
  const revoked = await service.review((await photoOf(id, 'selfie')).id, false, 'No se ve la cara', adminId);
  assert.equal(revoked.status, 'rejected');
  assert.equal((await service.upload(id, 'selfie', { buffer: JPEG })).status, 'pending');
});
