/**
 * Push abstraction: nothing outside this folder ever talks to a vendor, exactly
 * like `StorageProvider` does for files. Firebase is the last phase of this
 * feature on purpose - the whole notification system (outbox, inbox, badge)
 * works with the log-only sender below, so the account/Gradle/APK part of FCM
 * cannot block any of it. Swapping it in means writing one more implementation.
 */

export interface PushMessage {
  /** Every live device of ONE recipient. A driver may have several phones. */
  tokens: string[];
  title: string;
  body: string;
  /**
   * Extra context for the app (screen to open, entity id). Strings only: this
   * rides along a NOTIFICATION message, whose payload FCM types as string map.
   *
   * Notification message, never a data-only one: the system renders it, so it
   * survives the aggressive battery managers of Xiaomi/Oppo/Vivo and still
   * arrives with the app closed. A data-only message reaches a handler that
   * those launchers refuse to wake.
   */
  data?: Record<string, string>;
}

export interface PushResult {
  /** Devices that actually took the message. */
  delivered: number;
  /**
   * Tokens the vendor reports as gone (uninstalled, rotated). The caller MUST
   * revoke these rows: FCM rotates tokens constantly and a table that only ever
   * grows ends up spending every send on addresses that no longer exist.
   */
  invalidTokens: string[];
}

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}

/**
 * Phase-1 sender: writes what WOULD have gone out and reports it as delivered.
 * Lets the outbox, the retry accounting and the dispatcher be exercised end to
 * end before Firebase exists, without a single real push leaving the building.
 */
export class LogPushSender implements PushSender {
  constructor(private readonly log: (payload: unknown, msg: string) => void) {}

  async send(message: PushMessage): Promise<PushResult> {
    this.log(
      { tokens: message.tokens.length, title: message.title, data: message.data },
      'push (log-only sender): not sent, no provider configured yet',
    );
    return { delivered: message.tokens.length, invalidTokens: [] };
  }
}
