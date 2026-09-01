import type { FastifyInstance } from 'fastify';
import { signAvatars } from '../../storage/avatar-signing.js';
import type { ClientsRepository, ClientDetail, ClientListResult } from './clients.repository.js';

/** Thin on purpose: the panel lists and reads the detail card. Suspension
 *  lands here when Luis asks for it. */
export class ClientsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly clients: ClientsRepository,
  ) {}

  async list(opts: {
    status?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<ClientListResult> {
    const result = await this.clients.list(opts);
    result.items = await signAvatars(this.app.storage, result.items);
    return result;
  }

  async getDetail(userId: string): Promise<ClientDetail> {
    const detail = await this.clients.findDetail(userId);
    if (!detail) throw this.app.httpErrors.notFound('Cliente no encontrado');
    const [signed] = await signAvatars(this.app.storage, [detail]);
    return signed!;
  }
}
