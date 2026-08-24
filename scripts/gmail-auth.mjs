/**
 * One-off: turns the OAuth client into a refresh token for sending mail.
 *
 * Run it ONCE, on a machine with a browser:
 *
 *   npm run gmail:auth
 *
 * It opens Google's consent screen, catches the redirect on localhost and
 * prints the refresh token to paste into `.env` and into Railway.
 *
 * The token only stays valid if the OAuth app is PUBLISHED ("En producción").
 * Left in "Prueba", Google expires it after 7 days and the mail dies every week
 * with no obvious cause — so the script checks nothing about that, but the
 * README and the deploy runbook both say it in bold.
 *
 * Scope: `gmail.send` and nothing else. It can send as the account and cannot
 * read a single message — the least this needs in order to work.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = 4599;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Faltan GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET en el .env');
  process.exit(1);
}

// Guards against a stray request landing on the callback and being mistaken for
// the real one.
const state = randomBytes(16).toString('hex');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // offline is what makes Google hand over a REFRESH token at all; without it
    // you get an access token that dies in an hour and nothing to renew it.
    access_type: 'offline',
    // Google only returns the refresh token on the FIRST authorisation of an
    // account. Forcing the prompt makes a re-run work instead of silently
    // returning nothing to save.
    prompt: 'consent',
    state,
  });

console.log('\n1. Abre esta dirección en el navegador:\n');
console.log(authUrl);
console.log('\n2. Entra con la cuenta de EDV Route y acepta.');
console.log('   Si sale "Google no ha verificado esta aplicación":');
console.log('   Configuración avanzada → Ir a (nombre) (no seguro). Es tu propia app.\n');
console.log(`Esperando la respuesta en ${REDIRECT} ...\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (!code && !error) {
    res.writeHead(204).end();
    return;
  }

  const reply = (message) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<body style="font-family:system-ui;padding:40px;background:#F3F4F6">
       <div style="max-width:520px;margin:auto;background:#fff;padding:32px;border-radius:16px">
       <h2 style="color:#920606;margin:0 0 12px">${message}</h2>
       <p style="color:#6B7280;margin:0">Puedes cerrar esta pestaña y volver a la terminal.</p>
       </div></body>`,
    );
  };

  if (error) {
    reply('Autorización cancelada');
    console.error(`\nGoogle respondió: ${error}`);
    return server.close(() => process.exit(1));
  }

  if (url.searchParams.get('state') !== state) {
    reply('Respuesta inesperada');
    console.error('\nEl `state` no coincide: se ignora esta respuesta.');
    return server.close(() => process.exit(1));
  }

  const token = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });

  const body = await token.json();

  if (!token.ok || !body.refresh_token) {
    reply('No se pudo obtener el token');
    console.error('\nRespuesta de Google:', JSON.stringify(body, null, 2));
    if (token.ok && !body.refresh_token) {
      console.error(
        '\nGoogle no devolvió refresh_token. Suele pasar al re-autorizar una cuenta:\n' +
          'revoca el acceso en https://myaccount.google.com/permissions y repite.',
      );
    }
    return server.close(() => process.exit(1));
  }

  reply('Listo');
  console.log('\n=== PEGA ESTO EN EL .env Y EN RAILWAY ===\n');
  console.log(`GMAIL_REFRESH_TOKEN=${body.refresh_token}`);
  console.log('\n=========================================');
  console.log('\nRecuerda: la app OAuth tiene que estar EN PRODUCCIÓN.');
  console.log('En modo Prueba este token caduca a los 7 días.\n');
  server.close(() => process.exit(0));
});

server.listen(PORT);
