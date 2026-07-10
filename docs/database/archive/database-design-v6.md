# Profesionales del Volante — Diseño de base de datos (v6)

> ⚠️ **REEMPLAZADO por [database-design-v7.md](database-design-v7.md)** (2026-07-08, séptima ronda: facturación interna uniforme con anulación trazable, requerimientos obligatorios solo desde la app, adelanto de períodos en el paso 4). Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v6 cerrado (sexta ronda: beneficios por versión, versionado condicional, requerimientos, wizard de registro, ratings por rol) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 8 de julio de 2026 · reemplaza a [database-design-v5.md](database-design-v5.md)
> **Fuente:** PDF de requisitos (EDV route) + decisiones de las sesiones de diseño
> **Diagramas v6 (al día):** [database-erd-v6.png](database-erd-v6.png) (modelo completo, 5 vistas con descripciones) · [database-erd-v6-admin.png](database-erd-v6-admin.png) (módulo admin, 2 vistas en alta resolución) · [erd-svg-v6/](erd-svg-v6/) (vectoriales) · el artifact navegable sigue en v3, se regenera al congelar. Índice: [README.md](README.md).

---

## Historial de cambios v5 → v6 (sexta ronda, 2026-07-08)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Beneficios linkeados a la membresía**: vuelve `membership_benefits`; desaparece el flag `benefits.granted_by_membership`. Los miembros gozan **los beneficios de la versión que pagaron** | El beneficio es parte de la membresía (revierte "vigentes para todos" de v5) |
| 2 | **Versionado condicional**: membresía **sin pagos** se edita in place; **con pagos** editar crea una réplica nueva (con su copia de beneficios) que pasa a ser la activa. El admin siempre ve/edita la última activa | Regla explícita del negocio — mejora la inmutabilidad absoluta |
| 3 | **`membership_promotions` SUPRIMIDA** (y `promotion_id` fuera de los pagos). Tema pospuesto | Se tratará a detalle más adelante |
| 4 | **NUEVA `requirements`**: documentos exigibles configurables (chofer y vehículo), con flag obligatorio/opcional. `documents.requirement_id` reemplaza el texto libre `doc_type` | Requisito del negocio |
| 5 | **Wizard de registro del chofer en 4 pasos** (datos personales → documentos → vehículo → pago de membresía **+ tarifa**); `drivers.registration_step` rastrea el avance | Esquema definido por el negocio |
| 6 | **La tarifa se elige y paga en el paso 4** (antes de la aprobación); su período arranca **al aprobarse** (estado `scheduled`). Rechazo del aspirante → reembolso registrado de **membresía y tarifa** | Decisión del paso 4 + reglas derivadas |
| 7 | **Ratings por rol**: vuelve la tabla `clients`; `users` queda como identidad pura sin `role` ni ratings; `drivers` y `clients` llevan cada uno su rating/contadores. **Una cuenta puede ser chofer y cliente** (ambas extensiones) | Corrección: no mezclar reputación de chofer y de pasajero (reabre y cierra la decisión de ronda 4) |

**Conteo v6: 32 tablas en 8 dominios** (30 − promotions + membership_benefits + requirements + clients) + 1 vista.

## 1. Contexto del producto

Plataforma de transporte (tipo taxi/carrera) de un gremio. Roles: **Cliente** (app móvil), **Chofer** (en pantalla "Afiliado", app móvil; puede también actuar como cliente) y **Administrador** (panel web, plano aparte).

- **Pago del viaje externo**; la plataforma registra referencia y confirmación.
- **El negocio cobra al chofer**: membresía única de pago único vitalicio (miembro + beneficios de su versión) + tarifa recurrente prepago (habilita operar). Sin comisión por viaje.
- **Gremio**: aprobación con wizard de 4 pasos, requerimientos documentales configurables, contratos, beneficios, capacitaciones. **Tracking laxo**. Contexto: Venezuela.

**Orden de construcción:** primero el módulo admin completo; después las apps.

### Glosario (código vs pantalla)

| En pantalla | En código/BD | Qué es |
|---|---|---|
| Afiliado | `drivers` | El chofer miembro del gremio |
| Membresía | `memberships` | Pago único vitalicio; da los beneficios de la versión pagada |
| Tarifa | `subscription_plans` | Plan recurrente (diario→anual) que habilita operar |
| Requerimientos | `requirements` | Documentos exigibles configurables (obligatorios u opcionales) |
| Tarifa de viaje | `fare_rules` | Precio del viaje para el pasajero |

### Registro del chofer — wizard de 4 pasos (v6)

```
Paso 1  Datos personales        → users + drivers (registration_step avanza)
Paso 2  Documentos requeridos   → documents contra requirements (los is_required bloquean)
Paso 3  Datos del vehículo      → vehicles (+ documentos del vehículo según requirements)
Paso 4  Pago: membresía + tarifa → membership_payments (único) + driver_subscriptions
                                    (la tarifa queda 'scheduled': pagada, esperando inicio)
→ [pending] → admin aprueba (exige pagos) → MIEMBRO + tarifa arranca su período → [operativo]
Rechazo → reembolso registrado de membresía Y tarifa (refunded)
```

- "Miembro" se deriva de `membership_payments.status = paid` — vitalicio.
- Tarifa vencida + gracia → suspendido para operar. Adelantos de tarifa de un chofer operativo que se retira: **no reembolsables** (⚠️ en contrato).
- El registro directo por admin recorre los mismos pasos desde el panel y nace `approved`.

## 2. Arquitectura técnica (sin cambios)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

Backend Fastify único punto de entrada · identidad de apps en Supabase Auth (email verificado) · admins con auth propio (argon2id, lockout) · Storage para archivos · push FCM + Capacitor (apps) y WebSocket in-app (panel) · migraciones versionadas · sin APIs pagas en dev (PostGIS, OSM/Leaflet, Photon, deep links, FCM) · Apple Developer 99 USD/año inevitable.

## 3. Decisiones de negocio vigentes

### Dominio de viajes (sin cambios)

1. Cancelaciones con registro y métricas. 2. Moneda dual USD/Bs con tasa congelada. 3. Vehículos del chofer, admin aprueba, vehículo "actual". 4. Subasta con expiraciones, una contraoferta por chofer. 5. Tarifa plana: base + km + min × multiplicador horario. 6. Geocercas opcionales. 7. Ruta: puntos periódicos. 8. Distancia: línea recta × factor. 9. Matching: radio expansivo. 10. Cliente elige tipo de vehículo. 11. Sin cupones en viajes.

### Identidad y panel

12. **`users` = identidad pura** (sin role, sin ratings) + extensiones: **`clients`** (rating/contadores como pasajero) y **`drivers`** (rating/contadores como chofer + afiliación). Una cuenta puede tener ambas extensiones — un chofer puede ser cliente. El tipo se deriva de las extensiones.
13. `admins` aparte con auth propio; un nivel por ahora.
14. Verificación email obligatoria; sin OTP SMS.
15. Registro dual de choferes (app → `pending`; admin → `approved`); wizard de 4 pasos con `registration_step`; cola del panel con sub-filtro de pagos completados.
16. **Requerimientos configurables** (`requirements`): el admin define qué documentos se exigen (a chofer o a vehículo, `applies_to`) y si son obligatorios (`is_required`). El paso 2/3 del wizard valida los obligatorios. `documents` referencia el requerimiento que satisface.
17. Perfil del chofer gestionable por admin (info, foto, suscripciones, contraseña vía reset). Auditado.
18. Tipo de vehículo nullable + camioneta (solo BD/backend). ⚠️ Deuda para viajes.
19. Capacitaciones con entidad propia.
20. Alcance del panel: núcleo + dashboard + documentos/requerimientos con vencimientos + beneficios + auditoría + capacitaciones + historiales. Pospuesto: settings, tarifas de viaje, clientes, viajes, ratings, tickets, envío push. **Promociones de membresía: pospuesto.**

### Membresía (v6)

21. **Única, pago único, vitalicia**; una sola vigente.
22. **Versionado condicional**: sin pagos → editar in place; con pagos → réplica nueva (activa) con su copia de `membership_benefits`; la anterior se archiva. El admin siempre edita la última activa.
23. **Beneficios por versión**: el miembro goza los beneficios de la versión que pagó (`membership_payments.membership_id` → `membership_benefits` de esa versión). Los nuevos afiliados entran con la última.
24. **Flujo**: membresía y tarifa se pagan en el paso 4, antes de la aprobación; aprobar exige ambos pagos. Rechazo → reembolso registrado de ambos.
25. Solicitar un beneficio exige ser miembro y que el beneficio esté incluido **en su versión pagada**.

### Tarifas

26. Catálogo `subscription_plans` (daily→annual), inmutable por versión (mismo versionado condicional que la membresía), `allowed_vehicle_types` oculto.
27. **Una tarifa activa por chofer** (+ máx. una `scheduled`); prepago; scheduler + push; gracia (`subscription_grace_hours`, seed 24h); cambio de plan al agotarse lo pagado.
28. La primera tarifa (pagada en el registro) queda `scheduled` y **arranca al aprobarse** el chofer.
29. **Adelanto ×N**: N filas de pago pagadas con su período exacto. Adelantos no consumidos de un chofer operativo: **no reembolsables** (⚠️ contrato). Rechazo de aspirante: sí se reembolsa (registrado).
30. Pagos en tablas separadas + vista `v_driver_payments`. Sin abstracción genérica membresía/tarifa.

### Supuestos fijados

Sin viajes programados · sin paradas intermedias · soporte = tickets simples · capacitaciones por push.

## 4. Convenciones del modelo

- Montos en USD; pagos congelan monto; viajes congelan tasa.
- **Versionado condicional** en `memberships` y `subscription_plans` (in place sin ventas; réplica con ventas). `fare_rules` con `valid_from`/`valid_to`.
- `geography` = PostGIS. Enums; constraints para unicidades (una membresía activa, una tarifa activa por chofer, un pago de membresía vigente).
- Tipos preliminares hasta el refinamiento. `created_at` en todas.

## 5. Modelo de datos — 32 tablas en 8 dominios

### 5.1 Identidad y requerimientos (5)

```
users          identidad pura (id = auth.users Supabase)
               id uuid PK · full_name · email UQ · phone · photo_url
               status enum(active|suspended)

clients        extensión rol cliente (REINTRODUCIDA)
               user_id PK FK→users · avg_rating · rating_count · cancel_count

drivers        extensión rol chofer
               user_id PK FK→users · status enum(pending|approved|suspended)
               source enum(app|admin) · registered_by FK→admins (null = app)
               registration_step smallint (wizard 1-4; null = completado)
               current_vehicle_id FK→vehicles · is_available bool
               last_location geography(Point) · last_location_at
               avg_rating · rating_count · cancel_count · contract_url
               (una cuenta puede tener clients Y drivers — cada rol con su reputación)

requirements   documentos exigibles configurables (NUEVA)
               id PK · name · description · applies_to enum(driver|vehicle)
               is_required bool · active · created_by FK→admins

documents      documentos subidos contra un requerimiento
               id uuid PK · requirement_id FK→requirements
               driver_id FK (null) · vehicle_id FK (null) · file_url (Storage)
               expires_at date · status enum(valid|expired|rejected)
               CHECK: exactamente un dueño; el dueño debe corresponder al applies_to
```

### 5.2 Administración, membresía y tarifas (7)

```
admins                 id uuid PK · full_name · email UQ · password_hash (argon2id)
                       role ('admin'; previsto niveles) · status enum(active|suspended)
                       created_by FK→admins · last_login_at · failed_login_attempts · locked_until

memberships            LA membresía (una vigente; VERSIONADO CONDICIONAL)
                       id PK · name · description · price_usd
                       active bool (solo una activa) · created_by FK→admins
                       (sin pagos: se edita in place · con pagos: réplica nueva activa,
                        la anterior se archiva · el admin siempre edita la última activa)

membership_benefits    beneficios de CADA VERSIÓN de la membresía (REINTRODUCIDA)
                       membership_id PK FK · benefit_id PK FK
                       (la réplica copia y modifica esta lista; el miembro goza los de su versión)

membership_payments    el PAGO ÚNICO por chofer
                       id uuid PK · driver_id FK (único vigente; refunded no cuenta)
                       membership_id FK (versión pagada → define sus beneficios)
                       amount_usd (snapshot) · status enum(pending|paid|refunded)
                       paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins

subscription_plans     catálogo de tarifas (UI "Tarifas"; versionado condicional)
                       id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
                       price_usd · allowed_vehicle_types smallint[] (null = todos; oculto)
                       active · created_by FK→admins

driver_subscriptions   la tarifa contratada (PREPAGO)
                       id uuid PK · driver_id FK · plan_id FK
                       status enum(pending_payment|active|scheduled|expired|cancelled)
                       started_at · current_period_start · current_period_end · cancelled_at
                       CONSTRAINTS: única 'active' y máx. una 'scheduled' por chofer
                       (la primera, pagada en el paso 4, queda 'scheduled' hasta la aprobación)

subscription_payments  pagos por período (adelanto ×N genera N filas paid)
                       id uuid PK · driver_subscription_id FK
                       period_start · period_end · amount_usd (snapshot)
                       status enum(pending|paid|overdue|refunded)
                       paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins
                       (refunded: solo rechazo de aspirante; adelantos de operativos no se reembolsan)
```

**Vista `v_driver_payments`**: unión de ambas tablas de pagos para historiales.

### 5.3 Flota (2)

```
vehicle_types    id smallint PK · name UQ (moto, carro, camioneta) · active
vehicles         id · driver_id FK · vehicle_type_id FK (NULLABLE, solo BD/backend)
                 registered_by FK→admins (null = chofer) · brand · model · year · color
                 plate UQ · approval_status enum(pending|approved|rejected)
```

### 5.4 Operación de viajes (5) — módulo futuro

```
trip_requests      id · client_id FK→clients · mode enum(flat|auction) · requested_vehicle_type_id FK
                   origin/destination geography(Point) · *_address · quoted/offered_amount_usd
                   estimated_distance_km · estimated_duration_min · search_radius_km
                   status enum(searching|offered|assigned|expired|cancelled) · expires_at

trip_offers        id · request_id FK · driver_id FK · amount_usd
                   status enum(pending|accepted|rejected|expired) · expires_at
                   UNIQUE (request_id, driver_id)

trips              id · request_id FK UQ · client_id FK→clients · driver_id FK→drivers · vehicle_id FK
                   final_fare_usd · exchange_rate · estimated_* · distance_method
                   status enum(assigned|arrived|in_progress|completed|cancelled)
                   cancelled_by · cancel_reason · payment_confirmed · *_at
                   (los ratings del viaje alimentan drivers.avg_rating y clients.avg_rating
                    según el rol de cada parte — nunca se mezclan)

trip_route_points  id bigint · trip_id FK · point geography(Point) · recorded_at

ratings            id · trip_id FK · rater_id FK→users · ratee_id FK→users
                   score 1-5 · comment · hidden · UNIQUE (trip_id, rater_id)
```

### 5.5 Economía de viajes (2)

```
fare_rules        VERSIONADA · id · vehicle_type_id FK · base_usd · per_km_usd · per_min_usd
                  valid_from · valid_to (null = vigente)
time_multipliers  id · label · from_time · to_time · days_of_week smallint[] · multiplier · active
```

### 5.6 Comunicación (3)

```
device_tokens    id · user_id FK · token UQ · platform enum(android|ios) · last_seen_at · revoked
notifications    id · user_id FK · type · title · body · payload jsonb · sent_at · read_at
push_campaigns   id · created_by FK→admins · audience enum(clients|drivers|all) · title · body · sent_at · sent_count
```

### 5.7 Gremio: soporte, beneficios y capacitaciones (5)

```
benefits             catálogo puro del gremio
                     id · name · description · active
                     (se otorgan por versión de membresía vía membership_benefits)

benefit_requests     id · driver_id FK · benefit_id FK
                     status enum(pending|approved|rejected) · notes · reviewed_by FK→admins · reviewed_at
                     (backend valida: miembro + beneficio incluido en SU versión pagada)

support_tickets      id · trip_id FK (null) · opened_by FK→users · subject · description
                     status enum(open|in_review|resolved|closed) · resolved_by FK→admins · resolved_at

trainings            id · title · description · location · starts_at · ends_at · capacity
                     status enum(scheduled|cancelled|completed) · created_by FK→admins

training_attendees   id · training_id FK · driver_id FK · status enum(registered|attended|absent|cancelled)
                     registered_by FK→admins (null = self-service futuro) · UNIQUE (training_id, driver_id)
```

### 5.8 Plataforma (3)

```
service_areas    id · name · area geography(Polygon) · active default false
app_settings     key PK · value jsonb · description · updated_by FK→admins · updated_at
                 Claves: dispatch_* (4), distance_circuity_factor, avg_speed_kmh,
                 auction_*_ttl_s, tracking_interval_s, subscription_grace_hours (seed 24h)
audit_logs       id bigint · actor_admin_id FK (null) · actor_user_id FK (null)
                 event_type · entity · entity_id · data jsonb · created_at · CHECK: máx. un actor
```

## 6. Alcance del módulo admin (primer entregable)

**Núcleo:** login admin · gestión de admins · choferes (wizard de 4 pasos con seguimiento de avance, registro directo, cola de pendientes, perfil completo gestionable) · **requerimientos** (catálogo configurable con obligatoriedad) · **membresía** (edición con versionado condicional, beneficios por versión, pagos y reembolsos) · **tarifas** (catálogo, suscripciones con activación diferida, pagos, adelanto ×N) · vehículos · verificación email · infraestructura push.

**Secciones:** dashboard · documentos/requerimientos con alertas de vencimiento · beneficios · auditoría · capacitaciones · historiales (vistas).

**Pospuesto:** promociones de membresía · pantallas de settings y tarifas de viaje · clientes · viajes · ratings · tickets · envío real de push.

## 7. Cubierto sin tabla propia

Ganancias/reportes/dashboard → consultas · historiales → vistas · llamadas/WhatsApp/navegación → deep links.

## 8. Observaciones sobre el PDF original

Cancelaciones → resuelto · ambigüedad vehículos → resuelto · zonas tarifarias descartadas · límites → geocerca opcional · "cobro semanal" → membresía única + tarifas con adelantos · IDs duplicados y RNF-PERF-02 sin llenar · surge pricing fuera de alcance.

## 9. Trabajo pendiente (en orden)

1. **Regenerar paquete visual completo y artifact** al congelar el módulo admin.
2. **Flujos críticos**: wizard completo (4 pasos → aprobación → activación diferida de tarifa → renovación/adelantos → gracia → suspensión; rechazo con doble reembolso) · despacho y subasta (módulo viajes).
3. **Refinamiento lógico**: tipos, enums, constraints parciales, índices, vistas, y la lógica de réplica del versionado condicional.
4. **Matriz de permisos**. 5. **DDL y migraciones** — solo con autorización explícita.

---
*Documento vivo. Diagramas regenerables pidiendo "regenerar diagramas BD".*
