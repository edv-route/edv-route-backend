import { buildApp } from './app.js';

const app = await buildApp();

try {
  await app.listen({ host: app.config.HOST, port: app.config.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: close in-flight requests and the DB pool
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
