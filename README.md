# EDV Route — Backend

API de EDV Route (Profesionales del Volante). Único punto de entrada a los datos:
las aplicaciones (admin, apps móviles) jamás tocan la base de datos directamente.

## Stack

- **Node.js 22+** / **TypeScript** (ESM estricto)
- **Fastify 5** (REST; WebSockets se añadirán con los módulos de tiempo real)
- **PostgreSQL + PostGIS** alojado en **Supabase** (solo como Postgres gestionado)
- **node-pg-migrate** para migraciones versionadas en este repo

## Estructura de carpetas

```
src/
├── config/         # Carga y validación de variables de entorno (falla al arrancar si falta algo)
├── plugins/        # Plugins de infraestructura (db pool, y próximos: auth, websocket)
├── modules/        # Un directorio por dominio de negocio
│   └── health/     #   Cada módulo: *.routes.ts / *.service.ts / *.repository.ts / *.schemas.ts
├── db/
│   ├── migrations/ # Migraciones versionadas (node-pg-migrate) — la fuente de verdad del esquema
│   ├── models/     # Un modelo TS por tabla, GENERADO desde la BD con Kanel (no editar a mano)
│   └── case-types.ts # Helper de tipos snake_case (BD) → camelCase (API)
├── app.ts          # buildApp(): ensambla plugins + módulos (testeable sin puerto)
└── server.ts       # Entrypoint: arranca el servidor y maneja shutdown limpio
```

**Reglas:**

- `routes` solo valida/serializa (schemas JSON) y delega en `service`.
- `service` contiene la lógica de negocio; `repository` es el único que ejecuta SQL.
- Ningún archivo fuente supera las 1000 líneas.

## Configuración

```bash
cp .env.example .env   # y completar DATABASE_URL con la cadena de Supabase
```

`DATABASE_URL` se obtiene en: Supabase Dashboard → Project Settings → Database →
Connection string (usar el **Session pooler**, puerto 5432, en redes IPv4).

## Comandos

```bash
npm run dev             # desarrollo con recarga (tsx watch)
npm run build           # compila a dist/
npm start               # producción (node dist/server.js)
npm run typecheck       # verificación de tipos sin emitir
npm run migrate         # aplica migraciones pendientes Y regenera los modelos
npm run migrate:create -- nombre-migracion   # crea una migración nueva
npm run db:types        # regenera src/db/models desde la BD (manual)
```

> ⚠️ **Regla:** toda modificación de la base de datos exige regenerar los modelos de
> `src/db/models` para que nunca queden desactualizados. `npm run migrate` ya lo hace
> automáticamente; si tocas la BD por otra vía, corre `npm run db:types`. Detalle:
> [src/db/README.md](src/db/README.md).

## Endpoints

Todos bajo `/api/v1`. Salvo `health` y `auth/login`, requieren `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Liveness + hora de BD + versión de PostGIS |
| POST | `/auth/login` | Login admin (usuario + contraseña) → JWT. Bloqueo tras 5 intentos fallidos (15 min) |
| GET | `/auth/me` | Perfil del admin autenticado |
| GET/POST | `/admins` | Listar / crear administradores |
| GET/PATCH | `/admins/:id` | Detalle / actualizar (nombre, email, estado; sin auto-suspensión) |
| PUT | `/admins/:id/password` | Cambiar contraseña |
| GET/POST | `/vehicle-types` | Listar / crear tipos de vehículo |
| PATCH/DELETE | `/vehicle-types/:id` | Actualizar (nombre, activo) / eliminar (409 si está en uso) |
| GET/POST | `/requirements` | Documentos exigibles configurables (aplican a chofer o vehículo) |
| PATCH/DELETE | `/requirements/:id` | Actualizar / eliminar (409 si tiene documentos) |
| GET/POST | `/benefits` | Catálogo de beneficios del gremio |
| PATCH/DELETE | `/benefits/:id` | Actualizar / eliminar (409 si pertenece a una membresía) |
| GET | `/settings` | Configuración de la plataforma (claves nacen por migración) |
| PATCH | `/settings/:key` | Actualizar el valor de una clave existente |
| GET/POST | `/memberships` | Historial de versiones / crear la primera membresía |
| GET | `/memberships/current` | Versión vigente con sus beneficios |
| PUT | `/memberships/current` | Editar con versionado condicional (in place o réplica automática) |
| GET/POST | `/subscription-plans` | Catálogo de tarifas |
| PUT | `/subscription-plans/:id` | Editar con versionado condicional |
| PATCH | `/subscription-plans/:id/active` | Archivar / reactivar un plan |
| GET/POST | `/drivers` (+subrutas) | Afiliados: wizard 4 pasos, aprobar/rechazar, renovación de tarifa — ver [docs/api/endpoints.md](docs/api/endpoints.md) |

**Facturación:** numeración continua con secuencia global única, sin reinicio anual.
Todo cobro emite factura; los reembolsos anulan con rastro. **Tarifas:** vencen a las
00:00 (`business_timezone`); el scheduler suspende de inmediato al vencer y la renovación
reactiva automáticamente. Estado completo del proyecto: [docs/roadmap.md](docs/roadmap.md).

Primer admin: `npm run seed:admin` (imprime la contraseña generada una sola vez).
