# Arquitectura del sistema

> Actualizado: 2026-07-16

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
src/plugins/subscription-scheduler.ts
                      Job del ciclo de vida de tarifas (cada 60 s y al arrancar): consume
                      adelantos, expira suscripciones sin cobertura (suspensión inmediata,
                      gracia configurable) y audita con actor "sistema".
src/plugins/storage.ts     Proveedor de archivos configurado (`app.storage`); null si no hay
                      credenciales → las subidas responden 503 y el resto funciona.
src/storage/          Abstracción de almacenamiento: `StorageProvider` (interfaz + límites)
                      y `SupabaseStorageProvider` (REST + fetch nativo, sin SDK). Cambiar de
                      proveedor = otra implementación + configuración; nada más se entera.
src/plugins/document-scheduler.ts
                      Job de vencimiento de documentos (misma cadencia): marca `expired`
                      los documentos cuya fecha pasó (medianoche en tz de negocio) y
                      audita con actor "sistema". El vencimiento alerta, no bloquea.
src/plugins/debt-scheduler.ts
                      Motor de deuda y penalización (diseño v8, Fase B). **Interruptor
                      maestro `debt_engine_enabled` (false por defecto): mientras esté
                      apagado no hace nada y el cobro sigue siendo el prepago actual.**
                      Alcance: solo planes semanales. Emite el cargo de la semana
                      siguiente (`pending`, sin factura: la factura se emite al cobrar),
                      marca `overdue` las semanas ya arrancadas sin pagar y **deriva** el
                      estado del chofer (0 = approved · 1..tope = overdue · >tope =
                      penalized). Un penalizado no recibe cargos nuevos: la deuda queda
                      congelada en el tope. Emite la **multa** (`charge_kind='penalty'`)
                      en la transición a penalizado — una por episodio — y gestiona la
                      **reactivación diferida** (`drivers.reactivates_at`: en modo `auto`
                      el que saldó vuelve el lunes siguiente). Exporta `runDebtEngineTick`
                      para poder ejercitarlo sin esperar al timer.
src/plugins/notification-dispatcher.ts
                      Despachador del **buzón de salida** de avisos (2026-08-20). El aviso lo
                      escribe `writeNotification` DENTRO de la transacción del hecho que
                      anuncia; este job es el único que lo convierte en push, fuera de banda.
                      **Dos candados**, porque prod y dev comparten la BD: no programa
                      siquiera el timer fuera de `NODE_ENV=production` (un backend local
                      sencillamente no tiene despachador) y respeta el interruptor
                      `notifications_enabled` (false por defecto), leído en cada tick.
                      Reclama el lote con `FOR UPDATE SKIP LOCKED` en una transacción, sin
                      estado `sending`: un caído hace ROLLBACK a `pending` en vez de dejar
                      filas encalladas. Exporta `runNotificationDispatchTick`.
src/plugins/email.ts  Proveedor de correo (`app.email`). NUNCA null: sin credenciales queda
                      el enviador de mentira, así que la API arranca igual. `app.emailConfigured`
                      dice si el correo SALE de verdad; la recuperación de clave lo consulta y
                      se niega de frente en producción en vez de prometer un correo que solo
                      llegó a un log.
src/email/            Abstracción de correo: `EmailSender` (interfaz), `LogEmailSender` (deja
                      rastro, no envía), `ResendEmailSender` (REST + fetch, sin SDK),
                      `GmailApiEmailSender` (Gmail por HTTPS con OAuth2 — **lo que usa
                      producción**, porque Railway bloquea el SMTP saliente),
                      `SmtpEmailSender` (nodemailer — el único sitio donde el proyecto toma
                      una librería de protocolo, porque SMTP no es un POST; en uso hoy contra
                      Gmail mientras no haya dominio propio) y
                      `email-templates.ts` (la redacción de los correos en un solo sitio, mismo
                      principio que el catálogo de avisos). Solo lo usa la recuperación de clave
                      del canal de la app. Mismo patrón que `StorageProvider`.
src/notifications/    Abstracción de push: `PushSender` (interfaz) y `LogPushSender` (deja
                      rastro, no envía). Firebase es la última fase a propósito — todo el
                      sistema funciona sin él. Mismo patrón que `StorageProvider`.
src/modules/notifications/
                      `notification-writer.ts` (única puerta de escritura; `notify` recibe
                      el CLIENTE de la transacción del hecho) y `notification-messages.ts`
                      (la redacción de los 15 avisos, en un solo sitio: los servicios dicen
                      QUÉ pasó, el catálogo cómo se lee). Quien emite cada aviso: el motor
                      de deuda (cobro, recordatorio, mora, penalización, reactivación), el
                      repositorio de pagos (recibido/aprobado/rechazado), `applications.
                      service` (solicitud), `documents.service` y `drivers.service`
                      (documento, vehículo e inicio de tarifa).
src/app.ts            Ensambla todo (testeable sin puerto). src/server.ts es el entrypoint.
```

**Seguridad:** contraseñas con argon2id · bloqueo tras 5 intentos fallidos (15 min) · JWT de
8 h · validación estricta de entrada en cada endpoint (`additionalProperties: false`) ·
mensajes de negocio en español listos para UI · helmet + CORS restringido · archivos en
bucket **privado**: subida solo vía backend con validación por contenido (magic number) y
lectura con URL firmada de 60 s.

## Frontend — `edv-route-admin`

Angular 22 standalone (sin NgModules), zoneless, con signals. Tailwind CSS 4 + Flowbite para
UI, tema de marca EDV en `src/styles.css`.

```
src/app/
├── core/          Singletons: AuthService, interceptor JWT, guards, modelos (contratos de la API)
├── shared/        Reutilizables sin estado. components/: select (desplegable de marca con
│                  teclado + ARIA, ControlValueAccessor), password-input (ojo mostrar/ocultar).
│                  directives/: password-policy (validador de contraseña reactivo)
├── features/      Un directorio por pantalla de dominio, lazy-loaded por ruta
└── layouts/       Shells: main-layout (navbar + sidebar), login standalone
```

Reglas: `core` nunca importa de `features` · `shared` no tiene estado · cada feature se carga
perezosamente desde `app.routes.ts` · ningún archivo supera las 1000 líneas.

**Formularios (patrón obligatorio):** Angular añade `novalidate` a todo `<form>` con
`FormsModule`, así que el `required` nativo no avisa por sí solo. Cada formulario usa
`#f="ngForm"` + `markAllAsTouched()` al enviar; una regla global en `styles.css` pinta
`.ng-invalid.ng-touched` en rojo (incluidos los controles propios, que llevan `ng-*` en el
host); el error se muestra **junto al botón**, nunca arriba. Los desplegables usan
`shared/components/select`, nunca `<select>` nativo (solo se puede estilizar cerrado).

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
- **Archivos**: Supabase Storage tras la interfaz `StorageProvider` (decisión 2026-07-15);
  la BD guarda solo la referencia, nunca el binario.
- **Registro de afiliado transaccional** (decisión 2026-07-21): el alta es un wizard de
  **4 pasos** (datos → documentos → vehículo → pago) que **acumula en el cliente** y envía un
  único `POST /drivers/register`. El servicio crea identidad + vehículos + metadatos de
  documentos + (si hay pago) membresía + tarifa en **una sola transacción** vía el helper
  `withTransaction` (`src/db/tx.ts`): los repositorios `drivers` y `enrollment` escriben sobre
  el mismo `client`, así todo persiste o nada, nunca a medias. Los **archivos** de documentos se
  suben después (best-effort, contra los ids devueltos). Flota y documentos son datos vivos:
  también se gestionan desde el perfil.
- **Verificación de pagos (v9, 2026-08-03)**: ningún cobro se liquida en el acto. El módulo
  `payment-submissions` recibe un "envío" (`payment_submissions`, estado `pending`) con su
  comprobante (1..5 imágenes); un admin lo **aprueba** — la liquidación se despacha por `purpose`
  (saldar deuda / adelantar N semanas / alta con membresía) y **emite la factura** — o lo
  **rechaza** (con rastro). Así el **alta con pago** ahora registra la deuda + un envío pendiente
  en vez de cobrar directo, y el **motor de deuda se congela** mientras hay un envío en revisión.
  Contrato para la app del chofer: `docs/proposals/pagos-aprobacion`.
