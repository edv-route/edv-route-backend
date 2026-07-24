# Guía: levantar el entorno de desarrollo

> Actualizado: 2026-07-10

## Prerrequisitos

- **Node.js ≥ 22** y npm.
- Acceso al proyecto **Supabase** `edv-route` (o crear uno nuevo: plan Free, región East US
  N. Virginia, con la extensión **PostGIS** habilitada en Database → Extensions y la
  **Data API deshabilitada** en Project Settings).

## 1. Backend (`edv-route-backend`)

```bash
cd edv-route-backend
npm install
cp .env.example .env
```

Editar `.env`:

1. `DATABASE_URL`: en Supabase → botón **Connect** → pestaña **Direct** → método
   **Session pooler** (host `*.pooler.supabase.com`, puerto 5432). Sustituir
   `[YOUR-PASSWORD]` por la contraseña de la base de datos.
2. `JWT_SECRET`: generar uno propio:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
3. **Storage** (subida de documentos), opcional en local: `SUPABASE_URL` (URL del proyecto)
   y `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Settings → API Keys → **Secret key**,
   `sb_secret_…`; **nunca** la publishable). Sin ellas el backend arranca igual y solo las
   subidas responden 503. El bucket privado (`STORAGE_BUCKET`, por defecto `documents`)
   ya existe en el proyecto; si creas otro entorno, créalo privado con límite de 10 MB
   y MIME `application/pdf,image/jpeg,image/png`.

Luego:

```bash
npm run migrate      # aplica las migraciones (crea/actualiza todas las tablas)
npm run seed:admin   # crea el primer admin (usuario "admin"; imprime la contraseña UNA vez)
npm run dev          # levanta la API en http://localhost:3000
```

Verificación: `GET http://localhost:3000/api/v1/health` debe responder
`{ "status": "ok", ..., "postgis": "3.x.x" }`.

## 2. Frontend (`edv-route-admin`)

```bash
cd edv-route-admin
npm install
npm start            # http://localhost:4200
```

Entrar con el usuario `admin` y la contraseña que imprimió el seed (cambiarla en
**Administradores → Editar** tras el primer acceso).

## Comandos útiles

| Dónde | Comando | Qué hace |
|---|---|---|
| backend | `npm run typecheck` | Verificación de tipos sin compilar |
| backend | `npm test` | Tests de integración (`node:test` + tsx). No abren puerto: prueban contra la BD y con `app.inject()`; cada test crea y borra sus propios datos |
| backend | `npm run migrate:create -- nombre` | Crea una migración nueva |
| backend | `npm run migrate:down` | Revierte la última migración (y regenera modelos) |
| backend | `npm run db:types` | Regenera `src/db/models` desde la BD |
| frontend | `npm run build` | Build de producción |
| frontend | `npm test` | Tests unitarios (Vitest) |

## ⚠️ Regla: la BD y los modelos siempre sincronizados

**Cada modificación de la base de datos debe ir acompañada de la regeneración de los
modelos** (`src/db/models`). `npm run migrate` y `npm run migrate:down` lo hacen
automáticamente; si tocas la BD por cualquier otra vía, corre `npm run db:types` a mano.
Después ejecuta `npm run typecheck`: el compilador señalará cualquier código que haya
quedado incompatible con el nuevo esquema, **y actualiza la referencia del esquema**
([../database/schema.md](../database/schema.md)) en el mismo cambio.
Detalle completo: [../../src/db/README.md](../../src/db/README.md).

## Problemas comunes

- **El backend no arranca / error de conexión**: revisa `DATABASE_URL` (¿usaste el Session
  pooler y no la Direct connection? La directa requiere IPv6).
- **`env must have required property 'JWT_SECRET'`**: falta esa variable en `.env`
  (mínimo 32 caracteres).
- **401 constante en el panel**: el token expiró (8 h) — cerrar sesión y volver a entrar.
- **503 al subir un archivo**: faltan `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` en `.env`.
- **`EMAXCONNSESSION` al regenerar modelos**: el Session pooler admite 15 sesiones; cierra
  los `npm run dev` abiertos, espera ~1 min y reintenta `npm run db:types`.
- **`invalid input value for enum … "<valor nuevo>"` justo después de una migración** (code
  `22P02`, routine `enum_in`), aunque la base sí tenga el valor: es el **pooler de Supabase**.
  Una conexión de servidor abierta antes del `ALTER TYPE … ADD VALUE` conserva el catálogo
  cacheado y rechaza el literal hasta reciclarse; **es intermitente y se pasa solo**. Por eso
  el código compara los estados como texto (`status::text = '…'`, decisión 2026-07-23). Si te
  topas con ello en una consulta nueva, usa el mismo cast en vez de esperar.
