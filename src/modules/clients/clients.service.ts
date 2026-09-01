import type { FastifyInstance } from 'fastify';
import { signAvatars } from '../../storage/avatar-signing.js';
import type { ClientsRepository, ClientListResult } from './clients.repository.js';

/** Thin on purpose: today the panel only lists. Suspension and the detail
 *  card land here when Luis asks for them. */
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
}
