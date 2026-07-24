import fp from 'fastify-plugin';
import { SupabaseStorageProvider } from '../storage/supabase-storage.provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** null when storage is not configured: uploads answer 503, the rest works. */
    storage: StorageProvider | null;
  }
}

/**
 * Wires the configured storage provider. Credentials live only here and in
 * .env - no client ever touches the bucket directly (same rule as the DB).
 */
export default fp(
  async (app) => {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORAGE_BUCKET } = app.config;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      app.log.warn('storage not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): uploads disabled');
      app.decorate('storage', null);
      return;
    }

    app.decorate(
      'storage',
      new SupabaseStorageProvider(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORAGE_BUCKET),
    );
    app.log.info({ bucket: STORAGE_BUCKET }, 'storage ready');
  },
  { name: 'storage' },
);
