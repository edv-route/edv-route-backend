import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './email-sender.js';

/**
 * Plain SMTP, used today against Gmail because EDV Route has no domain of its
 * own yet and Resend (like every ESP) refuses to send to arbitrary recipients
 * from an unverified one.
 *
 * Why Gmail and not a "no domain needed" ESP: sending through Gmail's own SMTP
 * means the mail REALLY leaves Google's servers, signed by Google, so it
 * authenticates properly and lands in the inbox. An ESP relaying "on behalf of"
 * a @gmail.com address fails DKIM alignment and gets filed as spam — and a
 * recovery code in the spam folder is a recovery code that was never sent.
 *
 * This is the one place the project takes a protocol library instead of calling
 * an API by hand. Resend, FCM and Supabase Storage are one authenticated POST
 * each, so their SDKs bought nothing; SMTP is a TLS handshake, an auth exchange
 * and a command dialogue. Writing that by hand would be the mistake.
 *
 * Swapping to Resend once the domain exists costs two environment variables:
 * both senders sit behind `EmailSender`, and the plugin picks whichever is
 * configured.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(
    config: { host: string; port: number; user: string; password: string },
    private readonly from: string,
    private readonly log: (payload: unknown, msg: string) => void,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS. Deriving it from the
      // port keeps one less variable to get wrong in Railway.
      secure: config.port === 465,
      auth: { user: config.user, pass: config.password },
      // The recovery screen is waiting on this call: better a clear failure the
      // driver can retry than a request that hangs until the client gives up.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (err) {
      // The reason (bad app password, blocked sign-in, over quota) is logged and
      // NOT surfaced to the driver: he cannot act on it, and it would describe
      // how the plumbing is wired.
      this.log({ err, to: message.to }, 'smtp: send failed');
      throw err;
    }
  }
}
