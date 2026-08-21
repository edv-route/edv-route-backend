import type NotificationType from '../../db/models/public/NotificationType.js';

/**
 * The wording of every automatic notice, in ONE place.
 *
 * Services decide WHAT happened; this decides HOW it reads. Without the split,
 * the same event gets phrased three different ways in three modules and nobody
 * can review the tone the affiliate actually receives.
 *
 * The text is rendered HERE and stored on the row, never composed by the phone:
 * the inbox and the push must say the same thing, and fixing a word must not
 * require publishing an APK.
 *
 * UI text in Spanish (regla 5). Neutral, second person, and it always says what
 * the affiliate can DO next - a notice that only announces bad news and leaves
 * him without a next step is the phone call to the office we are trying to
 * avoid.
 */

export interface RenderedMessage {
  title: string;
  body: string;
}

const BUSINESS_TIMEZONE = 'America/Caracas';

/** `$70,00` — the affiliate reads amounts in USD; the app shows the same format. */
export function money(amountUsd: number | string): string {
  const value = typeof amountUsd === 'string' ? Number(amountUsd) : amountUsd;
  return `$${value.toFixed(2).replace('.', ',')}`;
}

/**
 * `lunes 25 de agosto`. Always in the business timezone: the server runs in UTC
 * and a charge emitted at 6pm Caracas would otherwise be announced with the next
 * day's date.
 */
export function longDate(date: Date): string {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

function weeksLabel(weeks: number): string {
  return weeks === 1 ? '1 semana' : `${weeks} semanas`;
}

/** Discriminated by `type`, so a new case cannot be added without its wording. */
export type MessageInput =
  | { type: 'charge_issued'; amountUsd: number | string; weekStart: Date }
  | { type: 'charge_reminder'; amountUsd: number | string; weekStart: Date }
  // No amount: what the engine knows at that moment is how many weeks are owed,
  // not a total. Multiplying weeks by today's price would quietly lie the day a
  // tariff version changes mid-debt.
  | { type: 'debt_overdue'; weeks: number }
  // The fine is optional: a driver can cross the cap while an unpaid fine from a
  // previous episode already exists, and he is not fined twice. He must still be
  // told he cannot work.
  | { type: 'penalty_applied'; capWeeks: number; fineUsd?: number | string }
  | { type: 'driver_reactivated' }
  | { type: 'tariff_starting'; startsOn: Date }
  | { type: 'payment_received'; amountUsd: number | string }
  | { type: 'payment_approved'; amountUsd: number | string }
  | { type: 'payment_rejected'; amountUsd: number | string; reason: string }
  | { type: 'application_approved' }
  // No reason: rejecting a solicitud takes none today (the panel sends no field
  // for it), and inventing one here would put words in the admin's mouth.
  | { type: 'application_rejected' }
  | { type: 'document_approved'; name: string }
  | { type: 'document_rejected'; name: string; reason: string }
  | { type: 'vehicle_approved'; plate: string }
  | { type: 'vehicle_rejected'; plate: string; reason: string };

export function renderMessage(input: MessageInput): RenderedMessage {
  switch (input.type) {
    case 'charge_issued':
      // Says the three things he needs at once: the invoice exists, what it
      // costs, and the DAY it turns into arrears. The deadline is the point —
      // "se emitió tu semana" alone left him to work out the consequence.
      return {
        title: 'Nuevo cobro semanal',
        body: `Se generó tu factura de ${money(input.amountUsd)} por la semana que empieza el ${longDate(input.weekStart)}. Si no la pagas antes de ese día, entras en mora.`,
      };
    case 'charge_reminder':
      return {
        title: 'Tu semana empieza mañana',
        body: `El ${longDate(input.weekStart)} comienza la semana que ya se te emitió (${money(input.amountUsd)}). Si la pagas antes, no entras en mora.`,
      };
    case 'debt_overdue':
      return {
        title: 'Tienes una semana vencida',
        body: `Tu semana comenzó sin pagar: debes ${weeksLabel(input.weeks)}. Puedes seguir trabajando, pero reporta el pago para no acumular.`,
      };
    case 'penalty_applied':
      return {
        title: 'Cuenta penalizada',
        body:
          `Superaste el tope de ${weeksLabel(input.capWeeks)} de deuda, así que por ahora no puedes trabajar.` +
          (input.fineUsd === undefined ? '' : ` Se te cargó una multa de ${money(input.fineUsd)}.`) +
          ' Al pagar la deuda completa vuelves a la calle.',
      };
    case 'driver_reactivated':
      return {
        title: 'Cuenta reactivada',
        body: 'Ya estás al día y puedes volver a trabajar. Recuerda ponerte disponible en la app.',
      };
    case 'tariff_starting':
      return {
        title: 'Ya tienes fecha de inicio',
        body: `Tu tarifa comienza el ${longDate(input.startsOn)}. Desde ese día puedes ponerte disponible y trabajar.`,
      };
    case 'payment_received':
      return {
        title: 'Recibimos tu pago',
        body: `Tu pago de ${money(input.amountUsd)} está en revisión. Te avisamos apenas la oficina lo verifique.`,
      };
    case 'payment_approved':
      return {
        title: 'Pago aprobado',
        body: `Se aprobó tu pago de ${money(input.amountUsd)}. Ya puedes ver tu estado de cuenta actualizado.`,
      };
    case 'payment_rejected':
      // The reason is the whole point of this one: the rejection used to be
      // invisible, and the affiliate re-sent the same receipt over and over
      // while the office assumed he had already been answered (bug 2026-08-19).
      return {
        title: 'Pago rechazado',
        body: `No se pudo aprobar tu pago de ${money(input.amountUsd)}. Motivo: ${input.reason}. Corrige lo indicado y repórtalo de nuevo desde la app.`,
      };
    case 'application_approved':
      return {
        title: 'Solicitud aprobada',
        body: 'Tu solicitud fue aprobada. La oficina te asignará la fecha en la que comienzas a trabajar.',
      };
    case 'application_rejected':
      return {
        title: 'Solicitud rechazada',
        body: 'Tu solicitud no fue aprobada. Comunícate con la oficina para conocer el motivo y saber si puedes volver a intentarlo.',
      };
    case 'document_approved':
      return {
        title: 'Documento aprobado',
        body: `Tu ${input.name} fue aprobado.`,
      };
    case 'document_rejected':
      return {
        title: 'Documento rechazado',
        body: `Tu ${input.name} no fue aprobado. Motivo: ${input.reason}. Vuelve a cargarlo desde la app.`,
      };
    case 'vehicle_approved':
      return {
        title: 'Vehículo aprobado',
        body: `Tu vehículo ${input.plate} fue aprobado y ya puedes trabajar con él.`,
      };
    case 'vehicle_rejected':
      return {
        title: 'Vehículo rechazado',
        body: `Tu vehículo ${input.plate} no fue aprobado. Motivo: ${input.reason}. Corrige lo indicado y vuelve a enviarlo desde la app.`,
      };
  }
}

/** The stored `type` column always matches the wording that was rendered. */
export function messageType(input: MessageInput): NotificationType {
  return input.type;
}
