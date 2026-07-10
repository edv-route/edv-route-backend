# Profesionales del Volante — Diseño de base de datos (v2)

> ⚠️ **REEMPLAZADO por [database-design-v3.md](database-design-v3.md)** (2026-07-07, tercera ronda: membresía de pago único + renombrado global choferes→afiliados, suscripciones→tarifas). Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v2 cerrado (enfoque: módulo admin primero) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 7 de julio de 2026 · reemplaza a [database-design-v1.md](database-design-v1.md)
> **Fuente de requisitos:** "Requisitos: Aplicación Profesionales del Volante" (EDV route, Ing. Yornel Marval) — PDF, más decisiones de las sesiones de diseño
> **Diagramas:** los de v1 ([database-erd-v1.png](database-erd-v1.png), [erd-svg/](erd-svg/), [documento navegable](https://claude.ai/code/artifact/73b24b23-2944-47d4-b4c7-8cb01f3c47a5)) reflejan v1 — **pendientes de regenerar** al cerrar el módulo admin.

---

## Historial de cambios v1 → v2 (segundo enfoque: módulo admin)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Planes de afiliación** (`subscription_plans`, `driver_subscriptions`, `subscription_payments`) reemplazan la cuota semanal fija (`membership_fees` y `weekly_dues` eliminadas) | Nuevo modelo de negocio: planes daily/weekly/monthly/annual creados por el admin |
| 2 | Nueva tabla **`admins`** completamente separada de `users`, con **auth propio en Fastify** (argon2, lockout) — fuera de Supabase Auth | Aislamiento físico del plano administrativo |
| 3 | `users` pierde el campo `role` | Sin admins en users, las capacidades derivan de `clients`/`drivers` |
| 4 | **`driver_applications` eliminada** | La cola de aprobación es `drivers.affiliation_status = pending`, venga de la app o del admin |
| 5 | `drivers` + `source` (app/admin) + `registered_by → admins` | Registro dual de choferes |
| 6 | `vehicles.vehicle_type_id` **nullable** + tipo **camioneta** en catálogo + `registered_by → admins` | Petición explícita; el tipo solo existe en BD/backend por ahora |
| 7 | `subscription_plans.allowed_vehicle_types` **array nullable** (null = todos) | El plan podrá restringirse a tipos de vehículo a futuro; por ahora se crean null (planes generales) |
| 8 | `audit_logs`: actor polimórfico (`actor_admin_id` / `actor_user_id`) | El actor puede ser de cualquiera de los dos planos |
| 9 | 6 FKs administrativas re-apuntadas de `users` a `admins` | `reviewed_by`, `registered_by`, `created_by`, `resolved_by`, `updated_by` |
| 10 | Corrección de conteo: v1 tenía 25 tablas (el "24" del título era error aritmético) | Transparencia |
| 11 | **Capacitaciones** con entidad propia (`trainings`, `training_attendees`) | RF-CON-NOTIF-01 las menciona; el gremio las gestiona con inscripción y asistencia |
| 12 | Alcance del módulo admin v1 cerrado (ver sección 6) | Dashboard, documentos, beneficios, auditoría y capacitaciones entran; settings y tarifas se posponen |

**Conteo v2: 28 tablas en 8 dominios** (25 − 3 eliminadas + 6 nuevas).

## 1. Contexto del producto

Plataforma de solicitud y despacho de transporte (tipo taxi/carrera) con tres roles: **Cliente** (app móvil), **Conductor afiliado** (app móvil) y **Administrador** (panel web). Particularidades que gobiernan el diseño:

- **El pago del viaje es externo** (acordado cliente-conductor). La plataforma registra tarifa de referencia y confirmación.
- **El negocio vive de la suscripción del afiliado** (planes creados por el admin), no de comisión por viaje.
- **Modo subasta/negociación** además de tarifa plana.
- **Es un gremio**: afiliación con aprobación, contratos, beneficios (House Market, hospitalarios).
- **Tracking laxo**: posiciones periódicas, no streaming.
- Contexto: Venezuela (moneda dual, WhatsApp, motorizados).

**Orden de construcción decidido:** primero el módulo admin completo (login admin, gestión de choferes/admins/planes/vehículos, aprobaciones, suscripciones), después las apps.

## 2. Arquitectura técnica (decidida)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

- **Backend propio Fastify** como único punto de entrada; las apps jamás tocan la BD directamente.
- **Dos planos de identidad**:
  - **Usuarios (clientes/choferes)**: Supabase Auth — registro, verificación de email, recuperación de contraseña; Fastify verifica el JWT.
  - **Admins**: credenciales propias en Fastify (hash argon2id en `admins`), completamente fuera de Supabase Auth. Login admin obligatorio para el panel. Lockout por intentos fallidos. Recuperación: otro admin resetea desde el panel.
- **Supabase** = PostgreSQL gestionado con PostGIS + Auth (solo usuarios) + Storage (fotos, documentos, contratos).
- **Notificaciones**: FCM + Capacitor Notifications (apps); panel admin por WebSocket in-app (sin FCM web).
- RLS como defensa en profundidad opcional; migraciones versionadas en el repo; pool propio (Supavisor si escala horizontal).

### Restricciones de costos (desarrollo)

| Necesidad | Solución gratuita |
|---|---|
| Distancia para tarifa | PostGIS (geodésica) × circuity factor configurable |
| Mapa en las apps | Leaflet / MapLibre GL + OpenStreetMap |
| Autocompletado direcciones | Photon o Nominatim |
| Navegación del conductor | Deep link a Google Maps |
| Push | FCM |

Costo inevitable: Apple Developer 99 USD/año (iOS).

## 3. Decisiones de negocio cerradas

### Del primer enfoque (siguen vigentes)

1. **Cancelaciones**: ambos roles cancelan; se registra quién/motivo; alimenta contadores y métricas.
2. **Moneda dual**: tarifas ancladas en USD; cada viaje congela `exchange_rate` USD→Bs.
3. **Vehículos**: propiedad del conductor (o registrados por admin); admin aprueba; vehículo "actual" en `drivers.current_vehicle_id`.
4. **Subasta**: solicitud y contraofertas expiran (configurable); una contraoferta por conductor (UNIQUE).
5. ~~Cuota semanal fija por tipo de vehículo~~ → **REEMPLAZADA en v2** por planes de afiliación (ver 14-19).
6. **Tarifa plana**: base + km + minuto por tipo de vehículo × multiplicador horario. Sin recargos por zona.
7. **Área de servicio**: geocercas PostGIS opcionales, apagadas por defecto.
8. **Ruta real**: puntos periódicos del tracking (`trip_route_points`).
9. **Identidad de usuarios**: Supabase Auth con verificación de email obligatoria.
10. **Distancia sin APIs**: línea recta × `distance_circuity_factor`; tiempo = distancia ÷ `avg_speed_kmh`; `trips.distance_method` prepara migración futura.
11. **Matching**: broadcast con radio expansivo (radio inicial → incrementos → radio máximo + expiración global); oleada vigente en `trip_requests.search_radius_km`.
12. **El cliente elige tipo de vehículo** al solicitar.
13. **Promociones**: solo campañas push de marketing; sin cupones.

### Del segundo enfoque — módulo admin (nuevas)

14. **Admins en tabla separada con auth propio en Fastify** (ver arquitectura). Un solo nivel de admin por ahora; el campo `role` queda en la tabla para activar niveles sin migración. Todo admin puede crear admins (revisar cuando haya niveles).
15. **Planes de afiliación**: el admin crea planes con `billing_period` (daily/weekly/monthly/annual) y precio en USD. El precio es inmutable: cambiar precio = archivar el plan (`active = false`) y crear otro. Cada pago congela `amount_usd` (snapshot).
16. **Una suscripción activa por chofer** (y máximo una programada), garantizado con constraints parciales en BD — no solo en código.
17. **Prepago**: la suscripción nace `pending_payment`; al registrar el admin el pago, pasa a `active` y el período corre desde ahí. El scheduler genera el pago del siguiente período antes del vencimiento (+ push al chofer).
18. **Cambio de plan al vencer**: se crea una suscripción `scheduled` que arranca automáticamente al terminar el período pagado actual. Sin prorrateos (pago en efectivo).
19. **Vencimiento con gracia configurable**: al vencer sin pago, corre `subscription_grace_hours` (app_settings); agotada la gracia, la suscripción expira y el chofer queda suspendido para operar. Sin suscripción activa no se reciben solicitudes (regla para el futuro módulo de viajes).
20. **Suscripciones visibles solo para choferes aprobados** (`affiliation_status = approved`) — regla de negocio en Fastify.
21. **Vínculo plan-vehículo diferido**: `allowed_vehicle_types` (array, null = todos) existe en BD/backend; por ahora todos los planes se crean null (generales) y el frontend no lo muestra. Cuando se active, solo restringirá a choferes con vehículo tipado. Convención anti-ambigüedad: `null` = sin restricción; el backend normaliza `[]` → `null` (un array vacío jamás debe persistirse — significaría "ningún tipo permitido").
22. **Tipo de vehículo nullable** en `vehicles` + **camioneta** en el catálogo. Solo BD/backend por ahora. ⚠️ Deuda consciente: al activar el módulo de viajes, vehículos sin tipo no podrán cotizarse ni matchearse — habrá que rellenar tipos o definir default.
23. **Registro dual de choferes**: desde la app (nacen `pending`, con email verificado por Supabase Auth) o directamente por el admin (nacen `approved`; la cuenta se crea con invitación que valida el email). `drivers.source` + `registered_by` registran el origen. La "lista de choferes pendientes" del panel = `drivers WHERE affiliation_status = 'pending'`.
24. **`users` sin campo `role`**: las capacidades derivan de la existencia de `clients`/`drivers` (un dato derivable almacenado es un dato que se desincroniza).
25. **El admin gestiona el perfil completo del chofer**: información básica, foto (Storage), suscripción, y contraseña — esta última solo vía enlace de restablecimiento al email del chofer o contraseña temporal con cambio obligatorio al primer login (API admin de Supabase Auth). Nunca contraseñas definitivas fijadas a mano. Todo auditado.
26. **Capacitaciones con entidad propia** (`trainings` + `training_attendees`): el admin crea y gestiona asistencia; la inscripción self-service desde la app llega después sin cambios de esquema.

### Supuestos fijados (sin objeción)

- Sin viajes programados. Sin paradas intermedias. Sin OTP por SMS (verificación solo email). Soporte = tickets simples ligados a viajes.

## 4. Convenciones del modelo

- Montos en **USD** ancla; conversión con tasa congelada por viaje; precios de suscripción congelados por pago (snapshot).
- Tablas **versionadas** (`valid_from`/`valid_to`, null = vigente): `fare_rules`. Los planes usan archivado (`active=false`) + inmutabilidad de precio.
- `geography` = PostGIS (WGS84); índices GIST en refinamiento.
- Estados como enums; máquinas de estado blindadas con constraints (refinamiento).
- Arrays contra catálogos (ej. `allowed_vehicle_types`): PostgreSQL no valida FK dentro de arrays → validación en backend + CHECK; aceptable por catálogo pequeño y estable; migrar a tabla puente solo si el catálogo crece.
- Tipos **preliminares** hasta el refinamiento lógico. `created_at` en todas las tablas (omitido abajo salvo relevancia).

## 5. Modelo de datos — 28 tablas en 8 dominios

### 5.1 Identidad (4)

```
users                        perfil base de clientes/choferes (id = auth.users de Supabase)
  id uuid PK · full_name · email UQ · phone · photo_url
  status enum(active|suspended)
  (sin campo role: las capacidades derivan de clients/drivers)

clients                      extensión de rol cliente
  user_id uuid PK FK→users · avg_rating · rating_count · cancel_count

drivers                      extensión de rol conductor
  user_id uuid PK FK→users · affiliation_status enum(pending|approved|suspended)
  source enum(app|admin) · registered_by FK→admins (null si vino de la app)
  current_vehicle_id FK→vehicles (null) · is_available bool
  last_location geography(Point) · last_location_at
  avg_rating · rating_count · cancel_count · contract_url (Storage)
  (la cola de aprobación del panel = affiliation_status 'pending')

documents                    documentos de conductor o vehículo
  id uuid PK · driver_id FK→drivers (null) · vehicle_id FK→vehicles (null)
  doc_type · file_url (Storage) · expires_at date · status enum(valid|expired|rejected)
  CHECK: exactamente uno de driver_id/vehicle_id
```

### 5.2 Administración y suscripciones (4) — NUEVO en v2

```
admins                       plano administrativo, separado y con auth propio
  id uuid PK · full_name · email UQ · password_hash (argon2id)
  role text default 'admin' (un nivel por ahora; previsto para niveles)
  status enum(active|suspended) · created_by FK→admins (null para el admin semilla)
  last_login_at · failed_login_attempts smallint · locked_until timestamptz

subscription_plans           planes de afiliación creados por el admin
  id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
  price_usd (inmutable: cambiar precio = archivar y crear)
  allowed_vehicle_types smallint[] (null = todos; por ahora siempre null)
  active bool · created_by FK→admins

driver_subscriptions         la suscripción del chofer (PREPAGO)
  id uuid PK · driver_id FK→drivers · plan_id FK→subscription_plans
  status enum(pending_payment|active|scheduled|expired|cancelled)
  started_at · current_period_start · current_period_end · cancelled_at
  CONSTRAINTS: única 'active' por chofer · máxima una 'scheduled' por chofer

subscription_payments        pagos de período (dinero en efectivo, registrado por admin)
  id uuid PK · subscription_id FK→driver_subscriptions
  period_start · period_end · amount_usd (snapshot del precio del plan)
  status enum(pending|paid|overdue) · paid_at · registered_by FK→admins
```

**Máquina de estados de la suscripción:** `pending_payment` → `active` (al registrar el primer pago) → renueva mientras se pague → `expired` (venció + gracia agotada) | `cancelled`. `scheduled` arranca al vencer la activa (cambio de plan).

**Flujo prepago:** aprobación del chofer → ve planes → elige (o el admin le asigna) → suscripción `pending_payment` + primer pago `pending` → admin registra pago → `active`, período corre → scheduler genera el siguiente pago antes del vencimiento y notifica push → sin pago al vencer: gracia `subscription_grace_hours` → expira y suspende.

### 5.3 Flota (2)

```
vehicle_types                catálogo: moto, carro, camioneta (extensible)
  id smallint PK · name UQ · active bool

vehicles                     del conductor; registrables también por el admin
  id uuid PK · driver_id FK→drivers
  vehicle_type_id FK→vehicle_types (NULLABLE — solo BD/backend por ahora)
  registered_by FK→admins (null si lo registró el chofer)
  brand · model · year · color · plate UQ
  approval_status enum(pending|approved|rejected)
```

### 5.4 Operación (5) — sin cambios en v2

```
trip_requests                solicitud efímera
  id uuid PK · client_id FK→clients · mode enum(flat|auction)
  requested_vehicle_type_id FK→vehicle_types
  origin geography(Point) · destination geography(Point)
  origin_address · destination_address
  quoted_amount_usd (flat) · offered_amount_usd (auction)
  estimated_distance_km · estimated_duration_min · search_radius_km (oleada)
  status enum(searching|offered|assigned|expired|cancelled) · expires_at · created_at

trip_offers                  aceptaciones y contraofertas
  id uuid PK · request_id FK · driver_id FK · amount_usd
  status enum(pending|accepted|rejected|expired) · expires_at · created_at
  UNIQUE (request_id, driver_id)

trips                        viaje confirmado (histórico)
  id uuid PK · request_id FK UQ · client_id FK · driver_id FK · vehicle_id FK
  final_fare_usd · exchange_rate · estimated_distance_km · estimated_duration_min
  distance_method enum(straight|route)
  status enum(assigned|arrived|in_progress|completed|cancelled)
  cancelled_by enum(client|driver|admin) · cancel_reason · payment_confirmed bool
  assigned_at · arrived_at · started_at · completed_at · cancelled_at

trip_route_points            tracking periódico (alto volumen; particionable a futuro)
  id bigint PK · trip_id FK · point geography(Point) · recorded_at

ratings                      bidireccionales, moderables
  id uuid PK · trip_id FK · rater_id FK→users · ratee_id FK→users
  score 1-5 · comment · hidden bool
  UNIQUE (trip_id, rater_id)
```

Máquinas de estado: solicitud `searching → offered → assigned | expired | cancelled`; viaje `assigned → arrived → in_progress → completed` con salida a `cancelled` desde estados no terminales.

### 5.5 Economía de viajes (2) — antes "Economía"; las cuotas migraron a 5.2

```
fare_rules                   VERSIONADA · tarifa de viaje por tipo de vehículo
  id PK · vehicle_type_id FK · base_usd · per_km_usd · per_min_usd
  valid_from · valid_to (null = vigente)

time_multipliers             recargos por franja horaria (globales)
  id PK · label · from_time · to_time · days_of_week smallint[] · multiplier · active
```

### 5.6 Comunicación (3)

```
device_tokens                dispositivos FCM (varios por usuario)
  id uuid PK · user_id FK→users · token UQ · platform enum(android|ios)
  last_seen_at · revoked bool

notifications                historial de push operativas
  id uuid PK · user_id FK→users · type · title · body · payload jsonb
  sent_at · read_at

push_campaigns               marketing del admin
  id uuid PK · created_by FK→admins · audience enum(clients|drivers|all)
  title · body · sent_at · sent_count
```

### 5.7 Gremio: soporte, beneficios y capacitaciones (5)

```
support_tickets
  id uuid PK · trip_id FK→trips (null) · opened_by FK→users · subject · description
  status enum(open|in_review|resolved|closed) · resolved_by FK→admins · resolved_at

benefits                     catálogo del gremio
  id PK · name · description · active

benefit_requests
  id uuid PK · driver_id FK→drivers · benefit_id FK→benefits
  status enum(pending|approved|rejected) · notes · reviewed_by FK→admins · reviewed_at

trainings                    capacitaciones del gremio (NUEVA)
  id uuid PK · title · description · location (lugar o enlace)
  starts_at · ends_at (null) · capacity int (null = sin cupo)
  status enum(scheduled|cancelled|completed) · created_by FK→admins

training_attendees           inscripción y asistencia (NUEVA)
  id uuid PK · training_id FK→trainings · driver_id FK→drivers
  status enum(registered|attended|absent|cancelled)
  registered_by FK→admins (null = self-service desde la app, futuro)
  UNIQUE (training_id, driver_id)
  (cupo validado por backend contra trainings.capacity)
```

### 5.8 Plataforma (3)

```
service_areas                geocercas opcionales (apagadas por defecto)
  id PK · name · area geography(Polygon) · active bool default false

app_settings                 configuración operativa (key/value)
  key text PK · value jsonb · description · updated_by FK→admins · updated_at
  Claves previstas: dispatch_initial_radius_km, dispatch_radius_increment_km,
  dispatch_wave_interval_s, dispatch_max_radius_km, distance_circuity_factor,
  avg_speed_kmh, auction_request_ttl_s, auction_offer_ttl_s, tracking_interval_s,
  subscription_grace_hours

audit_logs                   eventos del sistema (alto volumen)
  id bigint PK · actor_admin_id FK→admins (null) · actor_user_id FK→users (null)
  event_type · entity · entity_id · data jsonb · created_at
  CHECK: máximo uno de los dos actores (ambos null = evento del sistema)
```

## 6. Alcance del módulo admin (primer entregable) — CERRADO

**Núcleo:**
- Login admin obligatorio (`admins` + auth propio Fastify).
- Registro y gestión de usuarios admin.
- Choferes: registro directo (nacen approved) · cola de pendientes de la app · perfil completo gestionable (información básica, foto vía Storage, contraseña vía reset-link/temporal, suscripción).
- Planes de afiliación (CRUD; `allowed_vehicle_types` oculto en frontend) · suscripciones · registro de pagos.
- Vehículos (registro por admin o chofer; tipo nullable oculto en frontend).
- Verificación de email (Supabase Auth) e infraestructura push (`device_tokens`, `notifications`).

**Agregado en la revisión del PDF (decisión 2026-07-07):**
- Dashboard de métricas (choferes por estado, suscripciones, ingresos, vehículos pendientes — consultas).
- Documentos de choferes/vehículos con alertas de vencimiento (scheduler).
- Catálogo de beneficios.
- Visor de auditoría (`audit_logs`).
- Capacitaciones (creación, gestión de inscripciones/asistencia).

**Pospuesto conscientemente:** pantalla de configuración del sistema (⚠️ `subscription_grace_hours` nace con valor semilla en BD hasta que exista) · pantalla de tarifas de viaje · gestión de clientes · monitoreo de viajes · moderación de calificaciones · tickets de soporte · envío real de campañas push (no hay apps que registren tokens).

## 7. Requisitos cubiertos sin tabla propia

- Ganancias del conductor, reportes y dashboard: consultas agregadas sobre `trips` y `subscription_payments`.
- Llamada/WhatsApp y navegación: deep links, no tocan BD.

## 8. Observaciones sobre el documento de requisitos original

- Cancelaciones no contempladas → decisión 1. · Ambigüedad propiedad de vehículo → decisión 3. · "Zonas" tarifarias → descartadas (solo horario). · "Límites geográficos" → geocerca opcional. · Cuota semanal del PDF → evolucionó a planes (decisiones 14-19). · IDs duplicados y placeholder RNF-PERF-02 en el PDF. · Surge pricing → fuera de alcance v2.

## 9. Trabajo pendiente (en orden)

1. **Regenerar diagramas y artifact** con el modelo v2 (los actuales reflejan v1).
2. **Flujos críticos segundo a segundo**: despacho por radio expansivo, subasta, y ahora también el ciclo de renovación/gracia/expiración de suscripciones. Casos borde: dos conductores aceptan a la vez, cancelación simultánea a aceptación, pérdida de conexión en viaje, pago registrado durante la gracia.
3. **Refinamiento lógico**: tipos definitivos, enums, constraints (incluidos los parciales de suscripción única), índices.
4. **Matriz de permisos**: ahora con dos planos (admin propio vs usuarios Supabase) — contrato del middleware.
5. **DDL y migraciones** — solo con autorización explícita.

---
*Documento vivo del diseño. Generado en sesiones de diseño con Claude Code; los diagramas se regeneran desde definiciones mermaid pidiendo "regenerar diagramas BD".*
