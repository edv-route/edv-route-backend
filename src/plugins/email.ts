import fp from 'fastify-plugin';
import { LogEmailSender, type EmailSender } from '../email/email-sender.js';
import { GmailApiEmailSender } from '../email/gmail-api-email-sender.js';
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
 *   1. Resend    - the destination once EDV Route owns a domain
 *   2. Gmail API - what production uses today: HTTPS, which Railway does not
 *                  block, and the mail still leaves Google signed by Google
 *   3. SMTP      - Gmail again, but only usable LOCALLY (Railway blocks
 *                  outbound 25/465/587 below the Pro plan)
 *   4. log       - nothing configured: the code is written to the log instead
 *
 * Resend wins whenever it is configured, so migrating the day a domain exists
 * is adding two variables rather than remembering to remove three others.
 */
export default fp(
  async (app) => {
    const {
      RESEND_API_KEY,
      EMAIL_FROM,
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REFRESH_TOKEN,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASSWORD,
    } = app.config;

    const ready = (sender: EmailSender, detail: object, provider: string) => {
      app.decorate('email', sender);
      app.decorate('emailConfigured', true);
      app.log.info(detail, `email ready · provider: ${provider}`);
    };

    if (RESEND_API_KEY && EMAIL_FROM) {
      return ready(
        new ResendEmailSender(RESEND_API_KEY, EMAIL_FROM, (p, m) => app.log.error(p, m)),
        { from: EMAIL_FROM },
        'resend',
      );
    }

    const gmail = {
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_REFRESH_TOKEN,
    };
    if (GmailApiEmailSender.isConfigured(gmail)) {
      // Gmail rewrites the From to the authorised account, so a mismatched
      // EMAIL_FROM would silently ship under a different address. Unset, the
      // header is omitted and Gmail fills it in itself.
      const from = EMAIL_FROM || null;
      return ready(
        new GmailApiEmailSender(gmail, from, (p, m) => app.log.error(p, m)),
        { from },
        'gmail-api',
      );
    }

    if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
      const from = EMAIL_FROM || SMTP_USER;
      return ready(
        new SmtpEmailSender(
          { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, password: SMTP_PASSWORD },
          from,
          (p, m) => app.log.error(p, m),
        ),
        { host: SMTP_HOST, port: SMTP_PORT, from },
        'smtp',
      );
    }

    app.log.warn('email not configured (RESEND_*, GMAIL_* or SMTP_*): codes only reach the log');
    app.decorate('email', new LogEmailSender((p, m) => app.log.info(p, m)));
    app.decorate('emailConfigured', false);
  },
  { name: 'email' },
);
