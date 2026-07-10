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
