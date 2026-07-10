# Profesionales del Volante — Diseño de base de datos (v4)

> ⚠️ **REEMPLAZADO por [database-design-v5.md](database-design-v5.md)** (2026-07-08, quinta ronda: membresía vuelve a única con pago único vitalicio + promociones con descuento; beneficios globales vigentes; adelanto de N períodos en tarifas, no reembolsable). Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v4 cerrado (cuarta ronda: usuarios simplificados, membresías múltiples recurrentes) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 8 de julio de 2026 · reemplaza a [database-design-v3.md](database-design-v3.md)
> **Fuente:** PDF de requisitos (EDV route, Ing. Yornel Marval) + decisiones de las sesiones de diseño
> **Diagramas v4:** [database-erd-v4.png](database-erd-v4.png) (imagen completa anotada con descripción de cada tabla) · [database-erd-v4-admin.png](database-erd-v4-admin.png) (solo el módulo admin, máxima resolución) · [erd-svg-v4/](erd-svg-v4/) (vectoriales) · el artifact navegable sigue en v3, pendiente al congelar. Índice general: [README.md](README.md).

---

## Historial de cambios v3 → v4 (cuarta ronda, 2026-07-08)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Reversión del renombrado interno**: BD/backend vuelven a `drivers`, `driver_id`, `subscription_plans`, `driver_subscriptions`, `subscription_payments`. La UI sigue mostrando "Afiliados" y "Tarifas" | Decisión con el colega: internamente choferes, visualmente afiliados |
| 2 | **Dos tipos de usuario** (`users.role enum(user\|driver)`); la tabla `clients` se elimina — sus contadores suben a `users` (comunes a ambos tipos); `drivers` queda como extensión con lo específico del chofer | Solo existen usuario y chofer; admins siguen en tabla aparte |
| 3 | **Membresías múltiples**: catálogo de membresías (ya no una sola), cada una con sus beneficios | Nueva definición de negocio |
| 4 | **Membresías recurrentes** (`billing_period monthly\|annual`), ya no vitalicias; nueva tabla `membership_subscriptions`; `membership_payments` pasa de pago único a pagos por período | Nueva definición de negocio |
| 5 | **Inmutabilidad total por versión** (membresías Y tarifas): un plan publicado con suscriptores jamás se modifica — "editar" en el panel archiva la versión y crea una nueva; los suscriptores vigentes conservan precio y beneficios congelados hasta vencer | Regla explícita del negocio (ejemplo de los 150 USD) |
| 6 | Membresía vencida (+ gracia) → el chofer pierde beneficios **y** operación | La membresía es requisito de ser miembro |

**Conteo v4: 31 tablas en 8 dominios** (−`clients`, +`membership_subscriptions`) + 1 vista (`v_driver_payments`).

## 1. Contexto del producto

Plataforma de transporte (tipo taxi/carrera) de un gremio. Roles: **Usuario** (cliente, app móvil), **Chofer** (en pantalla "Afiliado", app móvil) y **Administrador** (panel web, plano aparte). Particularidades:

- **Pago del viaje externo** (acordado usuario-chofer); la plataforma registra referencia y confirmación.
- **El negocio cobra al chofer**: membresía recurrente (mensual/anual, lo hace miembro y da beneficios) + tarifa recurrente (diaria/semanal/mensual/anual, lo habilita a operar). Sin comisión por viaje.
- **Modo subasta/negociación** además de tarifa plana.
- **Gremio**: aprobación de choferes, contratos, beneficios por membresía, capacitaciones.
- **Tracking laxo**: posiciones periódicas. Contexto: Venezuela (moneda dual, WhatsApp, motorizados).

**Orden de construcción:** primero el módulo admin completo; después las apps.

### Glosario (código vs pantalla)

| En pantalla (frontend) | En código/BD | Qué es |
|---|---|---|
| Afiliado | `drivers` / `driver_id` | El chofer miembro del gremio |
| Membresía | `memberships` | Plan recurrente (monthly/annual) que hace miembro y otorga beneficios |
| Tarifa | `subscription_plans` | Plan recurrente (daily→annual) que habilita operar |
| Tarifa de viaje | `fare_rules` | Precio del viaje para el pasajero |

### Ciclo de vida del chofer (v4)

```
Registro (app o admin) → [pending] → paga 1er período de una MEMBRESÍA (admin registra)
  → admin aprueba (exige membresía pagada) → [miembro: beneficios habilitados]
  → contrata TARIFA (prepago) → [operativo]
  → renueva membresía Y tarifa cada período (prepago + gracia configurable c/u)
Membresía vencida + gracia → pierde beneficios Y operación (aunque la tarifa esté al día)
Tarifa vencida + gracia    → pierde operación (conserva beneficios si la membresía está al día)
Rechazo tras pago → reembolso registrado (refunded, con admin responsable)
```

La condición de "miembro" se deriva de tener `membership_subscriptions` activa — no se almacena.

## 2. Arquitectura técnica (sin cambios en v4)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

- Backend propio Fastify, único punto de entrada; las apps jamás tocan la BD.
- Dos planos de identidad: usuarios/choferes en Supabase Auth (email verificado; Fastify verifica JWT) · admins con credenciales propias en Fastify (argon2id, lockout).
- Supabase = Postgres gestionado + PostGIS + Auth (solo apps) + Storage.
- Push FCM + Capacitor (apps); panel admin por WebSocket in-app.
- RLS defensa en profundidad opcional · migraciones versionadas · pool propio.
- Sin APIs pagas en desarrollo: PostGIS para distancias (línea recta × circuity factor), Leaflet/MapLibre + OSM, Photon/Nominatim, deep link a Google Maps, FCM. Costo inevitable: Apple Developer 99 USD/año.

## 3. Decisiones de negocio vigentes

### Dominio de viajes (ronda 1 — sin cambios)

1. Cancelaciones: ambos roles; se registra quién/motivo; alimenta métricas.
2. Moneda dual: montos en USD; cada viaje congela `exchange_rate` USD→Bs.
3. Vehículos del chofer (o registrados por admin); admin aprueba; vehículo "actual".
4. Subasta: solicitud y contraofertas expiran; una contraoferta por chofer.
5. Tarifa plana de viaje: base + km + minuto por tipo de vehículo × multiplicador horario.
6. Geocercas opcionales apagadas por defecto.
7. Ruta real: puntos periódicos del tracking.
8. Distancia sin APIs: línea recta × factor; `distance_method` prepara migración.
9. Matching: broadcast con radio expansivo hasta radio máximo + expiración global.
10. El cliente elige tipo de vehículo al solicitar.
11. Promociones: solo campañas push; sin cupones.

### Identidad y panel (rondas 2-4)

12. **Dos tipos de usuario** en `users` (`role: user | driver`) + `admins` completamente aparte con auth propio en Fastify (un nivel por ahora). Consecuencia aceptada: una cuenta es usuario O chofer, no ambos (un chofer que quiera pedir viajes necesita otra cuenta).
13. Verificación de email obligatoria (Supabase Auth); sin OTP SMS.
14. Registro dual de choferes: app (nacen `pending`) o admin (nacen `approved`); `source` + `registered_by`. Cola del panel = `drivers.status = pending` (sub-filtro: con membresía pagada primero).
15. Perfil del chofer gestionable por admin: info, foto, suscripciones, contraseña solo vía reset-link/temporal. Auditado.
16. Tipo de vehículo nullable + camioneta; solo BD/backend. ⚠️ Deuda: sin tipo no cotiza ni matchea cuando enciendan los viajes.
17. Capacitaciones con entidad propia; inscripción self-service futura sin cambios de esquema.
18. Alcance del panel: núcleo (admins, choferes, membresías, tarifas, pagos, vehículos) + dashboard + documentos con vencimientos + beneficios + auditoría + capacitaciones + historiales. Pospuesto: pantallas de settings y tarifas de viaje, todo lo dependiente de apps/viajes.

### Membresías y tarifas (rondas 3-4)

19. **Membresías múltiples y recurrentes** (`billing_period: monthly | annual`): catálogo creado por el admin; cada membresía define sus beneficios (`membership_benefits`). Ser miembro = tener membresía activa.
20. **Una membresía activa y una tarifa activa por chofer** (constraints físicos; máx. una `scheduled` de cada una).
21. **Prepago en ambas**: nace `pending_payment`; el pago registrado activa y el período corre. El scheduler genera el pago del período siguiente antes del vencimiento (+ push). Gracia configurable independiente (`membership_grace_hours`, `subscription_grace_hours`; seed 24h). Cambio de plan efectivo al vencer (estado `scheduled`), sin prorrateos.
22. **Inmutabilidad por versión (regla de los 150 USD)**: un plan publicado con suscriptores jamás se modifica — ni precio, ni beneficios, ni período. "Editar" en el panel = archivar la versión (deja de venderse) + crear una nueva. El suscriptor vigente conserva su versión congelada hasta vencer; al vencer, elige del catálogo disponible en ese momento (si su plan sigue en catálogo, renovar = pagarlo de nuevo; si fue archivado, no hay renovación). Aplica a `memberships` y a `subscription_plans` por igual. Cada pago congela además su `amount_usd`.
23. **Flujo de afiliación**: el primer pago de membresía ocurre **antes** de la aprobación; aprobar exige membresía pagada; contratar tarifa exige membresía activa. Rechazo tras pago → **reembolso registrado** (`refunded` + fecha + admin).
24. **Membresía vencida (+ gracia) → pierde beneficios Y operación.** Tarifa vencida (+ gracia) → pierde solo operación.
25. **Beneficios gratuitos** con flujo de solicitud (`benefit_requests`); el backend valida que la membresía **activa** del chofer **incluya** ese beneficio.
26. **Vínculo tarifa-vehículo diferido**: `allowed_vehicle_types` smallint[] nullable en `subscription_plans` (null = todos; backend normaliza `[]` → null); solo BD/backend por ahora.
27. **Pagos en tablas separadas** + vista `v_driver_payments` (unión de membership_payments y subscription_payments) para historiales; la sección Historiales del panel crece con vistas/filtros, no con tablas.
28. **No se fusionan membresía y tarifa** en una abstracción genérica pese a ser estructuralmente gemelas: conceptos de negocio distintos que evolucionan por separado. Patrón repetido deliberado > abstracción prematura.

### Supuestos fijados

Sin viajes programados · sin paradas intermedias · soporte = tickets simples · las capacitaciones se notifican vía push.

## 4. Convenciones del modelo

- Montos en **USD**; snapshots congelan monto (pagos) y tasa (viajes).
- **Inmutabilidad por versión** en planes vendibles (memberships, subscription_plans); `fare_rules` se versiona con `valid_from`/`valid_to`.
- `geography` = PostGIS (WGS84). Estados como enums; máquinas de estado blindadas con constraints.
- Arrays contra catálogos: validación backend + CHECK.
- Tipos **preliminares** hasta el refinamiento. `created_at` en todas las tablas (omitido salvo relevancia).

## 5. Modelo de datos — 31 tablas en 8 dominios

### 5.1 Identidad (3)

```
users                        todos los usuarios de las apps (id = auth.users Supabase)
  id uuid PK · role enum(user|driver) · full_name · email UQ · phone · photo_url
  status enum(active|suspended) · avg_rating · rating_count · cancel_count
  (los contadores/ratings son comunes a ambos tipos; la tabla clients ya no existe)

drivers                      extensión: SOLO lo específico del chofer
  user_id uuid PK FK→users · status enum(pending|approved|suspended)
  source enum(app|admin) · registered_by FK→admins (null si vino de la app)
  current_vehicle_id FK→vehicles (null) · is_available bool
  last_location geography(Point) · last_location_at · contract_url (Storage)

documents                    documentos de chofer o vehículo
  id uuid PK · driver_id FK (null) · vehicle_id FK (null)
  doc_type · file_url (Storage) · expires_at date · status enum(valid|expired|rejected)
  CHECK: exactamente un dueño
```

### 5.2 Administración, membresías y tarifas (8)

```
admins                       plano administrativo, auth propio
  id uuid PK · full_name · email UQ · password_hash (argon2id)
  role text default 'admin' (previsto para niveles) · status enum(active|suspended)
  created_by FK→admins (null = semilla) · last_login_at
  failed_login_attempts · locked_until

memberships                  CATÁLOGO de membresías (versiones inmutables)
  id PK · name · description · billing_period enum(monthly|annual)
  price_usd · active bool ("editar" = archivar + crear) · created_by FK→admins

membership_benefits          beneficios que otorga CADA membresía
  membership_id PK FK→memberships · benefit_id PK FK→benefits
  (inmutable una vez la membresía tiene suscriptores — parte de la versión)

membership_subscriptions     la membresía contratada por el chofer (PREPAGO)
  id uuid PK · driver_id FK→drivers · membership_id FK→memberships
  status enum(pending_payment|active|scheduled|expired|cancelled)
  started_at · current_period_start · current_period_end · cancelled_at
  CONSTRAINTS: única 'active' y máx. una 'scheduled' por chofer

membership_payments          pagos por período de la membresía
  id uuid PK · membership_subscription_id FK
  period_start · period_end · amount_usd (snapshot)
  status enum(pending|paid|overdue|refunded)
  paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins
  (refunded: rechazo del aspirante tras el primer pago)

subscription_plans           CATÁLOGO de tarifas (versiones inmutables) — UI: "Tarifas"
  id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
  price_usd · allowed_vehicle_types smallint[] (null = todos; oculto en frontend)
  active bool · created_by FK→admins

driver_subscriptions         la tarifa contratada por el chofer (PREPAGO)
  id uuid PK · driver_id FK→drivers · plan_id FK→subscription_plans
  status enum(pending_payment|active|scheduled|expired|cancelled)
  started_at · current_period_start · current_period_end · cancelled_at
  CONSTRAINTS: única 'active' y máx. una 'scheduled' por chofer

subscription_payments        pagos por período de la tarifa
  id uuid PK · driver_subscription_id FK
  period_start · period_end · amount_usd (snapshot)
  status enum(pending|paid|overdue) · paid_at · registered_by FK→admins
```

**Vista `v_driver_payments`**: unión de membership_payments + subscription_payments normalizada (chofer, concepto, monto, estado, fecha, admin) — historial del perfil y sección Historiales.

**Máquina de estados (ambas suscripciones):** `pending_payment` → `active` → renueva mientras se pague y el plan siga en catálogo → `expired` (vencida + gracia, o plan archivado sin renovación posible) | `cancelled`; `scheduled` arranca al vencer la activa (cambio de plan).

### 5.3 Flota (2)

```
vehicle_types                catálogo: moto, carro, camioneta (extensible)
  id smallint PK · name UQ · active bool

vehicles
  id uuid PK · driver_id FK→drivers
  vehicle_type_id FK (NULLABLE — solo BD/backend por ahora)
  registered_by FK→admins (null si lo registró el chofer)
  brand · model · year · color · plate UQ
  approval_status enum(pending|approved|rejected)
```

### 5.4 Operación de viajes (5) — módulo futuro

```
trip_requests   id · client_id FK→users · mode enum(flat|auction) · requested_vehicle_type_id FK
                origin/destination geography(Point) · *_address
                quoted_amount_usd · offered_amount_usd · estimated_distance_km
                estimated_duration_min · search_radius_km
                status enum(searching|offered|assigned|expired|cancelled) · expires_at

trip_offers     id · request_id FK · driver_id FK→drivers · amount_usd
                status enum(pending|accepted|rejected|expired) · expires_at
                UNIQUE (request_id, driver_id)

trips           id · request_id FK UQ · client_id FK→users · driver_id FK→drivers · vehicle_id FK
                final_fare_usd · exchange_rate · estimated_* · distance_method enum(straight|route)
                status enum(assigned|arrived|in_progress|completed|cancelled)
                cancelled_by enum(client|driver|admin) · cancel_reason · payment_confirmed
                assigned_at · arrived_at · started_at · completed_at · cancelled_at

trip_route_points  id bigint · trip_id FK · point geography(Point) · recorded_at

ratings         id · trip_id FK · rater_id FK→users · ratee_id FK→users
                score 1-5 · comment · hidden · UNIQUE (trip_id, rater_id)
```

### 5.5 Economía de viajes (2)

```
fare_rules          VERSIONADA (valid_from/valid_to) · tarifa de VIAJE por tipo de vehículo
                    id · vehicle_type_id FK · base_usd · per_km_usd · per_min_usd

time_multipliers    recargos horarios globales
                    id · label · from_time · to_time · days_of_week smallint[] · multiplier · active
```

### 5.6 Comunicación (3)

```
device_tokens    id · user_id FK→users · token UQ · platform enum(android|ios) · last_seen_at · revoked
notifications    id · user_id FK→users · type · title · body · payload jsonb · sent_at · read_at
push_campaigns   id · created_by FK→admins · audience enum(users|drivers|all) · title · body · sent_at · sent_count
```

### 5.7 Gremio: soporte, beneficios y capacitaciones (5)

```
support_tickets      id · trip_id FK (null) · opened_by FK→users · subject · description
                     status enum(open|in_review|resolved|closed) · resolved_by FK→admins · resolved_at

benefits             catálogo del gremio (House Market, hospitalarios…)
                     id · name · description · active
                     (se otorgan por membresía vía membership_benefits; gratuitos)

benefit_requests     id · driver_id FK→drivers · benefit_id FK→benefits
                     status enum(pending|approved|rejected) · notes · reviewed_by FK→admins · reviewed_at
                     (backend valida: la membresía ACTIVA del chofer incluye ese beneficio)

trainings            id · title · description · location · starts_at · ends_at (null)
                     capacity (null = sin cupo) · status enum(scheduled|cancelled|completed) · created_by FK→admins

training_attendees   id · training_id FK · driver_id FK→drivers
                     status enum(registered|attended|absent|cancelled)
                     registered_by FK→admins (null = self-service futuro)
                     UNIQUE (training_id, driver_id)
```

### 5.8 Plataforma (3)

```
service_areas    id · name · area geography(Polygon) · active bool default false

app_settings     key text PK · value jsonb · description · updated_by FK→admins · updated_at
                 Claves previstas: dispatch_* (4), distance_circuity_factor, avg_speed_kmh,
                 auction_*_ttl_s, tracking_interval_s, membership_grace_hours, subscription_grace_hours

audit_logs       id bigint · actor_admin_id FK (null) · actor_user_id FK (null)
                 event_type · entity · entity_id · data jsonb · created_at
                 CHECK: máx. un actor (ambos null = sistema)
```

## 6. Alcance del módulo admin (primer entregable)

**Núcleo:** login admin (auth propio) · gestión de admins · choferes (registro directo approved, cola de pendientes con sub-filtro de membresía pagada, perfil completo gestionable) · **membresías** (catálogo con beneficios por membresía, suscripciones, pagos, reembolsos — "editar" versiona) · **tarifas** (catálogo, suscripciones, pagos) · vehículos (tipo oculto) · verificación email · infraestructura push.

**Secciones agregadas:** dashboard de métricas (ingresos de membresías + tarifas) · documentos con alertas de vencimiento · catálogo de beneficios · visor de auditoría · capacitaciones · Historiales (vistas con filtros).

**Pospuesto:** pantallas de configuración y tarifas de viaje (⚠️ las claves de gracia nacen con seed 24h) · usuarios/clientes · monitoreo de viajes · moderación de calificaciones · tickets · envío real de push.

## 7. Cubierto sin tabla propia

Ganancias/reportes/dashboard → consultas sobre trips y las dos tablas de pagos · historiales → vistas · llamadas/WhatsApp/navegación → deep links.

## 8. Observaciones sobre el PDF original

Cancelaciones no contempladas → resuelto · ambigüedad vehículos → resuelto · zonas tarifarias descartadas · límites geográficos → geocerca opcional · "cobro semanal" del PDF → evolucionó a membresías + tarifas recurrentes · IDs duplicados y RNF-PERF-02 sin llenar · surge pricing fuera de alcance.

## 9. Trabajo pendiente (en orden)

1. **Regenerar diagramas, imágenes y artifact** a v4 al congelar el módulo admin (los actuales dicen "affiliates/tariff", nombres revertidos en esta ronda).
2. **Flujos críticos**: doble ciclo membresía+tarifa (pago→aprobación→activación→renovación→gracia→expiración, con las dos suscripciones interactuando) · despacho y subasta (módulo viajes).
3. **Refinamiento lógico**: tipos, enums, constraints parciales, índices, vistas.
4. **Matriz de permisos** (dos planos de identidad).
5. **DDL y migraciones** — solo con autorización explícita.

---
*Documento vivo. Diagramas regenerables pidiendo "regenerar diagramas BD".*
