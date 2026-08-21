import { createSign } from 'node:crypto';
import type { PushMessage, PushResult, PushSender } from './push-sender.js';

/**
 * Firebase Cloud Messaging over the HTTP v1 API.
 *
 * The ONLY piece the whole notification system needed in order to actually
 * reach a phone: the outbox, the dispatcher and the inbox do not change a line.
 *
 * No SDK. `firebase-admin` drags in a large dependency tree to do two things we
 * need — sign a JWT and POST some JSON — and the OAuth flow below is a documented
 * 40-line exchange. Node's own crypto signs it and `fetch` sends it.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Google issues 1 h tokens; renew early so a request never races the expiry. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PEM. Carried in the environment on one line with literal `\n` escapes. */
  privateKey: string;
}

/**
 * Errors FCM returns for a token that no longer exists. The row must be revoked
 * or the table fills with addresses nobody answers at, and every send pays for
 * them. Anything else is treated as a transient failure and retried.
 */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND']);

export class FcmPushSender implements PushSender {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly config: FcmConfig,
    private readonly log: (payload: unknown, msg: string) => void,
  ) {}

  /**
   * True when the three variables are present. Their absence is not an error:
   * the dispatcher simply keeps the log-only sender, so a deploy without
   * Firebase credentials serves every other request exactly as before.
   */
  static isConfigured(config: Partial<FcmConfig>): config is FcmConfig {
    return Boolean(config.projectId && config.clientEmail && config.privateKey);
  }

  async send(message: PushMessage): Promise<PushResult> {
    const token = await this.authorize();
    const invalidTokens: string[] = [];
    let delivered = 0;

    // One HTTP call per device. The v1 API has no multicast endpoint (the old
    // batch one is gone), and a driver has one or two phones — not hundreds.
    for (const device of message.tokens) {
      const outcome = await this.sendOne(token, device, message);
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'dead') invalidTokens.push(device);
    }

    return { delivered, invalidTokens };
  }

  private async sendOne(
    accessToken: string,
    device: string,
    message: PushMessage,
  ): Promise<'delivered' | 'dead' | 'failed'> {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: device,
            // A NOTIFICATION message, never a data-only one: the system draws
            // it, so it survives the battery managers of Xiaomi/Oppo/Vivo and
            // still arrives with the app closed. A data-only message reaches a
            // handler those launchers refuse to wake.
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: {
              priority: 'HIGH',
              notification: {
                // Tapping it opens the app on the inbox (the app declares this
                // intent filter); without it the tap does nothing.
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                channelId: 'edv_avisos',
              },
            },
          },
        }),
      },
    );

    if (response.ok) return 'delivered';

    const body = (await response.json().catch(() => null)) as {
      error?: { status?: string; message?: string };
    } | null;
    const status = body?.error?.status ?? String(response.status);

    if (DEAD_TOKEN_CODES.has(status)) {
      this.log({ status }, 'push: device token is gone, revoking it');
      return 'dead';
    }
    // 401 usually means the cached access token died early; drop it so the next
    // pass mints a fresh one instead of failing three times and giving up.
    if (response.status === 401) this.accessToken = null;
    this.log({ status, message: body?.error?.message }, 'push: send failed');
    return 'failed';
  }

  /** Cached OAuth2 access token, minted from the service account. */
  private async authorize(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
      return this.accessToken;
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Never let the private key or the assertion reach a log line.
      throw new Error(`FCM auth failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + json.expires_in * 1000;
    return this.accessToken;
  }

  /** The signed JWT that buys an access token (RFC 7523). */
  private assertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.config.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    };

    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    // The key travels on one line in the environment; restore the real newlines
    // or the PEM parser rejects it.
    const pem = this.config.privateKey.replace(/\\n/g, '\n');
    return `${unsigned}.${signer.sign(pem, 'base64url')}`;
  }
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
