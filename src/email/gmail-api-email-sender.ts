import type { EmailMessage, EmailSender } from './email-sender.js';

/**
 * Gmail through its HTTP API instead of SMTP.
 *
 * Why this exists at all: Railway blocks outbound SMTP (25/465/587) below the
 * Pro plan, verified 2026-08-24 — the very same Gmail credentials authenticate
 * from a laptop and time out from Railway. This API speaks HTTPS on 443, which
 * nothing blocks, while the mail still LEAVES Google's servers signed by
 * Google. So the driver sees `edvroute2026@gmail.com` as the sender and the
 * message reaches the inbox, which is exactly what an ESP relaying "on behalf
 * of" a @gmail.com address cannot do.
 *
 * Same shape as `FcmPushSender`: no SDK, a token exchange with `fetch`, and the
 * access token cached until shortly before it expires. `googleapis` would drag
 * in a client for every Google product to do one POST.
 *
 * The refresh token is the long-lived credential. It only stays long-lived if
 * the OAuth app is PUBLISHED ("In production"); left in "Testing" Google expires
 * it after 7 days and the mail dies every week without an obvious cause.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** Google issues 1 h tokens; renew early so a send never races the expiry. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export interface GmailApiConfig {
  clientId: string;
  clientSecret: string;
  /** Obtained once with `npm run gmail:auth`; does not expire once published. */
  refreshToken: string;
}

export class GmailApiEmailSender implements EmailSender {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly config: GmailApiConfig,
    /**
     * Display name + address, e.g. `EDV Route <edvroute2026@gmail.com>`. Null
     * omits the header entirely and lets Gmail fill in the authorised account -
     * which is correct, whereas a display name with no address is a malformed
     * header.
     */
    private readonly from: string | null,
    private readonly log: (payload: unknown, msg: string) => void,
  ) {}

  /** Absence is not an error: the plugin just falls through to the next sender. */
  static isConfigured(config: Partial<GmailApiConfig>): config is GmailApiConfig {
    return Boolean(config.clientId && config.clientSecret && config.refreshToken);
  }

  async send(message: EmailMessage): Promise<void> {
    const accessToken = await this.authorize();
    const response = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Gmail takes the whole RFC 5322 message, base64url encoded.
      body: JSON.stringify({ raw: toBase64Url(this.buildMime(message)) }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // A 401 means the cached token died early; drop it so the next attempt
      // mints a fresh one instead of failing the same way again.
      if (response.status === 401) this.accessToken = null;
      this.log(
        { status: response.status, detail: detail.slice(0, 500), to: message.to },
        'gmail api: send failed',
      );
      throw new Error(`gmail api responded ${response.status}`);
    }
  }

  /**
   * A MIME message with both parts. `multipart/alternative` lets the client pick:
   * the HTML if it can render it, the text otherwise — and a mail with no text
   * part scores worse with spam filters, which for a recovery code is the
   * difference between arriving and not.
   */
  private buildMime(message: EmailMessage): string {
    // Fixed boundary: it only has to not appear inside the parts, and the
    // templates are ours. A random one would need Math.random for no gain.
    const boundary = 'edvroute-boundary-7f3a91c4';
    return [
      ...(this.from ? [`From: ${this.from}`] : []),
      `To: ${message.to}`,
      // RFC 2047: anything non-ASCII in a header (accents, in every subject we
      // write) must be encoded or it arrives as mojibake.
      `Subject: ${encodeHeader(message.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Wrapped(message.text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Wrapped(message.html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  /** Exchanges the refresh token for an access token, cached until it nearly expires. */
  private async authorize(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
      return this.accessToken;
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.log({ status: response.status, detail: detail.slice(0, 300) }, 'gmail api: auth failed');
      // The usual cause is a refresh token that expired because the OAuth app
      // was left in "Testing" — 7 days and it is gone. Naming it here saves the
      // next person the afternoon it costs to find out.
      throw new Error(
        `gmail oauth responded ${response.status} (¿la app OAuth quedó en modo Prueba?)`,
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }
}

/** Base64url, as Gmail's `raw` field expects: no padding, URL-safe alphabet. */
function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Plain base64 in 76-column lines, as MIME bodies require. */
function base64Wrapped(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** RFC 2047 encoded-word, so accented subjects survive the trip. */
function encodeHeader(value: string): string {
  // Printable ASCII passes through untouched; anything else has to be encoded
  // or it arrives as mojibake. Checked byte by byte rather than with a regex:
  // the escapes for a control-character range are exactly the kind of thing
  // that survives one edit and breaks on the next.
  const bytes = Buffer.from(value, 'utf8');
  const isPlainAscii = bytes.every((b) => b >= 0x20 && b <= 0x7e);
  if (isPlainAscii) return value;
  return `=?UTF-8?B?${bytes.toString('base64')}?=`;
}
