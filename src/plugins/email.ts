import fp from 'fastify-plugin';
import { LogEmailSender, type EmailSender } from '../email/email-sender.js';
import { ResendEmailSender } from '../email/resend-email-sender.js';
import { SmtpEmailSender } from '../email/smtp-email-sender.js';

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

/**
 * Picks the mail provider, in order of preference:
 *
 *   1. Resend  - the destination once EDV Route owns a domain
 *   2. SMTP    - Gmail today, because no domain exists yet and no ESP will send
 *                to arbitrary recipients from an unverified one
 *   3. log     - nothing configured: the code is written to the log instead
 *
 * Resend wins when both are set, so migrating is adding two variables rather
 * than remembering to remove two others.
 */
export default fp(
  async (app) => {
    const { RESEND_API_KEY, EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } =
      app.config;

    if (RESEND_API_KEY && EMAIL_FROM) {
      app.decorate(
        'email',
        new ResendEmailSender(RESEND_API_KEY, EMAIL_FROM, (payload, msg) =>
          app.log.error(payload, msg),
        ),
      );
      app.decorate('emailConfigured', true);
      app.log.info({ from: EMAIL_FROM }, 'email ready · provider: resend');
      return;
    }

    if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
      // Gmail rewrites the From to the authenticated account, so a mismatched
      // EMAIL_FROM would silently ship under a different address than the one
      // configured. Falling back to the account itself keeps them the same.
      const from = EMAIL_FROM || SMTP_USER;
      app.decorate(
        'email',
        new SmtpEmailSender(
          { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, password: SMTP_PASSWORD },
          from,
          (payload, msg) => app.log.error(payload, msg),
        ),
      );
      app.decorate('emailConfigured', true);
      app.log.info({ host: SMTP_HOST, port: SMTP_PORT, from }, 'email ready · provider: smtp');
      return;
    }

    app.log.warn('email not configured (RESEND_* or SMTP_*): recovery codes only reach the log');
    app.decorate('email', new LogEmailSender((payload, msg) => app.log.info(payload, msg)));
    app.decorate('emailConfigured', false);
  },
  { name: 'email' },
);
