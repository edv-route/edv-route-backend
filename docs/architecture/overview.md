# Arquitectura del sistema

> Actualizado: 2026-07-10

## Visión general

```
Apps móviles (Capacitor, futuro)  ─┐
                                   ├──►  Backend Node.js + Fastify  ──►  PostgreSQL + PostGIS
Panel admin (Angular, este repo)  ─┘     (REST, único punto de entrada)   (alojado en Supabase)
```

**Regla de oro:** ninguna aplicación toca la base de datos directamente. Todo pasa por la API
Fastify, que es la única capa con credenciales de base de datos. Supabase se usa solo como
infraestructura (Postgres gestionado; más adelante Auth como proveedor de identidad y Storage
para archivos) — la Data API de Supabase está deshabilitada a propósito.

## Backend — `edv-route-backend`

**Metodología:** arquitectura en capas organizada por **módulos de dominio**. Cada módulo es
una carpeta autocontenida en `src/modules/` que representa un área del negocio (afiliados,
membresía, tarifas...) y tiene hasta 4 archivos con responsabilidades separadas:

```
src/modules/<dominio>/
├── <dominio>.routes.ts       CAPA 1 · Endpoints HTTP: define las URLs, valida entrada y
│                             salida con JSON Schema, y delega. No contiene lógica.
├── <dominio>.schemas.ts      Los esquemas de validación usados por routes.
├── <dominio>.service.ts      CAPA 2 · Reglas de negocio: "no puedes suspenderte a ti mismo",
│                             "editar con pagos crea una versión nueva", etc.
└── <dominio>.repository.ts   CAPA 3 · Acceso a datos: el ÚNICO lugar con SQL. Define también
                              las interfaces TypeScript de lo que devuelve cada consulta.
```

En términos de MVC clásico: `routes` = Controller, `service` + `repository` = Model (partido
en negocio y persistencia), y la View es el JSON serializado. **No usamos ORM**: escribimos
SQL directo con el driver `pg` para tener control total (PostGIS, índices parciales,
transacciones), y el esquema real vive en las **migraciones versionadas**
(`src/db/migrations/`, aplicadas con node-pg-migrate).

**Modelos por tabla:** `src/db/models/` contiene una interfaz TypeScript por cada tabla
(equivalente a las entidades/POJOs de un ORM), **generadas automáticamente desde la base de
datos real** con [Kanel](https://kanel.dev) — nunca se editan a mano. Tras cada migración se
regeneran con `npm run db:types`, así es imposible que mientan. Los repositorios derivan sus
tipos de esas filas (`Camelize<Admins>`, `Pick<...>`, `Omit<...>`) en `src/db/case-types.ts`
está el helper que convierte snake_case (BD) a camelCase (API) a nivel de tipos.

Piezas transversales:

```
src/config/env.ts     Carga y valida las variables de entorno; el server no arranca si falta algo.
src/plugins/db.ts     Pool de conexiones a Postgres (verifica conectividad al arrancar).
src/plugins/auth.ts   JWT: firma, verificación y el guard `authenticate` de rutas privadas.
src/app.ts            Ensambla todo (testeable sin puerto). src/server.ts es el entrypoint.
```

**Seguridad:** contraseñas con argon2id · bloqueo tras 5 intentos fallidos (15 min) · JWT de
8 h · validación estricta de entrada en cada endpoint (`additionalProperties: false`) ·
mensajes de negocio en español listos para UI · helmet + CORS restringido.

## Frontend — `edv-route-admin`

Angular 22 standalone (sin NgModules), zoneless, con signals. Tailwind CSS 4 + Flowbite para
UI, tema de marca EDV en `src/styles.css`.

```
src/app/
├── core/          Singletons: AuthService, interceptor JWT, guards, modelos (contratos de la API)
├── shared/        Componentes/pipes/directivas reutilizables sin estado
├── features/      Un directorio por pantalla de dominio, lazy-loaded por ruta
└── layouts/       Shells: main-layout (navbar + sidebar), login standalone
```

Reglas: `core` nunca importa de `features` · `shared` no tiene estado · cada feature se carga
perezosamente desde `app.routes.ts` · ningún archivo supera las 1000 líneas.

## Flujo de una petición (ejemplo: aprobar un afiliado)

1. El admin pulsa "Aprobar" → `DriversApi.approve()` hace `POST /api/v1/drivers/:id/approve`.
2. El **interceptor** añade `Authorization: Bearer <token>`.
3. En el backend, el guard `authenticate` verifica el JWT.
4. `drivers.routes.ts` valida el parámetro y llama a `drivers.service.ts`.
5. El service aplica las reglas (estado pendiente + pagos registrados) y llama al repository.
6. `enrollment.repository.ts` ejecuta la transacción SQL (activar suscripción, re-anclar períodos).
7. El service registra el evento en `audit_logs` y responde; Angular refresca la vista.

## Decisiones estructurales clave

- **Costos**: sin APIs pagas en desarrollo (PostGIS para distancias, OSM para mapas, FCM para push).
- **Moneda dual**: tarifas ancladas en USD; los viajes congelarán la tasa Bs del momento.
- **Facturación interna**: todo cobro emite factura (comprobante no fiscal) con numeración
  continua global; los reembolsos anulan con rastro (`voided`), nunca borran.
- **Integración Supabase Auth**: pospuesta (modo prueba). `users.id` es propio; existe
  `users.auth_user_id` para vincular después sin migrar claves.
