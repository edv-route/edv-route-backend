import type { EmailMessage } from './email-sender.js';

/**
 * The wording of every email in ONE place, exactly like
 * `notification-messages.ts` does for the in-app notices: services say WHAT
 * happened, this file decides how it reads. Without the split the same fact
 * gets worded three ways in three modules and nobody can review the tone the
 * affiliate actually receives.
 *
 * Email HTML is not web HTML. Tables and inline styles, because Gmail strips
 * <style> blocks in some views, Outlook renders through Word (no flex, no
 * grid), and float/gap are unreliable. It looks dated on purpose - it is what
 * survives the clients real drivers use.
 *
 * NO IMAGES, not even the logo. Most clients block remote images by default and
 * embedded data: URIs outright, so a logo would show as a broken box on the
 * first open - worse than none. The brand carries in the gradient, the gold and
 * the typography, which always render.
 */

// Brand tokens, mirrored from the app (`lib/theme/app_colors.dart`).
const RED = '#920606';
const RED_DARK = '#1A0303';
const GOLD = '#EBCA54';
const INK = '#1A1A1A';
const MUTED = '#6B7280';
const FIELD = '#F3F4F6';

// Montserrat is the brand face but almost no client loads webfonts reliably.
// The stack falls back to faces that ship with the OS and read closely enough.
const FONT = "'Montserrat', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${title}</title>
</head>
<body style="margin:0; padding:0; background-color:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F3F4F6; padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; background-color:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.06);">

<tr><td style="background-color:${RED}; background-image:linear-gradient(135deg, ${RED} 0%, ${RED_DARK} 100%); padding:28px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${FONT}; font-size:22px; font-weight:800; letter-spacing:1px; color:${GOLD};">EDV&nbsp;ROUTE</td>
</tr></table>
</td></tr>

${inner}

<tr><td style="padding:20px 32px 28px; border-top:1px solid #E5E7EB;">
<p style="margin:0; font-family:${FONT}; font-size:12px; line-height:1.6; color:${MUTED};">
Este mensaje se envió automáticamente, no respondas a esta dirección.<br>
EDV Route · Profesionales del Volante
</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The recovery code. The code itself is the whole point of the email, so it is
 * the biggest thing on the page: a driver reading this on a phone, in the
 * street, has to be able to copy six digits without hunting for them.
 */
export function passwordResetEmail(input: {
  to: string;
  firstName: string;
  code: string;
  minutes: number;
}): EmailMessage {
  // Spaced digits read better and survive a bad screen; the copy right below
  // repeats them unspaced so copy-paste still gives a usable string.
  const spaced = input.code.split('').join('&nbsp;&nbsp;');

  const inner = `<tr><td style="padding:32px 32px 8px;">
<p style="margin:0 0 6px; font-family:${FONT}; font-size:20px; font-weight:800; color:${INK};">Hola, ${escapeHtml(input.firstName)}</p>
<p style="margin:0 0 24px; font-family:${FONT}; font-size:15px; line-height:1.6; color:${INK};">
Recibimos una solicitud para cambiar la clave de tu cuenta. Escribe este código en la app para continuar:
</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="background-color:${FIELD}; border-radius:14px; padding:24px 16px;">
<div style="font-family:${FONT}; font-size:34px; font-weight:800; letter-spacing:2px; color:${INK};">${spaced}</div>
<div style="font-family:${FONT}; font-size:13px; color:${MUTED}; padding-top:10px;">Vence en ${input.minutes} minutos</div>
</td></tr>
</table>

<p style="margin:24px 0 0; font-family:${FONT}; font-size:14px; line-height:1.6; color:${MUTED};">
Si no pediste cambiar tu clave, ignora este correo: tu clave actual sigue funcionando y nadie puede entrar sin este código.
</p>
</td></tr>`;

  const text = [
    `Hola, ${input.firstName}`,
    '',
    'Recibimos una solicitud para cambiar la clave de tu cuenta.',
    `Escribe este código en la app: ${input.code}`,
    `Vence en ${input.minutes} minutos.`,
    '',
    'Si no pediste cambiar tu clave, ignora este correo: tu clave actual sigue',
    'funcionando y nadie puede entrar sin este código.',
    '',
    'EDV Route · Profesionales del Volante',
  ].join('\n');

  return {
    to: input.to,
    subject: `${input.code} es tu código para cambiar la clave`,
    html: shell('Código para cambiar tu clave', inner),
    text,
  };
}

/**
 * Sent AFTER the password actually changed. Not a courtesy: it is the only way
 * the real owner finds out if somebody else pulled off the recovery, and the
 * moment when doing something about it is still cheap.
 */
export function passwordChangedEmail(input: { to: string; firstName: string }): EmailMessage {
  const inner = `<tr><td style="padding:32px 32px 8px;">
<p style="margin:0 0 6px; font-family:${FONT}; font-size:20px; font-weight:800; color:${INK};">Hola, ${escapeHtml(input.firstName)}</p>
<p style="margin:0 0 20px; font-family:${FONT}; font-size:15px; line-height:1.6; color:${INK};">
Tu clave de EDV Route se cambió correctamente. Ya puedes entrar a la app con tu cédula y tu clave nueva.
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="background-color:#FDF3F3; border-radius:14px; padding:18px 20px;">
<p style="margin:0; font-family:${FONT}; font-size:14px; line-height:1.6; color:${RED}; font-weight:600;">
¿No fuiste tú? Comunícate con la oficina de inmediato.
</p>
</td></tr>
</table>
</td></tr>`;

  const text = [
    `Hola, ${input.firstName}`,
    '',
    'Tu clave de EDV Route se cambió correctamente.',
    'Ya puedes entrar a la app con tu cédula y tu clave nueva.',
    '',
    'Si no fuiste tú, comunícate con la oficina de inmediato.',
    '',
    'EDV Route · Profesionales del Volante',
  ].join('\n');

  return {
    to: input.to,
    subject: 'Tu clave de EDV Route fue cambiada',
    html: shell('Tu clave fue cambiada', inner),
    text,
  };
}

/**
 * The name is the only value interpolated into the markup, and it comes from
 * the database. Names are validated on write (letters, spaces, hyphen,
 * apostrophe) so this is belt-and-braces - but an email template is exactly the
 * kind of place where "it is already validated upstream" stops being true.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
