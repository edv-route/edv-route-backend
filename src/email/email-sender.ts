/**
 * Email abstraction: nothing outside this folder ever talks to a mail vendor,
 * exactly like `StorageProvider` does for files and `PushSender` for push.
 *
 * Email is NOT push. Push is a courtesy that may never arrive (a phone without
 * Play Services, a denied permission) and the inbox covers for it. Email is the
 * only way back into an account whose password is forgotten, so when it fails
 * the caller has to know - hence `send` rejects instead of swallowing errors.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Rendered HTML. The plain-text part is derived from it by the sender. */
  html: string;
  /**
   * Plain-text alternative. Some clients show it, spam filters weigh it, and a
   * mail with no text part scores worse - a recovery code that lands in spam is
   * a recovery that did not happen.
   */
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Stand-in used when no provider is configured: logs what WOULD have been sent
 * instead of sending it. Same role `LogPushSender` plays for push - the whole
 * recovery flow can be exercised end to end (including reading the code off the
 * log in development) before any vendor account exists.
 *
 * It deliberately logs the SUBJECT and body, because in development that is the
 * only way to read the code. That is also exactly why it must never be the
 * sender in production: see `email.ts` (the plugin refuses to boot production
 * with recovery enabled and no provider).
 */
export class LogEmailSender implements EmailSender {
  constructor(private readonly log: (payload: unknown, msg: string) => void) {}

  async send(message: EmailMessage): Promise<void> {
    this.log(
      { to: message.to, subject: message.subject, text: message.text },
      'email (log-only sender): not sent, no provider configured',
    );
  }
}
