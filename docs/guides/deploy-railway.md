# Despliegue en producción — Railway

> Estado: **en producción desde 2026-07-27.** Backend y frontend corren como dos servicios
> Railway dentro del mismo proyecto, apuntando al **mismo Supabase que desarrollo** (decisión
> consciente: sin proyecto de prod separado por ahora). Este documento es el runbook de
> operación: cómo está montado, qué variables lleva y cómo redesplegar o mover cosas.

## Arquitectura del despliegue

| Pieza | Dónde | URL pública |
|---|---|---|
| **Backend** (Fastify) | Railway · repo `edv-route-backend` (rama `main`) | `https://edv-route-backend.up.railway.app` |
| **Frontend** (Angular) | Railway · repo `edv-route-admin` (rama `main`) | `https://edv-route-admin.up.railway.app` |
| **Base de datos + Storage** | Supabase (el **mismo** de desarrollo) | — |

- Ambos servicios viven en el **mismo proyecto** de Railway; cada push a `main` de su repo dispara
  un redeploy automático.
- La API vive bajo `/api/v1`; el frontend la consume en `…/api/v1` (ver `environment.prod.ts`).
- Health del backend (público): `GET /api/v1/health` → `{ status, dbTime, postgis }`.

## Backend — Nixpacks

El backend se construye con **Nixpacks** (el builder automático de Railway): detecta Node, corre
`npm ci` + `npm run build` y arranca con `npm start`. **No usa Dockerfile.** El server escucha en
`HOST=0.0.0.0` y el `PORT` que Railway inyecta (por eso no se setean a mano).

> Nota: en el repo local existen un `Dockerfile` y un `railway.json` preparados pero **sin subir**:
> el backend funciona con Nixpacks y no se quiso tocar un servicio operativo. Si algún día se migra
> a Docker (build reproducible + health-check de plataforma), esos archivos son el punto de partida.

### Variables de entorno (Railway → servicio backend → Variables)

Los **valores** viven solo en Railway y en el `.env` local (nunca versionados; ver
[`.env.example`](../../.env.example)). Nombres y significado:

| Variable | Obligatoria | Notas |
|---|---|---|
| `DATABASE_URL` | ✅ | Session pooler de Supabase (puerto 5432). El mismo de desarrollo. |
| `JWT_SECRET` | ✅ | ≥ 32 chars. Firma los tokens de admin (independiente de la BD). |
| `JWT_EXPIRES_IN` | — | Default `8h`. |
| `CORS_ORIGIN` | ✅ en prod | Lista de orígenes **separados por coma, SIN espacios** (ver abajo). |
| `NODE_ENV` | — | `production`. |
| `LOG_LEVEL` | — | `info`. |
| `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `STORAGE_BUCKET` | para uploads | Sin ellas la API arranca pero las subidas dan 503. |
| `PORT` · `HOST` | ❌ **no setear** | Railway inyecta `PORT`; `HOST` cae en `0.0.0.0` por defecto. Setearlos rompe el arranque. |

### CORS — cuidado con los espacios

El backend arma la allowlist con `config.CORS_ORIGIN.split(',')` (**sin `trim`**, ver `src/app.ts`).
Por eso el valor debe ir **sin espacios** tras las comas y con el origin **exacto** (esquema + host,
sin barra final):

```
http://localhost:4200,https://edv-route-admin.up.railway.app
```

Un espacio (`…, https://…`) deja el segundo origin como `" https://…"` y **no matchea** el header
`Origin` real → el panel queda bloqueado por CORS. (Mejora futura anotada: añadir `.map(s => s.trim())`.)

## Frontend — Docker + Caddy (obligatorio)

El panel es un **SPA estático**. El builder automático de Railway (**Railpack**) lo compila pero
**no lo sirve** (no monta un servidor con fallback a `index.html`), así que el frontend **debe** usar
**Builder: Dockerfile** (Railway → servicio frontend → Settings → Build → Builder = *Dockerfile*,
Dockerfile Path `/Dockerfile`). Sin esto el sitio queda en blanco.

- [`Dockerfile`](../../../edv-route-admin/Dockerfile): multi-stage — compila Angular (`npm run build`)
  y sirve el resultado con **Caddy**.
- [`Caddyfile`](../../../edv-route-admin/Caddyfile): `try_files … /index.html` (rutas de Angular),
  escucha el `$PORT` de Railway, gzip y cache larga para assets con hash.
- **No** se ponen Build Command ni Start Command custom: el Dockerfile define todo.
- `apiUrl` de producción → `src/environments/environment.prod.ts`, cableado con `fileReplacements`
  en `angular.json` (configuración `production`). Apunta a `https://edv-route-backend.up.railway.app/api/v1`.

## Runbook

- **Redesplegar** (cualquiera): `git push` a `main` del repo → Railway reconstruye solo.
- **Cambiar la URL de la API** (si cambia el dominio del backend): editar `apiUrl` en
  `environment.prod.ts` → push → Railway reconstruye el frontend.
- **Cambiar CORS**: editar la variable `CORS_ORIGIN` del backend en Railway (redeploy automático).
  Debe incluir el origin **exacto** del frontend.
- **Verificar salud**: `GET https://edv-route-backend.up.railway.app/api/v1/health` → `status: ok`.

## Lecciones aprendidas (2026-07-27)

1. **Frontend = Builder Dockerfile, sí o sí.** Railpack (default) no sirve un SPA estático.
2. **`CORS_ORIGIN` sin espacios** — el backend no hace `trim`.
3. **La cola de build de Railway puede atascarse** (deploy en `Queued` varios minutos sin arrancar
   *Initialization*). No es el proyecto: es la plataforma (la región **US West** estuvo degradada, y
   hubo una incidencia transitoria de GitHub). Salidas: cambiar de región, recrear el servicio, o
   esperar/soporte (`station.railway.com`). En el primer despliegue se resolvió recreando el servicio.
4. **El dominio puede llevar sufijo `-production`** si el nombre está tomado. Verificar la URL real
   generada y ajustar `CORS_ORIGIN` a esa.

## Pendientes / mejoras futuras

- **Proyecto Supabase separado para producción** (hoy comparte datos y credenciales con desarrollo).
- **Backend a Docker + health-check** de plataforma (archivos ya listos en local).
- **Alternativa de hosting del frontend**: al ser estático, un CDN (Cloudflare Pages / Vercel) es el
  lugar natural — sin colas de build, gratis, HTTPS/CDN. Evaluado como salida si Railway diera guerra.
- **`CORS_ORIGIN.trim()`** por robustez.

## Límite de conexiones (EMAXCONNSESSION)

El **pooler en modo sesión de Supabase limita TODO el proyecto a 15 clientes**, y producción y
desarrollo comparten la misma base. Ese techo no es por proceso: es la suma de todos.

```
Railway (prod)  8  +  laptop (dev)  3  +  una corrida de pruebas  2..4   =  13..15
```

Con el `max: 10` plano que había antes la cuenta no daba: dos backends solos pedían 20 y el
pooler empezaba a rechazar con `(EMAXCONNSESSION) max clients reached in session mode`. Todos
los schedulers fallaban a la vez, lo que **se lee como una caída de la base de datos** y en
realidad son dos máquinas siendo avariciosas (2026-08-21).

- El tamaño lo elige `src/plugins/db.ts` por entorno; `DATABASE_POOL_MAX` lo sobreescribe, para
  poder retunear producción desde Railway sin redesplegar código.
- Los pools de pruebas y scripts van con `max: 2` **explícito**: sin `max`, node-postgres asume
  **10** y una sola corrida se comía dos tercios del techo sin que nadie lo viera.
- **La forma de verdad de ganar aire** es subir el techo: Supabase > Settings > Database >
  Connection pooling > *Pool Size*. Este archivo solo reparte lo que hay.
- Si vuelve a aparecer: cierra el backend local antes de correr la suite, y comprueba en el log
  de arranque la línea `database connection established` con su `poolMax`.

## Correo (recuperación de clave)

El backend elige proveedor por las variables que encuentre: **Resend** si están las suyas, si no
**SMTP**, si no un enviador de mentira que solo escribe en el log. En el arranque lo dice:
`email ready · provider: smtp` (o `resend`, o el aviso `email not configured`).

**Hoy: Gmail**, porque EDV Route no tiene dominio propio y ningún proveedor envía a destinatarios
arbitrarios desde un dominio sin verificar.

| Variable | Valor |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | la cuenta de Gmail de EDV Route |
| `SMTP_PASSWORD` | la **contraseña de aplicación** de Google (16 caracteres, sin espacios), nunca la clave real de la cuenta |
| `EMAIL_FROM` | opcional: `EDV Route <la-misma-cuenta@gmail.com>`. Gmail reescribe el remitente a la cuenta autenticada, así que tiene que ser esa misma dirección |

La contraseña de aplicación se saca en la cuenta de Google → Seguridad → **Verificación en 2 pasos**
(hay que activarla primero) → Contraseñas de aplicaciones. Se puede revocar sin tocar la clave real.

**El día que haya dominio**: verificarlo en Resend y añadir `RESEND_API_KEY` + `EMAIL_FROM` con una
dirección de ese dominio. Resend tiene prioridad, así que no hace falta quitar las de SMTP.
