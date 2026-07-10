# Esquema de base de datos — Referencia completa

> **Estructura física implementada** (verificada contra la base de datos el 2026-07-10).
> Fuente de verdad ejecutable: las migraciones en `src/db/migrations/`. Modelos TypeScript
> generados: `src/db/models/` (regenerar con `npm run db:types` tras cada migración).
> Diseño conceptual y decisiones: [database-design-v7.md](database-design-v7.md).

**17 tablas** en 6 dominios + 1 tabla interna (`pgmigrations`, control de node-pg-migrate).

## Convenciones globales

- **PKs**: `uuid` con `gen_random_uuid()` para entidades de negocio; `integer/smallint IDENTITY` para catálogos; `bigint IDENTITY` para logs.
- **Timestamps**: `created_at` en todas (`now()`); `updated_at` mantenida por el trigger `set_updated_at()` (`BEFORE UPDATE`).
- **Dinero**: `numeric(10,2)` en USD, siempre con `CHECK >= 0`. Pagos y facturas **congelan** el monto (snapshot) — no cambian si el catálogo cambia.
- **Nunca se borra dinero**: pagos y facturas se reembolsan/anulan con rastro (quién y cuándo); jamás `DELETE`.
- **FKs a `admins`** de trazabilidad (`created_by`, `registered_by`...): `ON DELETE SET NULL` — el histórico sobrevive a la cuenta.
- **Enums nativos de PostgreSQL** para todos los estados (lista completa al final).

---

## Dominio 1 — Identidad y acceso

### `admins` — cuentas del panel (auth propia)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `username` | text | no | — | **UNIQUE**. Login del panel. CHECK: siempre minúsculas |
| `email` | text | sí | — | UNIQUE. Solo contacto (no se usa para login) |
| `full_name` | text | no | — | Nombre completo |
| `password_hash` | text | no | — | Hash **argon2id**. Jamás sale de la capa de auth |
| `role` | text | no | `'admin'` | Un solo nivel por ahora |
| `status` | admin_status | no | `'active'` | `active` \| `suspended` |
| `failed_login_attempts` | integer | no | `0` | Contador para el lockout |
| `locked_until` | timestamptz | sí | — | Bloqueo temporal (5 fallos → 15 min) |
| `last_login_at` | timestamptz | sí | — | Último acceso exitoso |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL). Quién creó la cuenta |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

Reglas: un admin no puede suspenderse a sí mismo (regla de servicio). Los admins nunca se
eliminan: se suspenden.

### `users` — identidad pura de usuarios de las apps

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK **propia** (no depende de Supabase Auth) |
| `auth_user_id` | uuid | sí | — | UNIQUE. Vínculo futuro con Supabase Auth (integración pospuesta — modo prueba) |
| `full_name` | text | no | — | — |
| `email` | text | sí | — | UNIQUE |
| `phone` | text | sí | — | — |
| `photo_url` | text | sí | — | Supabase Storage (futuro) |
| `status` | user_status | no | `'active'` | `active` \| `suspended` |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

`users` es identidad **pura**: los roles viven en tablas de extensión (`drivers` hoy;
`clients` llegará con el módulo de viajes). Una misma cuenta podrá ser ambos.

---

## Dominio 2 — Afiliados y flota

### `drivers` — extensión rol chofer ("Afiliado" en pantalla)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `user_id` | uuid | no | — | **PK y FK** → `users.id` (CASCADE). Relación 1:1 |
| `national_id` | text | sí | — | UNIQUE. Cédula. **Obligatoria solo al registrarse desde la app**; opcional por panel (decisión 2026-07-10) |
| `status` | driver_status | no | `'pending'` | `pending` \| `approved` \| `rejected` \| `suspended` |
| `source` | driver_source | no | — | `app` \| `admin` — de dónde nació el registro |
| `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL). Null = se registró desde la app |
| `registration_step` | smallint | sí | — | Paso del wizard (1-4). **Null = wizard completado** |
| `current_vehicle_id` | uuid | sí | — | FK → `vehicles.id` (SET NULL). Vehículo "actual" |
| `is_available` | boolean | no | `false` | Disponible para viajes (módulo futuro) |
| `avg_rating` | numeric(3,2) | sí | — | Reputación (módulo futuro) |
| `rating_count` | integer | no | `0` | — |
| `cancel_count` | integer | no | `0` | Cancelaciones acumuladas |
| `contract_url` | text | sí | — | Contrato de afiliación firmado (Storage, futuro) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

Ciclo de vida: `pending` → (aprobar, **exige pagos**) → `approved` ⇄ `suspended`, o
`pending` → (rechazar, **doble reembolso + facturas anuladas**) → `rejected`.

### `vehicles` — vehículos del afiliado

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (CASCADE) |
| `vehicle_type_id` | smallint | sí | — | FK → `vehicle_types.id`. **Nullable** (decisión: tipo sin definir permitido) |
| `brand` / `model` / `color` | text | sí | — | — |
| `year` | smallint | sí | — | — |
| `plate` | text | sí | — | UNIQUE. Se normaliza a mayúsculas en el backend |
| `approval_status` | vehicle_approval | no | `'pending'` | `pending` \| `approved` \| `rejected`. Por panel nace `approved` |
| `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

### `vehicle_types` — catálogo de flota

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | smallint IDENTITY | no | — | PK |
| `name` | text | no | — | UNIQUE. Seed: `moto`, `carro`, `camioneta` |
| `active` | boolean | no | `true` | Desactivar en lugar de borrar si está en uso |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

### `requirements` — documentos exigibles configurables

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK |
| `name` | text | no | — | UNIQUE junto con `applies_to` (mismo nombre puede existir para chofer y para vehículo) |
| `description` | text | sí | — | — |
| `applies_to` | requirement_applies_to | no | — | `driver` \| `vehicle` |
| `is_required` | boolean | no | `false` | ⚠️ **Solo bloquea el registro desde la app.** El registro por panel nunca se bloquea por documentos |
| `active` | boolean | no | `true` | — |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

### `documents` — documentos consignados contra un requerimiento

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `requirement_id` | integer | no | — | FK → `requirements.id` (RESTRICT: no se borra un requerimiento con documentos) |
| `driver_id` | uuid | sí | — | FK → `drivers.user_id` (CASCADE) |
| `vehicle_id` | uuid | sí | — | FK → `vehicles.id` (CASCADE) |
| `file_url` | text | sí | — | Supabase Storage (subida real pospuesta — se registran metadatos) |
| `expires_at` | date | sí | — | Vencimiento (alimentará las alertas del panel) |
| `status` | document_status | no | `'valid'` | `valid` \| `expired` \| `rejected` |
| `uploaded_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

**CHECK `documents_exactly_one_owner`**: `(driver_id IS NULL) <> (vehicle_id IS NULL)` —
todo documento pertenece a exactamente un dueño (chofer **o** vehículo, nunca ambos/ninguno).

---

## Dominio 3 — Membresía

### `memberships` — LA membresía (versionado condicional)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK = número de versión |
| `name` | text | no | — | — |
| `description` | text | sí | — | — |
| `price_usd` | numeric(10,2) | no | — | CHECK ≥ 0. Pago **único vitalicio** |
| `active` | boolean | no | `true` | Solo una versión activa (ver índice) |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

**Índice único parcial `memberships_single_active`** (`ON ((1)) WHERE active`): garantía
física de **máximo una versión vigente** en toda la plataforma.

**Versionado condicional**: editar la vigente sin pagos → in place; con pagos → se archiva
(`active = false`) y se crea una réplica activa con copia de beneficios. El miembro conserva
el precio y los beneficios de la versión que pagó.

### `membership_benefits` — beneficios de cada versión

| Columna | Tipo | Null | Descripción |
|---|---|---|---|
| `membership_id` | integer | no | FK → `memberships.id` (CASCADE). Parte de la **PK compuesta** |
| `benefit_id` | integer | no | FK → `benefits.id` (RESTRICT). Parte de la **PK compuesta** |

### `benefits` — catálogo de beneficios del gremio

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK |
| `name` | text | no | — | UNIQUE |
| `description` | text | sí | — | — |
| `active` | boolean | no | `true` | — |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

### `membership_payments` — el pago único por chofer

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (RESTRICT) |
| `membership_id` | integer | no | — | FK → `memberships.id` (RESTRICT). **La versión pagada** |
| `invoice_id` | uuid | sí | — | FK → `invoices.id` (RESTRICT) |
| `amount_usd` | numeric(10,2) | no | — | Snapshot del precio al pagar |
| `status` | membership_payment_status | no | `'pending'` | `pending` \| `paid` \| `refunded` |
| `paid_at` / `refunded_at` | timestamptz | sí | — | — |
| `refunded_by` / `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` | timestamptz | no | `now()` | — |

**Índice único parcial `membership_payments_one_valid_per_driver`**
(`ON (driver_id) WHERE status <> 'refunded'`): un chofer solo puede tener **un pago de
membresía no reembolsado** — "ser miembro" se deriva de la existencia de un pago `paid`.

---

## Dominio 4 — Tarifas (suscripción prepago)

### `subscription_plans` — catálogo de tarifas (versionado condicional)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK = versión del plan |
| `name` | text | no | — | — |
| `description` | text | sí | — | — |
| `billing_period` | billing_period | no | — | `daily` \| `weekly` \| `monthly` \| `annual` |
| `price_usd` | numeric(10,2) | no | — | CHECK ≥ 0. Precio por período |
| `allowed_vehicle_types` | smallint[] | sí | — | Ids de `vehicle_types`. **Null = todos** (el backend normaliza `[]` → null). Validado en servicio (los arrays no soportan FK) |
| `active` | boolean | no | `true` | Archivado = fuera del catálogo (no se renueva a él) |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

Mismo versionado condicional que `memberships` (sin tabla hija de beneficios).

### `driver_subscriptions` — la tarifa contratada por el chofer

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (RESTRICT) |
| `plan_id` | integer | no | — | FK → `subscription_plans.id` (RESTRICT). Versión contratada |
| `status` | subscription_status | no | `'pending_payment'` | `pending_payment` \| `active` \| `scheduled` \| `expired` \| `cancelled` |
| `started_at` | timestamptz | sí | — | La del wizard queda `scheduled` y arranca **al aprobar** al afiliado |
| `current_period_start` / `current_period_end` | timestamptz | sí | — | Ventana del período vigente |
| `cancelled_at` | timestamptz | sí | — | — |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

**Índices únicos parciales**: `driver_subscriptions_one_active` (una `active` por chofer) y
`driver_subscriptions_one_scheduled` (máx. una `scheduled` por chofer) — garantía física.

### `subscription_payments` — pagos por período (adelanto ×N = N filas)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_subscription_id` | uuid | no | — | FK → `driver_subscriptions.id` (RESTRICT) |
| `invoice_id` | uuid | sí | — | FK → `invoices.id` (RESTRICT) |
| `period_start` / `period_end` | timestamptz | no | — | Ventana **exacta** que cubre este pago. Al aprobar al afiliado se re-anclan consecutivamente desde ese momento |
| `amount_usd` | numeric(10,2) | no | — | Snapshot |
| `status` | subscription_payment_status | no | `'pending'` | `pending` \| `paid` \| `overdue` \| `refunded` |
| `paid_at` / `refunded_at` | timestamptz | sí | — | — |
| `refunded_by` / `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` | timestamptz | no | `now()` | — |

Adelanto ×N: N filas `paid` con períodos consecutivos. Adelantos no consumidos de un
afiliado operativo **no son reembolsables** (⚠️ debe constar en el contrato); los de un
aspirante rechazado sí (rechazo = reembolso registrado).

---

## Dominio 5 — Facturación interna

### `invoices` — comprobante interno de cada cobro

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `invoice_number` | bigint | no | `nextval('invoice_number_seq')` | UNIQUE. **Numeración continua global, sin reinicio anual** (decisión 2026-07-10) |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (RESTRICT) |
| `issued_at` | timestamptz | no | `now()` | — |
| `total_usd` | numeric(10,2) | no | — | Snapshot del total del documento |
| `status` | invoice_status | no | `'issued'` | `issued` \| `voided` |
| `voided_at` | timestamptz | sí | — | — |
| `voided_by` / `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` | timestamptz | no | `now()` | — |

- La factura **agrupa pagos**: sus "líneas" son los pagos que la referencian vía `invoice_id`.
  En el wizard, la **factura #1 = membresía + primer período de tarifa**; cada período
  adelantado adicional emite su propia factura.
- **Anulación con rastro**: el reembolso marca `voided` (fecha + admin) y **conserva el
  número** — sin huecos en la numeración.
- Es un comprobante **interno, no fiscal** (⚠️ la facturación SENIAT es un análisis aparte).
- Secuencia dedicada: `invoice_number_seq` (bigint, arranca en 1).

---

## Dominio 6 — Plataforma

### `app_settings` — configuración clave/valor

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `key` | text | no | — | PK. **Las claves nacen por migración, nunca por API** |
| `value` | jsonb | no | — | — |
| `description` | text | sí | — | — |
| `updated_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `updated_at` | timestamptz | no | `now()` | — |

Seed actual: `subscription_grace_hours = 24` (horas de gracia tras vencer la tarifa antes
de la suspensión automática del afiliado).

### `audit_logs` — bitácora de acciones

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | bigint IDENTITY | no | — | PK |
| `actor_admin_id` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `actor_user_id` | uuid | sí | — | FK → `users.id` (SET NULL) |
| `event_type` | text | no | — | Ej.: `driver.created`, `driver.approved`, `driver.rejected`, `driver.enrolled`, `vehicle.registered`, `document.registered`, `driver.updated` |
| `entity` | text | no | — | Tabla/entidad afectada |
| `entity_id` | text | sí | — | Id de la entidad (texto para admitir cualquier tipo de PK) |
| `data` | jsonb | sí | — | Contexto del evento |
| `created_at` | timestamptz | no | `now()` | — |

**CHECK `audit_logs_max_one_actor`**: como máximo un actor (admin **o** usuario).
Índices: `(entity, entity_id)` y `(created_at)`.

---

## Enums (tipos nativos de PostgreSQL)

| Enum | Valores |
|---|---|
| `admin_status` | `active`, `suspended` |
| `user_status` | `active`, `suspended` |
| `driver_status` | `pending`, `approved`, `rejected`, `suspended` |
| `driver_source` | `app`, `admin` |
| `vehicle_approval` | `pending`, `approved`, `rejected` |
| `requirement_applies_to` | `driver`, `vehicle` |
| `document_status` | `valid`, `expired`, `rejected` |
| `billing_period` | `daily`, `weekly`, `monthly`, `annual` |
| `subscription_status` | `pending_payment`, `active`, `scheduled`, `expired`, `cancelled` |
| `membership_payment_status` | `pending`, `paid`, `refunded` |
| `subscription_payment_status` | `pending`, `paid`, `overdue`, `refunded` |
| `invoice_status` | `issued`, `voided` |

## Garantías físicas destacadas (imposibles de violar desde el código)

| Garantía | Mecanismo |
|---|---|
| Una sola versión de membresía vigente | Índice único parcial `memberships_single_active` |
| Un pago de membresía válido por chofer | Índice único parcial `membership_payments_one_valid_per_driver` |
| Una tarifa activa + máx. una programada por chofer | Índices únicos parciales en `driver_subscriptions` |
| Todo documento tiene exactamente un dueño | CHECK `documents_exactly_one_owner` |
| Números de factura únicos y sin reinicio | Secuencia `invoice_number_seq` + UNIQUE |
| Auditoría con máximo un actor | CHECK `audit_logs_max_one_actor` |
| Usernames de admin en minúsculas | CHECK `admins_username_lowercase` |

## Tablas futuras (diseñadas, no implementadas)

Del modelo v7 quedan pendientes para los módulos siguientes: `clients`, `trip_requests`,
`trip_offers`, `trips`, `trip_route_points`, `ratings`, `fare_rules`, `time_multipliers`,
`device_tokens`, `notifications`, `push_campaigns`, `service_areas`, `benefit_requests`,
`support_tickets`, `trainings`, `training_attendees`. Ver
[database-design-v7.md](database-design-v7.md).
