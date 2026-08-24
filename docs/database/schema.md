# Esquema de base de datos — Referencia completa

> **Estructura física implementada** (verificada contra la base de datos el 2026-07-10).
> Fuente de verdad ejecutable: las migraciones en `src/db/migrations/`. Modelos TypeScript
> generados: `src/db/models/` (regenerar con `npm run db:types` tras cada migración).
> Diseño conceptual y decisiones: [database-design-v7.md](database-design-v7.md).

**20 tablas** en 7 dominios + la vista `v_driver_payments` + 1 tabla interna
(`pgmigrations`, control de node-pg-migrate).

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
| `first_name` / `last_name` | text | no | — | Primer nombre y primer apellido (2026-07-16) |
| `middle_name` / `second_last_name` | text | sí | — | Segundo nombre y segundo apellido |
| `full_name` | text | no | — | **Compuesto por el backend** en cada escritura (`concat` de las 4 partes); lo consumen todos los listados/auditoría/facturas sin cambios |
| `birth_date` | date | sí | — | El backend exige **≥ 18 años** al escribirla |
| `address` | text | sí | — | Dirección de domicilio |
| `email` | text | sí | — | UNIQUE. **Obligatorio en la API desde 2026-08-24** (canal de recuperación de clave): el registro lo exige en los dos canales y ninguna edición puede vaciarlo. La columna sigue nullable por los registros previos a esa fecha |
| `phone` | text | sí | — | Canónico **E.164** (`+58…`), compuesto por el backend |
| `password_hash` | text | sí | — | **Login de la app**: usuario = `national_id` + esta contraseña (argon2id, mínimo 6, admite solo números). NULL = aún no puede entrar a la app (el panel ya la exige al registrar; nullable por los registros previos y el flujo futuro de la app) |
| `photo_url` | text | sí | — | Supabase Storage (futuro) |
| `status` | user_status | no | `'active'` | `active` \| `suspended` |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

`users` es identidad **pura**: los roles viven en tablas de extensión (`drivers` hoy;
`clients` llegará con el módulo de viajes). Una misma cuenta podrá ser ambos.
`drivers.national_id` guarda el documento canónico `V-12345678` (tipo + número se separan
solo en la UI). Tipos: **V** (venezolano), **E** (extranjero), **J** (jurídico/RIF).

---

## Dominio 2 — Afiliados y flota

### `drivers` — extensión rol chofer ("Afiliado" en pantalla)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `user_id` | uuid | no | — | **PK y FK** → `users.id` (CASCADE). Relación 1:1 |
| `national_id` | text | sí | — | UNIQUE. Cédula. **Obligatoria solo al registrarse desde la app**; opcional por panel (decisión 2026-07-10) |
| `status` | driver_status | no | `'pending'` | `applicant` (solicitud de la app en revisión, 2026-08-11) \| `pending` \| `scheduled` \| `approved` \| `rejected` \| `suspended` \| `paused` (licencia administrativa, 2026-07-23; `scheduled` = aprobado que inicia el próximo lunes, 2026-08-09) |
| `source` | driver_source | no | — | `app` \| `admin` — de dónde nació el registro |
| `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL). Null = se registró desde la app |
| `registration_step` | smallint | sí | — | Paso del wizard (1-4). **Null = wizard completado** |
| `current_vehicle_id` | uuid | sí | — | FK → `vehicles.id` (SET NULL). Vehículo "actual" |
| `is_available` | boolean | no | `true` | **Plano de disponibilidad** (`active`/`inactive`): lo gestiona el chofer desde su app; `true` = recibe viajes. Default `true` (al aprobar queda disponible). **No** congela la tarifa: un inactivo sigue acumulando deuda (2026-07-23) |
| `avg_rating` | numeric(3,2) | sí | — | Reputación (módulo futuro) |
| `rating_count` | integer | no | `0` | — |
| `cancel_count` | integer | no | `0` | Cancelaciones acumuladas |
| `contract_url` | text | sí | — | Contrato de afiliación firmado (Storage, futuro) |
| `paused_at` | timestamptz | sí | — | Cuándo empezó la pausa administrativa; al reanudar, la tarifa corre por ese lapso (congelamiento). NULL = no está en pausa (2026-07-23) |
| `reactivates_at` | timestamptz | sí | — | **Motor de deuda (v8)**: momento en que un `penalized` que ya saldó vuelve a operar (`reactivation_mode = auto` → lunes siguiente). El admin puede adelantarlo con `/reactivate`. NULL = nada pendiente |
| `accepted_privacy_at` | timestamptz | sí | — | Consentimiento de la política de privacidad; se sella al enviar la solicitud desde la app (paso 1). NULL = no aceptada (2026-08-11) |
| `accepted_terms_at` | timestamptz | sí | — | Consentimiento de términos y condiciones; se sella al pagar desde la app. NULL = no aceptados (2026-08-11) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | — |

Ciclo de vida: `pending` → (aprobar, **exige pagos**) → `approved` (queda `is_available = true`)
⇄ `suspended`; `approved` ⇄ `paused` (licencia administrativa, exige tarifa al día, **congela**
la tarifa); o `pending` → (rechazar, **doble reembolso + facturas anuladas**) → `rejected`.

> 📱 **Canal app — solicitud (2026-08-11)**: un registro desde la app nace `applicant`
> (solicitud, no afiliado); al aprobar su documentación pasa **directo a `approved` con deuda
> base** (membresía + 1 semana) — este canal **no** exige deuda 0 para aprobar. Ver
> [proposals/solicitudes-app/](../proposals/solicitudes-app/README.md).

> 📋 **Rediseño del estado del chofer — modelo cerrado 2026-07-23 (`driver_status` +
> `is_available`)**. **Fase A implementada** (migración `1752250000000`): el enum incorpora
> **`paused`** (licencia administrativa: la pone el admin, exige tarifa al día, congela la
> tarifa vía `paused_at`) y `is_available` pasa a ser el plano de *disponibilidad* voluntaria
> del chofer (`active`/`inactive`, default `true`). `approved` **permanece** como estado sano
> base (badge visible, no interno) y `suspended` se reserva para la expulsión. **Fase B en
> curso**: **B1 (2026-07-23)** ya añadió **`overdue`** y **`penalized`** al enum y las claves
> de configuración del motor (arriba), **sin lógica que los dispare** — el motor de mora que
> los deriva (**B2**) está pendiente y ligado a la propuesta de tarifa-penalización. Espec:
> [proposals/estados-del-chofer/](../proposals/estados-del-chofer/README.md) ·
> [análisis v8](../proposals/tarifa-penalizacion/analisis-impacto-v8.md).

### `vehicles` — vehículos del afiliado

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (CASCADE) |
| `vehicle_type_id` | smallint | sí | — | FK → `vehicle_types.id`. **Nullable** (decisión: tipo sin definir permitido) |
| `brand` / `model` / `color` | text | sí | — | — |
| `year` | smallint | sí | — | — |
| `plate` | text | sí | — | UNIQUE. Se normaliza a mayúsculas en el backend |
| `approval_status` | vehicle_approval | no | `'pending'` | `pending` \| `approved` \| `rejected`. Por panel nace `approved`; desde la app nace `pending` y lo revisa el admin |
| `rejection_reason` | text | sí | — | Motivo del rechazo, visible al solicitante para corregir y reenviar (2026-08-11) |
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
| `file_url` | text | sí | — | Referencia (path) del archivo en el bucket privado de Supabase Storage; se lee con URL firmada. NULL = documento registrado sin archivo adjunto |
| `expires_at` | date | sí | — | Vencimiento. **Eje de vigencia — inerte desde 2026-08-11** (D10) |
| `status` | document_status | no | `'valid'` | `valid` \| `expired` \| `rejected`. **Eje de vigencia — inerte** (ya no se usa; la revisión vive en `approval_status`) |
| `approval_status` | document_approval | no | `'pending'` | **Eje de revisión**: `pending` \| `approved` \| `rejected`. Desde la app nace `pending`; subido por el admin nace `approved` (autoridad). Los preexistentes se backfillearon a `approved` (2026-08-11) |
| `rejection_reason` | text | sí | — | Motivo del rechazo, visible al solicitante para corregir y reenviar (2026-08-11) |
| `reviewed_by` | uuid | sí | — | FK → `admins.id` (SET NULL). Quién revisó el documento (2026-08-11) |
| `reviewed_at` | timestamptz | sí | — | Cuándo se revisó (2026-08-11) |
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
| `submission_id` | uuid | sí | — | **v9**: FK → `payment_submissions.id` (SET NULL). Envío de pago que reclama este cargo |
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
| `period_start` / `period_end` | timestamptz | **sí** | — | Ventana que cubre este pago. **NULL hasta que se establece el inicio de tarifa** (solicitudes-app 2026-08-11): `enrollOnClient`/`enrollDebtOnClient` crean la semana **sin fechas** y `enrollment.approve` (startTariff) las ancla consecutivas. Antes no existe ninguna fecha de período (solo `created_at`/`paid_at`) |
| `amount_usd` | numeric(10,2) | no | — | Snapshot |
| `status` | subscription_payment_status | no | `'pending'` | `pending` \| `paid` \| `overdue` \| `refunded`. Con el **motor de deuda (v8)**: `pending` = cargo emitido sin pagar (sin factura aún), `overdue` = semana ya arrancada sin pagar = **deuda** |
| `charge_kind` | subscription_charge_kind | no | `'period'` | **v8**: `period` (semana de tarifa) \| `penalty` (multa por incumplimiento). La vista muestra la multa como "Penalización" en vez del nombre del plan |
| `submission_id` | uuid | sí | — | **v9**: FK → `payment_submissions.id` (SET NULL). Envío de pago que reclama este cargo; al aprobar se liquida, al rechazar se desvincula |
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
| `payment_method_id` | integer | sí | — | **Pieza 2**: FK → `payment_methods.id` (SET NULL). Con qué método se pagó |
| `payment_reference` | text | sí | — | **Pieza 2**: nº de referencia/confirmación del pago |
| `payer_bank` | text | sí | — | **Pieza 2**: banco emisor del pago |
| `proof_url` | text | sí | — | **Obsoleto** (rediseño 2026-08-04): el comprobante vive en el recibo (`payment_submission_files`); se conserva para facturas legacy |
| `submission_id` | uuid | sí | — | **Rediseño 2026-08-04** (mig. `1752360000000`): FK → `payment_submissions.id` (SET NULL). Recibo que **generó** esta factura (null = deuda emitida sin recibo: registro sin pago, motor semanal) |
| `created_at` | timestamptz | no | `now()` | — |

- **Rediseño 2026-08-04 (revierte 2026-07-28)**: **una factura por concepto** (membresía, o una
  por semana, o penalización) — su "línea" es el único cargo que la referencia vía `invoice_id`.
  Un **recibo de pago** (`payment_submissions`) cubre **N facturas**. El estado mostrado se deriva
  del único cargo: `issued`/`overdue`/`paid` (físico solo `issued`/`voided`). El pago (método/
  referencia/comprobante) vive en el **recibo**, no en la factura.
- **Anulación con rastro**: el reembolso marca `voided` (fecha + admin) y **conserva el
  número** — sin huecos en la numeración.
- Es un comprobante **interno, no fiscal** (⚠️ la facturación SENIAT es un análisis aparte).
- Secuencia dedicada: `invoice_number_seq` (bigint, arranca en 1).

### `v_driver_payments` — vista: historial unificado de pagos

Read model (migración `1752210000000_driver-payments-view`) que une `membership_payments`
y `subscription_payments` con una forma común para los historiales por afiliado y globales.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | uuid | PK de la tabla origen |
| `driver_id` | uuid | Chofer dueño del pago |
| `kind` | text | `membership` \| `subscription` |
| `concept` | text | Nombre de la membresía o de la tarifa (de su versión) |
| `amount_usd` | numeric(10,2) | — |
| `status` | text | Estados de la tabla origen, casteados a texto |
| `paid_at` / `refunded_at` | timestamptz | — |
| `refunded_by` | uuid | Admin del reembolso (si aplica) |
| `period_start` / `period_end` | timestamptz | Solo tarifas; NULL en membresía |
| `invoice_id` | uuid | Factura que agrupa el pago |
| `created_at` | timestamptz | — |

### `payment_submissions` — envío de pago pendiente de verificación (v9)

Migración `1752340000000_payment-approval-flow`. La **unidad revisable** de dinero-entrante:
un pago que el chofer (o un admin) manda y que un admin aprueba/rechaza antes de contar como
pagado. Contrato: [proposals/pagos-aprobacion](../proposals/pagos-aprobacion/README.md).

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (RESTRICT) |
| `status` | payment_submission_status | no | `'pending'` | `pending` \| `approved` \| `rejected` \| **`reverted`** (mig. `1752360000000`) |
| `submission_number` | bigint | no | `nextval('payment_submission_number_seq')` | **Rediseño 2026-08-04**: UNIQUE, el "N° de pago" (numeración continua propia, como las facturas) |
| `purpose` | text | no | `'debt'` | **v9-2B** (mig. `1752350000000`): `debt` (saldar deuda) \| `advance` (adelantar N semanas) \| `enroll` (alta: membresía + N semanas) \| `change_plan` (cambiar tarifa + prepagar N semanas). CHECK `payment_submissions_purpose_check` acota los valores |
| `context` | jsonb | no | `'{}'` | Parámetros que la aprobación necesita (p. ej. `planId`/`periods`/`planPriceUsd` para advance/enroll) |
| `amount_usd` | numeric(10,2) | no | — | Monto declarado (efectivo: capturado; resto: total de los cargos que cubre) |
| `payment_method_id` | integer | sí | — | FK → `payment_methods.id` (SET NULL) |
| `payment_reference` | text | sí | — | Referencia/confirmación (no aplica a `cash_usd`) |
| `payer_bank` | text | sí | — | Banco emisor (transfer / pago móvil) |
| `paid_on` | date | sí | — | Fecha declarada del pago |
| `payer_phone` / `payer_id` | text | sí | — | Teléfono / cédula del pagador (Pago Móvil) |
| `payer_account` | text | sí | — | Email/nombre origen (Zelle / Binance) |
| `note` | text | sí | — | Constancia opcional |
| `source` | driver_source | no | `'admin'` | `app` \| `admin` (origen del envío) |
| `submitted_by` | uuid | sí | — | FK → `admins.id` (SET NULL). NULL = enviado desde la app |
| `reviewed_by` | uuid | sí | — | FK → `admins.id` (SET NULL). Quién aprobó/rechazó |
| `reviewed_at` | timestamptz | sí | — | — |
| `rejection_reason` | text | sí | — | Motivo del rechazo |
| `reverted_by` | uuid | sí | — | **2026-08-04**: FK → `admins.id` (SET NULL). Quién revirtió el recibo aprobado |
| `reverted_at` | timestamptz | sí | — | **2026-08-04**: cuándo se revirtió |
| `reversal_type` | payment_reversal_type | sí | — | **2026-08-04**: `refund` (reembolso: anula sus facturas) \| `correction` (la deuda saldada vuelve a deber) |
| `reversal_reason` | text | sí | — | **2026-08-04**: motivo de la reversión |
| `invoice_id` | uuid | sí | — | FK → `invoices.id` (RESTRICT). Factura materializada **al aprobar**; NULL mientras pendiente/rechazado |
| `created_at` / `updated_at` | timestamptz | no | `now()` | Trigger `set_updated_at` |

- **Un envío pendiente por chofer** (índice único parcial `payment_submissions_one_pending_per_driver` `WHERE status = 'pending'`).
- Al **aprobar**: cargos vinculados → `paid`, se emite **una** factura y se le copia la metadata del pago. Al **rechazar**: los cargos se desvinculan y el envío queda con su `rejection_reason` (**nunca se borra**).
- El **motor de deuda se congela** mientras haya un envío pendiente que cubre la deuda.

### `payment_submission_invoices` — qué facturas cubre un pago

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `submission_id` | uuid | no | — | FK → `payment_submissions.id` (CASCADE). PK junto a `invoice_id` |
| `invoice_id` | uuid | no | — | FK → `invoices.id` (**RESTRICT**: una factura es dinero, no se borra) |
| `submission_status` | payment_submission_status | no | — | **Copia** del estado del recibo, mantenida por trigger. Nunca se escribe a mano |
| `created_at` | timestamptz | no | `now()` | — |

- **Mig. `1752420000000` (2026-08-18)**: sustituye a `payment_submissions.context->'invoiceIds'`.
  Aquella lista era una clave foránea escondida en un JSON: podía apuntar a una factura inexistente
  y **ninguna restricción podía vigilarla**.
- **La invariante que protege**: desde que se permiten varios pagos en revisión (2026-08-12), *una
  factura la puede reservar como máximo UN pago pendiente*. La impone el índice único parcial
  `payment_submission_invoices_one_pending_per_invoice ON (invoice_id) WHERE submission_status = 'pending'`.
  Antes vivía solo en el código (lock consultivo + re-chequeo), así que cualquier camino de inserción
  nuevo la saltaba sin ruido y cobraba dos veces la misma factura.
- **Por qué se copia el estado**: un índice parcial no puede mirar otra tabla. Dos triggers lo
  mantienen — uno lo copia del recibo al insertar (el llamador no puede mentir) y otro lo sigue
  cuando el recibo cambia de estado, que es lo que **libera la reserva** al aprobar, rechazar o
  revertir.
- **Alcance**: cubre los pagos que **enumeran** sus facturas (pago parcial). Un recibo generador
  (`enroll`/`advance`/`change_plan`) reserva a través de los cargos que crea, que ya llevan un
  `submission_id` con FK real.
- **Expandir/contraer**: prod y dev comparten base y prod aún corre la versión anterior, que lee el
  JSON. La migración solo **añade**; el código nuevo escribe la tabla (fuente de verdad) y mantiene
  el JSON como espejo de compatibilidad. Una migración posterior lo elimina tras desplegar.

---

### `payment_submission_files` — imágenes del envío (1..5)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `submission_id` | uuid | no | — | FK → `payment_submissions.id` (CASCADE) |
| `storage_path` | text | no | — | Ruta en el bucket privado (URL firmada al leer) |
| `position` | smallint | no | `1` | Orden 1..5 |
| `created_at` | timestamptz | no | `now()` | — |

- **De 1 a 5 imágenes** por envío: un comprobante único, o hasta 5 fotos de billetes en `cash_usd`. El límite de 5 se valida en el service.

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

Claves actuales:

| Clave | Seed | Uso |
|---|---|---|
| `subscription_grace_hours` | `0` | Horas de gracia tras vencer la tarifa (0 = suspensión inmediata, decisión 2026-07-13) |
| `payment_reminder_days` | `3` | Días antes del vencimiento para el badge "Por vencer" (panel hoy; app del chofer futuro) |
| `business_timezone` | `"America/Caracas"` | Los períodos vencen a las 00:00 de esta zona horaria |
| `debt_engine_enabled` | `false` | **Motor de deuda (v8, B2): interruptor maestro.** `false` = el cobro sigue con el modelo prepago actual (el motor no hace nada); `true` = activa emisión semanal, mora y penalización |
| `debt_cap_weeks` | `2` | **Motor de deuda (v8)**: semanas que se puede deber operando antes de penalizarse |
| `penalty_weeks` | `1` | **Motor de deuda (v8, B1 — sin efecto hasta B2)**: semanas de penalización al superar el tope |
| `billing_day_of_week` | `5` | **Motor de deuda (v8, B1 — sin efecto hasta B2)**: día de emisión del cobro semanal (ISO 1=lunes…7=domingo; 5=viernes) |
| `billing_hour` | `18` | **Motor de deuda (v8, B1 — sin efecto hasta B2)**: hora de emisión (0-23; 18=6pm) en `business_timezone` |
| `week_anchor_day` | `1` | **Motor de deuda (v8, B1 — sin efecto hasta B2)**: día en que arranca la semana (ISO 1=lunes) |
| `reactivation_mode` | `"auto"` | **Motor de deuda (v8, B1 — sin efecto hasta B2)**: reactivación por defecto (`auto`=lunes siguiente; el admin siempre puede reactivar manual) |
| `notifications_enabled` | `false` | **Sistema de avisos: interruptor maestro del despachador** (2026-08-20). `false` = los avisos se siguen escribiendo y se ven en la bandeja, pero **no sale ningún push**. El despachador además exige `NODE_ENV=production` |

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

## Dominio 7 — Gremio (capacitaciones)

### `trainings` — capacitaciones del gremio

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK |
| `title` | text | no | — | — |
| `description` / `location` | text | sí | — | — |
| `starts_at` | timestamptz | no | — | — |
| `ends_at` | timestamptz | sí | — | CHECK: posterior a `starts_at` |
| `capacity` | integer | sí | — | NULL = sin límite. CHECK: > 0 |
| `status` | training_status | no | `'scheduled'` | `scheduled` \| `cancelled` \| `completed` |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | Trigger `set_updated_at` |

- Las capacitaciones se **cancelan, nunca se borran** (los asistentes conservan su historial).

### `training_attendees` — inscripción y asistencia

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | bigint IDENTITY | no | — | PK |
| `training_id` | integer | no | — | FK → `trainings.id` (RESTRICT) |
| `driver_id` | uuid | no | — | FK → `drivers.user_id` (RESTRICT) |
| `status` | training_attendee_status | no | `'registered'` | `registered` \| `attended` \| `absent` \| `cancelled` |
| `registered_by` | uuid | sí | — | FK → `admins.id` (SET NULL). NULL = autoservicio (app, futuro) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | Trigger `set_updated_at` |

- **UNIQUE `(training_id, driver_id)`**: sin doble inscripción; liberar cupo = status `cancelled`.
- Índice en `driver_id` (historial de capacitaciones por afiliado).

---

## Enums (tipos nativos de PostgreSQL)

| Enum | Valores |
|---|---|
| `admin_status` | `active`, `suspended` |
| `user_status` | `active`, `suspended` |
| `driver_status` | `applicant` (solicitud de la app, mig. `1752380000000` 2026-08-11), `pending`, `scheduled`, `approved`, `rejected`, `suspended`, `paused`, `overdue`, `penalized` (`scheduled` = aprobado con inicio el próximo lunes, mig. `1752370000000` 2026-08-09; `paused` en Fase A; `overdue`/`penalized` añadidos en B1 del motor de deuda el 2026-07-23) |
| `driver_source` | `app`, `admin` |
| `vehicle_approval` | `pending`, `approved`, `rejected` |
| `requirement_applies_to` | `driver`, `vehicle` |
| `document_status` | `valid`, `expired`, `rejected` (**eje de vigencia, inerte** desde 2026-08-11) |
| `document_approval` | `pending`, `approved`, `rejected` (**eje de revisión** de documentos, mig. `1752380000000` 2026-08-11) |
| `billing_period` | `daily`, `weekly`, `monthly`, `annual` |
| `subscription_status` | `pending_payment`, `active`, `scheduled`, `expired`, `cancelled` |
| `membership_payment_status` | `pending`, `paid`, `refunded` |
| `subscription_payment_status` | `pending`, `paid`, `overdue`, `refunded` |
| `subscription_charge_kind` | `period`, `penalty` (v8, 2026-07-23) |
| `invoice_status` | `issued`, `voided` |
| `payment_submission_status` | `pending`, `approved`, `rejected` (v9, 2026-08-03) |
| `training_status` | `scheduled`, `cancelled`, `completed` |
| `training_attendee_status` | `registered`, `attended`, `absent`, `cancelled` |
| `payment_method_type` | `bank_transfer`, `pago_movil`, `zelle`, `paypal`, `binance`, `crypto`, `contact` (2026-07-23), `cash_usd` (Efectivo Divisa, admin-only, 2026-08-03) |
| `notification_type` | `charge_issued`, `charge_reminder`, `debt_overdue`, `penalty_applied`, `driver_reactivated`, `tariff_starting`, `payment_received`, `payment_approved`, `payment_rejected`, `application_approved`, `application_rejected`, `document_approved`, `document_rejected`, `vehicle_approved`, `vehicle_rejected` (mig. `1752450000000`, 2026-08-20). **Lista cerrada de v1**: solo avisos automáticos de dinero y aprobación; un caso nuevo cuesta una migración a propósito |
| `notification_push_status` | `pending`, `sent`, `skipped`, `failed` (2026-08-20). `skipped` **no es un fallo**: no había a dónde enviar (sin token vivo) o todos los tokens estaban muertos — la bandeja ya tiene el aviso |
| `device_platform` | `android`, `ios` (2026-08-20; hoy solo hay APK Android) |

## Garantías físicas destacadas (imposibles de violar desde el código)

| Garantía | Mecanismo |
|---|---|
| Una sola versión de membresía vigente | Índice único parcial `memberships_single_active` |
| Un pago de membresía válido por chofer | Índice único parcial `membership_payments_one_valid_per_driver` |
| Una tarifa activa + máx. una programada por chofer | Índices únicos parciales en `driver_subscriptions` |
| Todo documento tiene exactamente un dueño | CHECK `documents_exactly_one_owner` |
| Números de factura únicos y sin reinicio | Secuencia `invoice_number_seq` + UNIQUE |
| Un envío de pago pendiente por chofer | Índice único parcial `payment_submissions_one_pending_per_driver` |
| Auditoría con máximo un actor | CHECK `audit_logs_max_one_actor` |
| Usernames de admin en minúsculas | CHECK `admins_username_lowercase` |
| Un teléfono pertenece a un solo afiliado | UNIQUE `device_tokens.token` (global, no por usuario) |

## Dominio 8 — Métodos de pago (cobro al afiliado)

### `payment_methods` — cuentas donde el afiliado paga (2026-07-23)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | integer IDENTITY | no | — | PK |
| `name` | text | no | — | Etiqueta libre (ej. "Banesco — Ahorro Juan Pérez"); permite varias cuentas del mismo tipo |
| `type` | payment_method_type | no | — | `bank_transfer` \| `pago_movil` \| `zelle` \| `paypal` \| `binance` \| `crypto` \| `contact` \| `cash_usd` |
| `details` | jsonb | no | `'{}'` | Datos según el tipo (banco/cuenta/titular/cédula; wallet; email; teléfono…). **La forma se valida por tipo en el service** (no hay columnas rígidas). `cash_usd` (Efectivo Divisa) no lleva datos de cuenta |
| `is_active` | boolean | no | `true` | Solo las activas se ofrecen al cobrar |
| `admin_only` | boolean | no | `false` | **v9**: `true` = solo el panel admin lo ofrece; **nunca se expone a la app**. `cash_usd` nace `admin_only` |
| `created_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` / `updated_at` | timestamptz | no | `now()` | Trigger `set_updated_at` |

Catálogo **informativo** (no es pasarela): el admin registra las cuentas, el afiliado paga por
fuera y el comprobante se adjunta después (Pieza 2, pendiente). Reutiliza Supabase Storage para
imágenes (QR), no un proveedor nuevo.

## Dominio 9 — Avisos al afiliado (mig. `1752450000000`, 2026-08-20)

**Una sola tabla hace de bandeja y de buzón de salida.** `notifications` *es* la fila que la app
lista y *es* la fila que el despachador tiene que enviar; una segunda tabla solo duplicaría el
mismo hecho e invitaría a que las dos se contradigan.

La fila se escribe **dentro de la transacción del hecho que anuncia** (si el pago se revierte, el
aviso se va con él) y un proceso aparte —`src/plugins/notification-dispatcher.ts`— la envía. Nunca
se llama al proveedor dentro de una transacción de dinero: colgaría el tick del motor de deuda tras
una llamada de red, y un push antes del COMMIT avisa de algo que puede no ocurrir.

### `notifications` — el aviso (bandeja + buzón de salida)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | bigint IDENTITY | no | — | PK |
| `user_id` | uuid | no | — | FK → `users.id` (**CASCADE**): la limpieza de solicitantes borra usuarios y sus avisos no son historia que valga la pena dejar huérfana (el registro lo guarda `audit_logs`) |
| `type` | notification_type | no | — | Lista cerrada de v1 (ver enums) |
| `title` / `body` | text | no | — | **Ya redactados**. El teléfono nunca compone el texto: la bandeja discreparía del push, y corregir una palabra exigiría publicar un APK |
| `payload` | jsonb | sí | — | Contexto sobre el que la app actúa: montos, ids de factura, **motivo del rechazo** |
| `read_at` | timestamptz | sí | — | La bandeja. `NULL` = no leído (alimenta el contador de la campana) |
| `deliver_after` | timestamptz | no | `now()` | **Retiene el push hasta esa hora** (la bandeja lo muestra igual). Es lo que separa el AVISO del HECHO sin romper la atomicidad: el motor marca la mora a las 00:05 y en la misma transacción programa el mensaje para las ~7:00 am |
| `push_status` | notification_push_status | no | `pending` | Estado del envío |
| `push_attempts` | integer | no | `0` | Se abandona (`failed`) al tercer intento; no se reintenta para siempre |
| `push_sent_at` | timestamptz | sí | — | — |
| `push_error` | text | sí | — | Último motivo de fallo |
| `created_at` | timestamptz | no | `now()` | — |

**Sin `updated_at`**: la tabla es de solo-añadir salvo dos cambios de estado que ya llevan su propia
marca de tiempo explícita (`read_at`, `push_sent_at`); una columna genérica diría menos que ellas.

Índices: `(user_id, created_at DESC)` (la bandeja) · parcial `(user_id) WHERE read_at IS NULL` (el
contador viaja dentro de `/driver-auth/me/account`, que la app pide en cada pantalla) · parcial
`(deliver_after) WHERE push_status = 'pending'` (la cola del despachador).

**Reclamo de la cola**: `SELECT … FOR UPDATE SKIP LOCKED` dentro de una única transacción por lote,
sin estado `sending`. Un estado `sending` es justo lo que dejaría filas encalladas para siempre la
primera vez que el proceso muera a media entrega; así un caído hace ROLLBACK a `pending` y el
siguiente pase las recoge (entrega **al menos una vez**, que para un aviso es el lado correcto).

### `device_tokens` — teléfonos donde entregar

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | bigint IDENTITY | no | — | PK |
| `user_id` | uuid | no | — | FK → `users.id` (CASCADE) |
| `token` | text | no | — | **UNIQUE GLOBAL** (ver abajo) |
| `platform` | device_platform | no | — | `android` \| `ios` |
| `last_seen_at` | timestamptz | no | `now()` | Los tokens FCM rotan; la app los reenvía al abrir |
| `revoked_at` | timestamptz | sí | — | Revocado, **no borrado**: una fila que revive es normal y conserva su historia |
| `created_at` | timestamptz | no | `now()` | — |

El **UNIQUE global** (no por usuario) es un control de privacidad, no de orden: el token identifica
un **teléfono**. Cuando otro chofer inicia sesión en el mismo aparato, registrar el token reapunta
la fila en vez de dejar dos dueños; si no, los montos y los motivos de rechazo del anterior siguen
cayendo en una pantalla que ya no es suya. El cierre de sesión revoca además — hay que cerrar las
dos puertas. Índice parcial `(user_id) WHERE revoked_at IS NULL`.

---

## Tablas futuras (diseñadas, no implementadas)

### `vehicle_images` — fotos del vehículo (máx 3)

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `vehicle_id` | uuid | no | — | FK → `vehicles.id` (CASCADE) |
| `file_url` | text | no | — | Referencia (path) en el bucket privado de Supabase Storage; se lee con URL firmada |
| `position` | smallint | no | — | Orden 1-3. **CHECK** `position BETWEEN 1 AND 3` |
| `uploaded_by` | uuid | sí | — | FK → `admins.id` (SET NULL) |
| `created_at` | timestamptz | no | `now()` | — |

**UNIQUE `(vehicle_id, position)`**: cada vehículo tiene a lo sumo 3 fotos, ordenadas; el UNIQUE
también acota el conteo sin un contador. Solo JPG/PNG (validado por magic number). Migración
`1752310000000_vehicle-images`. Endpoints en `/drivers/:id/vehicles/:vehicleId/images`.

---

Del modelo v7 quedan pendientes para los módulos siguientes: `clients`, `trip_requests`,
`trip_offers`, `trips`, `trip_route_points`, `ratings`, `fare_rules`, `time_multipliers`,
`push_campaigns` (campañas manuales, **pospuesta a propósito**: v1 solo manda avisos automáticos),
`service_areas`, `benefit_requests`, `support_tickets`. Ver
[database-design-v7.md](database-design-v7.md).
