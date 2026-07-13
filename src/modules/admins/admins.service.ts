import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type {
  AdminRecord,
  AdminsRepository,
  UpdateAdminData,
} from './admins.repository.js';

interface CreateAdminInput {
  username: string;
  email?: string | null;
  fullName: string;
  password: string;
  createdBy: string;
}

const UNIQUE_VIOLATION = '23505';

export class AdminsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly admins: AdminsRepository,
  ) {}

  list(): Promise<AdminRecord[]> {
    return this.admins.list();
  }

  async getById(id: string): Promise<AdminRecord> {
    const admin = await this.admins.findById(id);
    if (!admin) throw this.app.httpErrors.notFound('Administrador no encontrado');
    return admin;
  }

  async create(input: CreateAdminInput): Promise<AdminRecord> {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      const admin = await this.admins.create({
        username: input.username.trim().toLowerCase(),
        email: input.email ?? null,
        fullName: input.fullName.trim(),
        passwordHash,
        createdBy: input.createdBy,
      });
      await writeAudit(this.app.db, {
        actorAdminId: input.createdBy,
        eventType: 'admin.created',
        entity: 'admins',
        entityId: admin.id,
        data: { username: admin.username },
      });
      return admin;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('El usuario o email ya existe');
      }
      throw err;
    }
  }

  async update(id: string, data: UpdateAdminData, actorId: string): Promise<AdminRecord> {
    if (data.status === 'suspended' && id === actorId) {
      throw this.app.httpErrors.badRequest('No puedes suspender tu propia cuenta');
    }
    try {
      const admin = await this.admins.update(id, data);
      if (!admin) throw this.app.httpErrors.notFound('Administrador no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'admin.updated',
        entity: 'admins',
        entityId: id,
        data: { username: admin.username, fields: Object.keys(data) },
      });
      return admin;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('El email ya está en uso');
      }
      throw err;
    }
  }

  async updatePassword(id: string, password: string, actorId: string): Promise<void> {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const updated = await this.admins.updatePassword(id, passwordHash);
    if (!updated) throw this.app.httpErrors.notFound('Administrador no encontrado');
    // Never log the password or its hash - the event itself is the trail.
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'admin.password_changed',
      entity: 'admins',
      entityId: id,
    });
  }
}
