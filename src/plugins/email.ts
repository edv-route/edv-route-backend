import fp from 'fastify-plugin';
import { LogEmailSender, type EmailSender } from '../email/email-sender.js';
import { ResendEmailSender } from '../email/resend-email-sender.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Never null: without credentials this is the log-only sender, so the API
     * boots and serves everything else exactly the same. Mail must never be
     * what stops the server from starting - same rule as storage and push.
     */
    email: EmailSender;
    /**
     * Whether mail actually LEAVES the building. Password recovery checks this
     * and refuses up front rather than telling a driver a code is on its way
     * that only ever reached a log file.
     */
    emailConfigured: boolean;
  }
}

export default fp(
  async (app) => {
    const { RESEND_API_KEY, EMAIL_FROM } = app.config;

    if (!RESEND_API_KEY || !EMAIL_FROM) {
      app.log.warn('email not configured (RESEND_API_KEY / EMAIL_FROM): recovery codes only reach the log');
      app.decorate('email', new LogEmailSender((payload, msg) => app.log.info(payload, msg)));
      app.decorate('emailConfigured', false);
      return;
    }

    app.decorate(
      'email',
      new ResendEmailSender(RESEND_API_KEY, EMAIL_FROM, (payload, msg) => app.log.error(payload, msg)),
    );
    app.decorate('emailConfigured', true);
    app.log.info({ from: EMAIL_FROM }, 'email ready · provider: resend');
  },
  { name: 'email' },
);
