import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { passwordChangedEmail, passwordResetEmail } from '../../email/email-templates.js';
import type { PasswordResetRepository, ResetTarget } from './password-reset.repository.js';

/** 6 digits: what fits in the app's six boxes and what people can retype. */
const CODE_LENGTH = 6;
/** Long enough to switch to the mail app and back, short enough to be useless later. */
const CODE_TTL_MINUTES = 10;
/** A 6-digit code with unlimited tries is a 6-digit code anyone can guess. */
const MAX_ATTEMPTS = 3;
/** Per account, per hour. Stops this becoming a way to flood someone's inbox. */
const MAX_REQUESTS_PER_HOUR = 5;
/** Between codes, so "resend" cannot be held down. */
const RESEND_COOLDOWN_SECONDS = 60;

export class PasswordResetService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly repo: PasswordResetRepository,
  ) {}

  /**
   * Step 1, driver channel: cédula + email must match ONE account; a code goes
   * to that address.
   *
   * The mismatch is reported plainly ("los datos no coinciden") rather than with
   * the neutral "if they match we sent a code". That IS user enumeration - with
   * two required fields it is a narrow one, and it was a deliberate call: the
   * driver retyping his own cédula deserves to be told it is wrong. Switching to
   * the silent version is a one-line change here and in the app copy.
   */
  async requestCode(input: { nationalId: string; email: string; ip: string | null }): Promise<void> {
    const target = await this.repo.findTarget(input.nationalId.trim(), input.email.trim());
    await this.issueCode(target, input.ip);
  }

  /**
   * Step 1, client channel: the email alone. A passenger has no cédula on file,
   * and the register endpoint already tells anyone whether an email is taken,
   * so the single field reveals nothing that was hidden — same deliberate call
   * as the driver's plain mismatch message.
   */
  async requestClientCode(input: { email: string; ip: string | null }): Promise<void> {
    const target = await this.repo.findClientTarget(input.email.trim());
    await this.issueCode(target, input.ip);
  }

  /** The shared middle of step 1: rate limits, the code, and the mail. */
  private async issueCode(target: ResetTarget | null, ip: string | null): Promise<void> {
    const { httpErrors } = this.app;

    // A log-only sender means the code reaches a log file, not the person. Say
    // so rather than show a screen promising mail that never left.
    if (!this.app.emailConfigured && this.app.config.NODE_ENV === 'production') {
      this.app.log.error('password reset requested but no email provider is configured');
      throw httpErrors.serviceUnavailable(
        'El envío de correos no está disponible por ahora. Comunícate con la oficina.',
      );
    }

    if (!target) throw httpErrors.notFound('Los datos no coinciden con ninguna cuenta');

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if ((await this.repo.countRecentRequests(target.userId, hourAgo)) >= MAX_REQUESTS_PER_HOUR) {
      throw httpErrors.tooManyRequests(
        'Pediste demasiados códigos. Espera una hora e inténtalo de nuevo.',
      );
    }

    // The cooldown reads the live attempt instead of a timer: a restart must not
    // reset it, and the row already knows when it was issued.
    const live = await this.repo.findLive(target.userId);
    if (live) {
      const issuedAt = live.expiresAt.getTime() - CODE_TTL_MINUTES * 60 * 1000;
      const waitMs = RESEND_COOLDOWN_SECONDS * 1000 - (Date.now() - issuedAt);
      if (waitMs > 0) {
        throw httpErrors.tooManyRequests(
          `Espera ${Math.ceil(waitMs / 1000)} segundos para pedir otro código.`,
        );
      }
    }

    // randomInt is the CSPRNG; Math.random is predictable and this code is a
    // temporary password. Padded so every code is exactly six digits - dropping
    // a leading zero would silently shrink the space to five.
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    const id = await this.repo.create({ userId: target.userId, codeHash, expiresAt, ip });

    try {
      await this.app.email.send(
        passwordResetEmail({
          to: target.email,
          firstName: target.firstName,
          code,
          minutes: CODE_TTL_MINUTES,
        }),
      );
    } catch (err) {
      // The code is already stored, so leaving it live would strand the driver on
      // the code screen waiting for mail that never arrives - and burn one of his
      // hourly requests for nothing. Spend it so he can ask again right away.
      await this.repo.spend(id);
      this.app.log.error({ err }, 'password reset: email send failed');
      throw httpErrors.serviceUnavailable(
        'No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.',
      );
    }
  }

  /**
   * Step 2, driver channel: the code. Returns a short-lived token that
   * authorises ONE password change - the code itself is never accepted again.
   */
  async verifyCode(input: {
    nationalId: string;
    email: string;
    code: string;
  }): Promise<{ resetToken: string }> {
    const target = await this.repo.findTarget(input.nationalId.trim(), input.email.trim());
    return this.verifyFor(target, input.code);
  }

  /** Step 2, client channel: same check, identity by email alone. */
  async verifyClientCode(input: { email: string; code: string }): Promise<{ resetToken: string }> {
    const target = await this.repo.findClientTarget(input.email.trim());
    return this.verifyFor(target, input.code);
  }

  private async verifyFor(
    target: ResetTarget | null,
    code: string,
  ): Promise<{ resetToken: string }> {
    const { httpErrors } = this.app;

    if (!target) throw httpErrors.notFound('Los datos no coinciden con ninguna cuenta');

    const attempt = await this.repo.findLive(target.userId);
    if (!attempt) throw httpErrors.badRequest('El código venció. Pide uno nuevo.');

    const ok = await argon2.verify(attempt.codeHash, code.trim()).catch(() => false);
    if (!ok) {
      const used = await this.repo.registerFailure(attempt.id);
      const left = MAX_ATTEMPTS - used;
      if (left <= 0) {
        await this.repo.spend(attempt.id);
        throw httpErrors.badRequest('Agotaste los intentos. Pide un código nuevo.');
      }
      const tries = left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`;
      throw httpErrors.badRequest(`El código no es correcto. Te ${tries}.`);
    }

    // Guarded update: two requests racing with the right code produce exactly one
    // token, because only one of them flips `verified_at`.
    if (!(await this.repo.markVerified(attempt.id))) {
      throw httpErrors.badRequest('El código ya se usó. Pide uno nuevo.');
    }

    const resetToken = this.app.jwt.sign(
      { sub: target.userId, type: 'pwd_reset', rid: attempt.id },
      { expiresIn: `${CODE_TTL_MINUTES}m` },
    );
    return { resetToken };
  }

  /**
   * Step 3: the new password. The attempt is spent in the same transaction.
   * Channel-agnostic on purpose — the token already proves email ownership and
   * both sides share the SAME password in `users`; the channel only decides how
   * the confirmation mail words "entrar".
   */
  async confirm(
    input: { resetToken: string; password: string },
    channel: 'driver' | 'client' = 'driver',
  ): Promise<void> {
    const { httpErrors } = this.app;

    let payload: { sub: string; type: string; rid?: string };
    try {
      payload = this.app.jwt.verify(input.resetToken);
    } catch {
      throw httpErrors.unauthorized('El código venció. Vuelve a pedir uno.');
    }
    // A driver SESSION token would otherwise be accepted here, letting anyone
    // holding a stolen session set a new password without knowing the old one -
    // exactly what `PATCH /me` demands `currentPassword` to prevent.
    if (payload.type !== 'pwd_reset' || !payload.rid) {
      throw httpErrors.unauthorized('El código no es válido.');
    }

    const attempt = await this.repo.findLiveById(payload.rid);
    if (!attempt || !attempt.verifiedAt || attempt.userId !== payload.sub) {
      throw httpErrors.unauthorized('El código venció. Vuelve a pedir uno.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    if (!(await this.repo.consumeAndSetPassword(attempt.id, attempt.userId, passwordHash))) {
      throw httpErrors.unauthorized('El código ya se usó. Vuelve a pedir uno.');
    }

    // Best-effort on purpose: the password ALREADY changed, and failing the
    // request now would tell the driver it did not. This mail is how the real
    // owner finds out somebody else pulled off the recovery, so it is worth
    // sending - but not worth undoing a successful change over.
    try {
      const recipient = await this.repo.findRecipient(attempt.userId);
      if (recipient) {
        await this.app.email.send(
          passwordChangedEmail({ to: recipient.email, firstName: recipient.firstName, channel }),
        );
      }
    } catch (err) {
      this.app.log.error({ err }, 'password reset: confirmation email failed (password DID change)');
    }
  }
}
