# Profesionales del Volante — Diseño de base de datos (v3)

> ⚠️ **REEMPLAZADO por [database-design-v4.md](database-design-v4.md)** (2026-07-08, cuarta ronda: reversión del renombrado interno a drivers/subscription_*, dos tipos de usuario, membresías múltiples y recurrentes con inmutabilidad por versión). Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v3 cerrado (módulo admin con membresía) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 7 de julio de 2026 · reemplaza a [database-design-v2.md](database-design-v2.md)
> **Fuente:** PDF de requisitos (EDV route, Ing. Yornel Marval) + decisiones de las sesiones de diseño
> **Diagramas v3:** [database-erd-v3.png](database-erd-v3.png) (imagen completa anotada, para presentar) · [database-erd-v3-admin.png](database-erd-v3-admin.png) (vista del módulo admin en alta resolución) · [erd-svg-v3/](erd-svg-v3/) (vectoriales) · [artifact navegable](https://claude.ai/code/artifact/73b24b23-2944-47d4-b4c7-8cb01f3c47a5) · índice general en [README.md](README.md).

---

## Historial de cambios v2 → v3 (tercera ronda: membresía y renombrado)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Renombrado global al lenguaje del negocio**: `drivers`→`affiliates`, `subscription_plans`→`tariff_plans`, `driver_subscriptions`→`tariff_subscriptions`, `subscription_payments`→`tariff_payments`; toda columna `driver_id`→`affiliate_id`; `affiliation_status`→`affiliates.status` | Lenguaje ubicuo: el negocio dice "afiliados" y "tarifas"; renombrar es gratis en fase de análisis |
| 2 | **Membresía de pago único** (`memberships`, `membership_benefits`, `membership_payments`): requisito indispensable de afiliación, vitalicia, una sola vigente, otorga los beneficios | Nuevo requisito de negocio |
| 3 | Flujo de afiliación: el pago de membresía ocurre **antes** de la aprobación; rechazo con pago hecho → **reembolso registrado** (`refunded`) | Decisión de negocio; trazabilidad del dinero |
| 4 | Contratar tarifa **requiere membresía pagada** | La membresía es la puerta de entrada a todo |
| 5 | Historial de pagos unificado como **vista de unión** (no tabla); sección "Historiales" del panel = vistas con filtros | Decisión: tablas de pago separadas |
| 6 | Glosario fijado: "Tarifas" = planes del afiliado · "Tarifas de viaje" = `fare_rules` | Resolver colisión de nomenclatura |

**Conteo v3: 31 tablas en 8 dominios** (28 + 3 de membresía). Más 1 vista (`v_affiliate_payments`).

## 1. Contexto del producto

Plataforma de transporte (tipo taxi/carrera) de un gremio/asociación. Roles: **Cliente** (app móvil), **Afiliado** (conductor, app móvil) y **Administrador** (panel web). Particularidades que gobiernan el diseño:

- **Pago del viaje externo** (acordado cliente-afiliado); la plataforma registra referencia y confirmación.
- **El negocio cobra al afiliado**: membresía única de entrada + tarifa recurrente (planes). No hay comisión por viaje.
- **Modo subasta/negociación** además de tarifa plana.
- **Gremio**: aprobación de afiliados, contratos, beneficios (vía membresía), capacitaciones.
- **Tracking laxo**: posiciones periódicas.
- Contexto: Venezuela (moneda dual, WhatsApp, motorizados).

**Orden de construcción:** primero el módulo admin completo; después las apps.

### Ciclo de vida del afiliado (v3)

```
Registro (app o admin) → [pendiente] → paga MEMBRESÍA (admin registra)
  → admin aprueba (exige membresía pagada) → [miembro pleno: beneficios habilitados]
  → contrata TARIFA (prepago) → [operativo: podrá recibir viajes]
  → renueva tarifa cada período · si vence + gracia → suspendido para operar
Rechazo tras pago → reembolso registrado (refunded, con admin responsable)
```

La condición de "miembro" se **deriva** de `membership_payments.status = paid` — no es un estado almacenado (un estado que duplica lo que los pagos dicen es un estado que se desincroniza). La cola de pendientes distingue pendientes **pagados** (a evaluar primero) de **sin pagar**, cruzando con pagos.

## 2. Arquitectura técnica (decidida)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

- **Backend propio Fastify** único punto de entrada; las apps jamás tocan la BD.
- **Dos planos de identidad**: usuarios (clientes/afiliados) en Supabase Auth (verificación email, recuperación; Fastify verifica JWT) · **admins con auth propio en Fastify** (argon2id en `admins`, lockout, fuera de Supabase Auth).
- **Supabase** = Postgres gestionado + PostGIS + Auth (solo usuarios) + Storage (fotos, documentos, contratos).
- **Push**: FCM + Capacitor (apps); panel admin por WebSocket in-app.
- RLS defensa en profundidad opcional · migraciones versionadas en el repo · pool propio (Supavisor si escala).
- Extensibilidad garantizada: dominios desacoplados (sección nueva = tablas nuevas), perfiles por extensión, catálogos como filas, `app_settings` key-value, `jsonb` para lo semiestructurado, migraciones aditivas.

### Restricciones de costos (desarrollo)

| Necesidad | Solución gratuita |
|---|---|
| Distancia para tarifa de viaje | PostGIS (geodésica) × circuity factor |
| Mapa en apps | Leaflet / MapLibre GL + OpenStreetMap |
| Autocompletado direcciones | Photon o Nominatim |
| Navegación del afiliado | Deep link a Google Maps |
| Push | FCM |

Costo inevitable: Apple Developer 99 USD/año (iOS).

## 3. Decisiones de negocio cerradas

### Primer enfoque (siguen vigentes)

1. **Cancelaciones**: ambos roles; se registra quién/motivo; alimenta métricas.
2. **Moneda dual**: montos anclados en USD; cada viaje congela `exchange_rate` USD→Bs.
3. **Vehículos**: del afiliado (o registrados por admin); admin aprueba; vehículo "actual" en `affiliates.current_vehicle_id`.
4. **Subasta**: solicitud y contraofertas expiran (configurable); una contraoferta por afiliado (UNIQUE).
5. ~~Cuota semanal fija~~ → reemplazada por tarifas (v2) + membresía (v3).
6. **Tarifa plana de viaje**: base + km + minuto por tipo de vehículo × multiplicador horario. Sin zonas.
7. **Área de servicio**: geocercas PostGIS opcionales, apagadas por defecto.
8. **Ruta real**: puntos periódicos del tracking.
9. **Identidad de usuarios**: Supabase Auth con verificación de email.
10. **Distancia sin APIs**: línea recta × `distance_circuity_factor`; tiempo = distancia ÷ `avg_speed_kmh`; `trips.distance_method` prepara migración.
11. **Matching**: broadcast con radio expansivo hasta radio máximo + expiración global.
12. **El cliente elige tipo de vehículo** al solicitar.
13. **Promociones**: solo campañas push; sin cupones.

### Segundo enfoque — módulo admin (v2, vigentes con nombres v3)

14. **Admins en tabla separada con auth propio en Fastify**; un nivel por ahora (campo `role` previsto); todo admin puede crear admins (revisar al introducir niveles).
15. **Tarifas** (`tariff_plans`): `billing_period` daily/weekly/monthly/annual; precio inmutable (archivar y crear); snapshot en cada pago.
16. **Una suscripción de tarifa activa por afiliado** (y máx. una programada) — constraints en BD.
17. **Prepago**: nace `pending_payment`; al registrar el pago pasa a `active` y el período corre. El scheduler genera el siguiente pago antes del vencimiento (+ push).
18. **Cambio de tarifa al vencer** el período (suscripción `scheduled`). Sin prorrateos.
19. **Vencimiento con gracia configurable** (`tariff_grace_hours`, seed 24h propuesto); agotada, expira y suspende para operar.
20. **Tarifas visibles solo para afiliados aprobados** (regla backend). *(v3: y con membresía pagada — decisión 28).*
21. **Vínculo tarifa-vehículo diferido**: `allowed_vehicle_types` smallint[] nullable; null = todos; backend normaliza `[]` → null; solo BD/backend por ahora; solo restringirá a afiliados con vehículo tipado.
22. **Tipo de vehículo nullable** en `vehicles` + **camioneta**. Solo BD/backend. ⚠️ Deuda: vehículos sin tipo no cotizarán ni matchearán cuando enciendan los viajes.
23. **Registro dual de afiliados**: app (nacen `pending`) o admin (nacen `approved`); `source` + `registered_by`. Cola de pendientes = `affiliates.status = pending`.
24. **`users` sin campo `role`**: capacidades derivan de `clients`/`affiliates`.
25. **Perfil del afiliado gestionable por admin**: info básica, foto (Storage), suscripción, contraseña solo vía reset-link o temporal con cambio obligatorio. Auditado.
26. **Capacitaciones** con entidad propia; inscripción self-service llegará sin cambios de esquema.

### Tercera ronda — membresía y renombrado (v3, nuevas)

27. **Membresía de pago único** como requisito indispensable de afiliación: vitalicia, **una sola vigente** (versionada: cambiar precio/beneficios = archivar y crear), editable por admin, y **otorga los beneficios** (join `membership_benefits`).
28. **Orden del flujo**: el pago de membresía se registra **antes** de la aprobación; **aprobar exige membresía pagada** (regla dura en backend); **contratar tarifa exige membresía pagada**.
29. **Rechazo tras pago → reembolso registrado**: `membership_payments.status = refunded` con `refunded_at`/`refunded_by`. El efectivo se devuelve fuera; el rastro queda dentro.
30. **Beneficios gratuitos** (cubiertos por la membresía); `benefit_requests` exige membresía pagada; sin copagos (si algún beneficio cobrara en el futuro, se agrega registro de pago entonces).
31. **Pagos en tablas separadas** (`membership_payments`, `tariff_payments`) + **vista de unión** `v_affiliate_payments` para historiales. Cada historial nuevo = una vista/filtro, no una tabla.
32. **Renombrado global** (tabla arriba) y **glosario**: Afiliados = `affiliates` · Tarifas = `tariff_plans` · Tarifas de viaje = `fare_rules` · Membresía = `memberships`.

### Supuestos fijados (sin objeción)

Sin viajes programados · sin paradas intermedias · sin OTP SMS (email only) · soporte = tickets simples ligados a viajes.

## 4. Convenciones del modelo

- Montos en **USD**; snapshots congelan precio/tasa en cada pago/viaje.
- **Versionado**: `fare_rules` con `valid_from`/`valid_to` (null = vigente) · `tariff_plans` y `memberships` con archivado (`active=false`) + precio inmutable.
- `geography` = PostGIS (WGS84); índices GIST en refinamiento.
- Estados como enums; máquinas de estado blindadas con constraints.
- Arrays contra catálogos: validación backend + CHECK (aceptable por catálogo pequeño).
- Tipos **preliminares** hasta refinamiento. `created_at` en todas (omitido salvo relevancia).

## 5. Modelo de datos — 31 tablas en 8 dominios

### 5.1 Identidad (4)

```
users                        perfil base de clientes/afiliados (id = auth.users Supabase)
  id uuid PK · full_name · email UQ · phone · photo_url · status enum(active|suspended)

clients                      extensión rol cliente
  user_id uuid PK FK→users · avg_rating · rating_count · cancel_count

affiliates                   extensión rol afiliado (antes drivers)
  user_id uuid PK FK→users · status enum(pending|approved|suspended)
  source enum(app|admin) · registered_by FK→admins (null si vino de la app)
  current_vehicle_id FK→vehicles (null) · is_available bool
  last_location geography(Point) · last_location_at
  avg_rating · rating_count · cancel_count · contract_url (Storage)
  (cola de pendientes = status 'pending'; sub-filtro por membresía pagada
   "miembro pleno" derivado de membership_payments.status = paid)

documents                    documentos de afiliado o vehículo
  id uuid PK · affiliate_id FK (null) · vehicle_id FK (null)
  doc_type · file_url (Storage) · expires_at date · status enum(valid|expired|rejected)
  CHECK: exactamente un dueño
```

### 5.2 Administración, membresía y tarifas (7)

```
admins                       plano administrativo, auth propio
  id uuid PK · full_name · email UQ · password_hash (argon2id)
  role text default 'admin' (previsto para niveles) · status enum(active|suspended)
  created_by FK→admins (null = admin semilla)
  last_login_at · failed_login_attempts · locked_until

memberships                  la membresía (editable; UNA vigente)
  id PK · name · description · price_usd (inmutable: archivar y crear)
  active bool (constraint: solo una activa) · created_by FK→admins

membership_benefits          beneficios que otorga la membresía
  membership_id PK FK→memberships · benefit_id PK FK→benefits

membership_payments          pago ÚNICO de afiliación (vitalicio) + su historial
  id uuid PK · affiliate_id FK (único pago vigente por afiliado; refunded no cuenta)
  membership_id FK · amount_usd (snapshot) · status enum(pending|paid|refunded)
  paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins

tariff_plans                 tarifas del afiliado (antes subscription_plans)
  id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
  price_usd (inmutable) · allowed_vehicle_types smallint[] (null = todos)
  active bool · created_by FK→admins

tariff_subscriptions         la tarifa contratada (PREPAGO)
  id uuid PK · affiliate_id FK · tariff_plan_id FK
  status enum(pending_payment|active|scheduled|expired|cancelled)
  started_at · current_period_start · current_period_end · cancelled_at
  CONSTRAINTS: única 'active' y máx. una 'scheduled' por afiliado

tariff_payments              pagos de período de tarifa
  id uuid PK · tariff_subscription_id FK
  period_start · period_end · amount_usd (snapshot)
  status enum(pending|paid|overdue) · paid_at · registered_by FK→admins
```

**Vista `v_affiliate_payments`** (no es tabla): unión de `membership_payments` + `tariff_payments` normalizada (afiliado, concepto, monto, estado, fecha, admin) — alimenta el historial del perfil y la sección "Historiales" del panel.

**Máquina de estados de la tarifa contratada:** `pending_payment` → `active` → renueva mientras se pague → `expired` (vencida + gracia) | `cancelled`; `scheduled` arranca al vencer la activa.

### 5.3 Flota (2)

```
vehicle_types                catálogo: moto, carro, camioneta (extensible)
  id smallint PK · name UQ · active bool

vehicles
  id uuid PK · affiliate_id FK→affiliates
  vehicle_type_id FK (NULLABLE — solo BD/backend por ahora)
  registered_by FK→admins (null si lo registró el afiliado)
  brand · model · year · color · plate UQ
  approval_status enum(pending|approved|rejected)
```

### 5.4 Operación de viajes (5) — para el futuro módulo; sin cambios funcionales

```
trip_requests   id · client_id FK · mode enum(flat|auction) · requested_vehicle_type_id FK
                origin/destination geography(Point) · *_address
                quoted_amount_usd · offered_amount_usd · estimated_distance_km
                estimated_duration_min · search_radius_km
                status enum(searching|offered|assigned|expired|cancelled) · expires_at

trip_offers     id · request_id FK · affiliate_id FK · amount_usd
                status enum(pending|accepted|rejected|expired) · expires_at
                UNIQUE (request_id, affiliate_id)

trips           id · request_id FK UQ · client_id FK · affiliate_id FK · vehicle_id FK
                final_fare_usd · exchange_rate · estimated_* · distance_method
                status enum(assigned|arrived|in_progress|completed|cancelled)
                cancelled_by · cancel_reason · payment_confirmed
                assigned_at · arrived_at · started_at · completed_at · cancelled_at

trip_route_points  id bigint · trip_id FK · point geography(Point) · recorded_at

ratings         id · trip_id FK · rater_id FK→users · ratee_id FK→users
                score 1-5 · comment · hidden · UNIQUE (trip_id, rater_id)
```

### 5.5 Economía de viajes (2)

```
fare_rules          VERSIONADA · tarifa de VIAJE por tipo de vehículo
                    id · vehicle_type_id FK · base_usd · per_km_usd · per_min_usd
                    valid_from · valid_to (null = vigente)

time_multipliers    recargos horarios globales
                    id · label · from_time · to_time · days_of_week smallint[] · multiplier · active
```

### 5.6 Comunicación (3)

```
device_tokens    id · user_id FK→users · token UQ · platform enum(android|ios) · last_seen_at · revoked
notifications    id · user_id FK→users · type · title · body · payload jsonb · sent_at · read_at
push_campaigns   id · created_by FK→admins · audience enum(clients|affiliates|all) · title · body · sent_at · sent_count
```

### 5.7 Gremio: soporte, beneficios y capacitaciones (5)

```
support_tickets      id · trip_id FK (null) · opened_by FK→users · subject · description
                     status enum(open|in_review|resolved|closed) · resolved_by FK→admins · resolved_at

benefits             catálogo del gremio
                     id · name · description · active
                     (se otorgan vía membership_benefits; solicitarlos exige membresía pagada)

benefit_requests     id · affiliate_id FK · benefit_id FK
                     status enum(pending|approved|rejected) · notes · reviewed_by FK→admins · reviewed_at

trainings            id · title · description · location · starts_at · ends_at (null)
                     capacity (null = sin cupo) · status enum(scheduled|cancelled|completed) · created_by FK→admins

training_attendees   id · training_id FK · affiliate_id FK
                     status enum(registered|attended|absent|cancelled)
                     registered_by FK→admins (null = self-service futuro)
                     UNIQUE (training_id, affiliate_id)
```

### 5.8 Plataforma (3)

```
service_areas    id · name · area geography(Polygon) · active bool default false

app_settings     key text PK · value jsonb · description · updated_by FK→admins · updated_at
                 Claves previstas: dispatch_* (4), distance_circuity_factor, avg_speed_kmh,
                 auction_*_ttl_s (2), tracking_interval_s, tariff_grace_hours (seed 24h)

audit_logs       id bigint · actor_admin_id FK (null) · actor_user_id FK (null)
                 event_type · entity · entity_id · data jsonb · created_at
                 CHECK: máx. un actor (ambos null = sistema)
```

## 6. Alcance del módulo admin (primer entregable) — CERRADO

**Núcleo:** login admin (auth propio) · gestión de admins · afiliados (registro directo approved, cola de pendientes con sub-filtro de membresía pagada, perfil completo: info, foto, contraseña vía reset, membresía, tarifa) · **membresía** (editar precio/descripción/beneficios incluidos, registrar pagos, reembolsos) · **tarifas** (CRUD, suscripciones, pagos) · vehículos (tipo oculto) · verificación email · infraestructura push.

**Secciones agregadas (revisión del PDF):** dashboard de métricas (ahora incluye ingresos de membresías + tarifas) · documentos con alertas de vencimiento · catálogo de beneficios · visor de auditoría · capacitaciones · **sección Historiales** (vistas: pagos de membresía, pagos de tarifa, combinado por afiliado — extensible con filtros).

**Pospuesto:** pantalla de configuración (⚠️ `tariff_grace_hours` con seed) · pantalla de tarifas de viaje · clientes · monitoreo de viajes · moderación de calificaciones · tickets · envío real de push.

## 7. Requisitos cubiertos sin tabla propia

Ganancias/reportes/dashboard → consultas sobre `trips`, `tariff_payments`, `membership_payments` · historiales → vistas · llamadas/WhatsApp/navegación → deep links.

## 8. Observaciones sobre el PDF original

Cancelaciones no contempladas → decisión 1 · ambigüedad vehículos → decisión 3 · zonas tarifarias descartadas · límites geográficos → geocerca opcional · cuota semanal → evolucionó a membresía + tarifas · IDs duplicados y RNF-PERF-02 sin llenar · surge pricing fuera de alcance.

## 9. Trabajo pendiente (en orden)

1. **Regenerar diagramas y artifact** a v3 cuando el módulo admin se congele.
2. **Flujos críticos**: ciclo membresía→aprobación→tarifa→renovación→gracia→expiración (módulo admin); despacho y subasta (módulo viajes, después).
3. **Refinamiento lógico**: tipos, enums, constraints (parciales de unicidad, CHECK de arrays), índices, vista v_affiliate_payments.
4. **Matriz de permisos** (dos planos de identidad).
5. **DDL y migraciones** — solo con autorización explícita.

---
*Documento vivo. Diagramas regenerables pidiendo "regenerar diagramas BD" en cualquier sesión.*
