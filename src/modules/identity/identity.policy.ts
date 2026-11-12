import type { IdentityPhotoKind, IdentityPhotoStatus, IdentityRepository } from './identity.repository.js';

/**
 * The identity rules, in ONE place (decision by Luis, 2026-11-12): who has a
 * complete identity, and when the lack of one stops an affiliate from working.
 * Every gate in the API (going active, reporting location, approving a
 * solicitud) asks here instead of re-deriving it.
 */

/** The three photos everybody owes, in the order the app asks for them. */
export const IDENTITY_KINDS: readonly IdentityPhotoKind[] = ['selfie', 'id_front', 'id_back'];

/**
 * - missing:  at least one of the three was never sent.
 * - rejected: the office sent one back; the person must retake it.
 * - pending:  all three sent, at least one still waiting for the office.
 * - approved: all three approved.
 *
 * Precedence follows what the person has to DO: missing and rejected need an
 * action from him, pending only needs time.
 */
export type IdentityStatus = 'missing' | 'rejected' | 'pending' | 'approved';

/** How each photo is named to the person (notices, errors). */
export const KIND_LABEL: Record<IdentityPhotoKind, string> = {
  selfie: 'foto tipo carnet',
  id_front: 'foto del frente de tu cédula',
  id_back: 'foto del reverso de tu cédula',
};

export function isIdentityKind(value: string): value is IdentityPhotoKind {
  return (IDENTITY_KINDS as readonly string[]).includes(value);
}

export function summarize(photos: { kind: IdentityPhotoKind; status: IdentityPhotoStatus }[]): IdentityStatus {
  const byKind = new Map(photos.map((p) => [p.kind, p.status]));
  if (IDENTITY_KINDS.some((k) => !byKind.has(k))) return 'missing';
  const statuses = [...byKind.values()];
  if (statuses.includes('rejected')) return 'rejected';
  if (statuses.includes('pending')) return 'pending';
  return 'approved';
}

/** Why this identity keeps the affiliate off the road; null = it does not. */
export function workBlockReason(status: IdentityStatus): string | null {
  switch (status) {
    case 'approved':
      return null;
    case 'missing':
      return 'Te faltan las fotos de tu identidad. Envíalas desde la app para poder trabajar.';
    case 'rejected':
      return 'La oficina rechazó una foto de tu identidad. Tómala de nuevo desde la app.';
    case 'pending':
      return 'Tus fotos de identidad están en revisión. Podrás trabajar cuando la oficina las apruebe.';
  }
}

/** Refusal for the free profile-photo upload once a selfie exists. */
export const PROFILE_PHOTO_LOCKED_MESSAGE =
  'Tu foto de perfil es la foto de tu verificación de identidad y no se puede cambiar.';

export class IdentityPolicy {
  constructor(private readonly repo: IdentityRepository) {}

  /**
   * The profile photo IS the identity selfie once there is one (decision by
   * Luis, 2026-11-12): changing it freely would show a face the office never
   * checked. Before the selfie exists the old free upload still works.
   */
  async profilePhotoLocked(userId: string): Promise<boolean> {
    return this.repo.hasCurrentSelfie(userId);
  }

  async statusFor(userId: string): Promise<IdentityStatus> {
    return summarize(await this.repo.currentPhotos(userId));
  }

  /**
   * Null when the affiliate may work as far as identity goes. While the
   * `identity_required_enabled` switch is OFF nobody is held back — that is
   * the rollout window in which the photos are collected.
   */
  async workBlockReason(userId: string): Promise<string | null> {
    if (!(await this.repo.isRequired())) return null;
    return workBlockReason(await this.statusFor(userId));
  }

  /** Same rule, worded for the office approving a solicitud. */
  async approvalBlockReason(userId: string): Promise<string | null> {
    if (!(await this.repo.isRequired())) return null;
    const status = await this.statusFor(userId);
    return status === 'approved'
      ? null
      : 'Las fotos de identidad del solicitante no están aprobadas: revísalas antes de aprobar la solicitud.';
  }
}
