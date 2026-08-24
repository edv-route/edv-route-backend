import type { EmailMessage, EmailSender } from './email-sender.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend over its REST API with the native `fetch` - no SDK, the same call the
 * project already made for Supabase Storage and FCM. The `resend` package
 * wraps one POST with a bearer token; the dependency would cost more than it
 * saves, and this way the failure modes stay visible right here.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    /** Verified sender, e.g. `EDV Route <no-responder@edvroute.com>`. */
    private readonly from: string,
    private readonly log: (payload: unknown, msg: string) => void,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!res.ok) {
      // The body carries Resend's reason (unverified domain, invalid address,
      // rate limit). It is logged and NOT surfaced to the driver: he cannot act
      // on it, and it would leak how the plumbing is wired.
      const detail = await res.text().catch(() => '');
      this.log(
        { status: res.status, detail: detail.slice(0, 500), to: message.to },
        'resend: send failed',
      );
      throw new Error(`resend responded ${res.status}`);
    }
  }
}
