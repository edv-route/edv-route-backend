# Profesionales del Volante — Diseño de base de datos (v7)

> **Estado:** modelo conceptual v7 cerrado (séptima ronda: facturación uniforme, requerimientos por origen, adelanto en el wizard) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 8 de julio de 2026 · reemplaza a [database-design-v6.md](archive/database-design-v6.md)
> **Fuente:** PDF de requisitos (EDV route) + decisiones de las sesiones de diseño
> **Diagramas v7 (al día):** [database-erd-v7.png](database-erd-v7.png) (modelo completo, 5 vistas) · [database-erd-v7-admin.png](database-erd-v7-admin.png) (módulo admin, 2 vistas en alta resolución) · [erd-svg-v7/](erd-svg-v7/) (vectoriales) · [artifact navegable](https://claude.ai/code/artifact/73b24b23-2944-47d4-b4c7-8cb01f3c47a5) (al día en v7). Índice: [README.md](README.md).

---

## Historial de cambios v6 → v7 (séptima ronda, 2026-07-08)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Requerimientos por origen**: `is_required` solo bloquea en el registro **desde la app** (chofer y vehículo); el registro por admin puede omitir cualquier documento (queda visible como incompleto, no bloqueante) | El admin tiene los papeles en mano o criterio para postergar |
| 2 | **Paso 4 con elección**: pagar la tarifa básica (1 período) o **adelantar N períodos** del plan elegido — el adelanto ×N existente, disponible desde el registro | Confirmación del flujo |
| 3 | **NUEVA `invoices`**: facturación **uniforme** (todo pago registrado emite factura), como **comprobante interno** (no fiscal), con **anulación con rastro** (`voided`). La factura agrupa pagos: en el wizard, la #1 = membresía + primera tarifa; una factura por cada período adelantado (10 semanas → 10 facturas) | Requisito del negocio |

**Conteo v7: 33 tablas en 8 dominios** (32 + invoices) + 1 vista.

## 1. Contexto del producto

Plataforma de transporte (tipo taxi/carrera) de un gremio. Roles: **Cliente** (app), **Chofer** ("Afiliado" en pantalla, app; puede también ser cliente) y **Administrador** (panel web, plano aparte).

- **Pago del viaje externo**; la plataforma registra referencia y confirmación.
- **El negocio cobra al chofer**: membresía única de pago único vitalicio (miembro + beneficios de su versión) + tarifa recurrente prepago. Todo cobro emite **factura interna**. Sin comisión por viaje.
- **Gremio**: wizard de 4 pasos, requerimientos configurables, contratos, beneficios, capacitaciones. **Tracking laxo**. Contexto: Venezuela.

**Orden de construcción:** primero el módulo admin completo; después las apps.

### Glosario (código vs pantalla)

| En pantalla | En código/BD | Qué es |
|---|---|---|
| Afiliado | `drivers` | El chofer miembro del gremio |
| Membresía | `memberships` | Pago único vitalicio; beneficios de la versión pagada |
| Tarifa | `subscription_plans` | Plan recurrente (diario→anual) que habilita operar |
| Requerimientos | `requirements` | Documentos exigibles configurables |
| Factura / Recibo | `invoices` | Comprobante interno de cada cobro (no fiscal) |
| Tarifa de viaje | `fare_rules` | Precio del viaje para el pasajero |

### Registro del chofer — wizard de 4 pasos (v7)

```
Paso 1  Datos personales        → users + drivers (registration_step)
Paso 2  Documentos requeridos   → documents contra requirements
                                   · desde la APP: los is_required bloquean el paso
                                   · desde el ADMIN: nada bloquea (quedan visibles como incompletos)
Paso 3  Datos del vehículo      → vehicles (+ documentos; misma regla por origen)
Paso 4  Pagos                   → membresía + tarifa del plan elegido
                                   · elección: tarifa básica (1 período) o ADELANTAR N períodos
                                   · FACTURAS: la #1 agrupa membresía + tarifa período 1;
                                     una factura por cada período adicional (10 semanas → 10 facturas)
                                   · la tarifa queda 'scheduled': arranca al aprobarse
→ [pending] → admin aprueba (exige pagos) → MIEMBRO + tarifa corre → [operativo]
Rechazo → reembolso registrado de ambos pagos + facturas ANULADAS (voided, conservan número)
```

- "Miembro" se deriva del pago único `paid` — vitalicio. Tarifa vencida + gracia → suspendido para operar.
- Adelantos no consumidos de un chofer operativo: **no reembolsables** (⚠️ contrato).
- Renovaciones y adelantos posteriores emiten su factura igual (facturación uniforme).

## 2. Arquitectura técnica (sin cambios)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

Backend Fastify único punto de entrada · usuarios en Supabase Auth (email verificado) · admins con auth propio (argon2id, lockout) · Storage · push FCM (apps) y WebSocket (panel) · migraciones versionadas · sin APIs pagas en dev · Apple Developer 99 USD/año.

## 3. Decisiones de negocio vigentes

### Dominio de viajes (sin cambios)

1. Cancelaciones con registro y métricas. 2. Moneda dual USD/Bs con tasa congelada. 3. Vehículos del chofer, admin aprueba, vehículo "actual". 4. Subasta con expiraciones, una contraoferta por chofer. 5. Tarifa plana: base + km + min × multiplicador horario. 6. Geocercas opcionales. 7. Ruta: puntos periódicos. 8. Distancia: línea recta × factor. 9. Matching: radio expansivo. 10. Cliente elige tipo de vehículo. 11. Sin cupones en viajes.

### Identidad y panel

12. `users` identidad pura + extensiones `clients` y `drivers` (cada una con su reputación); una cuenta puede ser ambos.
13. `admins` aparte con auth propio; un nivel por ahora.
14. Verificación email obligatoria; sin OTP SMS.
15. Registro dual con wizard de 4 pasos (`registration_step`); por admin nacen `approved`.
16. **Requerimientos configurables** (`requirements`: `applies_to`, `is_required`): **la obligatoriedad solo aplica al registro desde la app**; el registro por admin omite libremente (visible como incompleto en el panel).
17. Perfil del chofer gestionable por admin. Auditado.
18. Tipo de vehículo nullable + camioneta (solo BD/backend). ⚠️ Deuda para viajes.
19. Capacitaciones con entidad propia.
20. Alcance del panel: núcleo + dashboard + documentos/requerimientos + beneficios + auditoría + capacitaciones + historiales (ahora con **historial de facturas**). Pospuesto: promociones, settings, tarifas de viaje, clientes, viajes, ratings, tickets, envío push.

### Membresía

21. Única, pago único, vitalicia; una vigente.
22. **Versionado condicional**: sin pagos → editar in place; con pagos → réplica activa con copia de `membership_benefits`; el admin siempre edita la última activa.
23. **Beneficios por versión**: el miembro goza los de la versión que pagó.
24. Membresía y tarifa se pagan en el paso 4; aprobar exige ambos pagos. Rechazo → doble reembolso registrado + facturas anuladas.
25. Solicitar beneficio: miembro + beneficio incluido en su versión pagada.

### Tarifas

26. Catálogo `subscription_plans` (daily→annual), versionado condicional, `allowed_vehicle_types` oculto.
27. Una tarifa activa por chofer (+ máx. una `scheduled`); prepago; scheduler + push; gracia (`subscription_grace_hours`, seed 24h); cambio de plan al agotarse lo pagado.
28. La primera tarifa (pagada en el wizard) queda `scheduled` y arranca al aprobarse.
29. **Adelanto ×N** (disponible desde el paso 4 y en renovaciones): N filas de pago pagadas con su período exacto. Adelantos de operativos no reembolsables; rechazo de aspirante sí (registrado).
30. Pagos en tablas separadas + vista `v_driver_payments`.

### Facturación (v7 — nueva)

31. **Facturación uniforme**: toda recepción de pago registrada emite su factura (`invoices`), que **agrupa pagos** (sus líneas son los pagos que la referencian). En el wizard: factura #1 = membresía + tarifa período 1; una factura por período adicional.
32. **Comprobante interno, no fiscal**: numeración secuencial propia. ⚠️ Si el negocio requiere factura fiscal (SENIAT: numeración autorizada, imprenta digital/máquina fiscal), es un análisis aparte con el contador — el modelo no lo cubre aún y el nombre en pantalla debe ser honesto ("recibo") mientras tanto.
33. **Anulación con rastro**: reembolsos anulan la factura (`voided` + fecha + admin) conservando su número — sin huecos de numeración.

### Supuestos fijados

Sin viajes programados · sin paradas intermedias · soporte = tickets simples · capacitaciones por push.

## 4. Convenciones del modelo

- Montos en USD; pagos y facturas congelan montos; viajes congelan tasa.
- **Versionado condicional** en `memberships`/`subscription_plans`; `fare_rules` con `valid_from`/`valid_to`.
- `geography` = PostGIS. Enums; constraints para unicidades. Documentos que representan dinero nunca se borran: se anulan con rastro.
- Tipos preliminares hasta el refinamiento. `created_at` en todas.

## 5. Modelo de datos — 33 tablas en 8 dominios

### 5.1 Identidad y requerimientos (5)

```
users          identidad pura (id = auth.users Supabase)
               id uuid PK · full_name · email UQ · phone · photo_url · status enum(active|suspended)

clients        extensión rol cliente
               user_id PK FK→users · avg_rating · rating_count · cancel_count

drivers        extensión rol chofer
               user_id PK FK→users · status enum(pending|approved|suspended)
               source enum(app|admin) · registered_by FK→admins (null = app)
               registration_step smallint (wizard 1-4; null = completado)
               current_vehicle_id FK→vehicles · is_available bool
               last_location geography(Point) · last_location_at
               avg_rating · rating_count · cancel_count · contract_url

requirements   documentos exigibles configurables
               id PK · name · description · applies_to enum(driver|vehicle)
               is_required bool (solo bloquea registro desde la APP) · active · created_by FK→admins

documents      documentos subidos contra un requerimiento
               id uuid PK · requirement_id FK→requirements
               driver_id FK (null) · vehicle_id FK (null) · file_url (Storage)
               expires_at date · status enum(valid|expired|rejected)
               CHECK: exactamente un dueño, correspondiente al applies_to
```

### 5.2 Administración, membresía, tarifas y facturación (8)

```
admins                 id uuid PK · full_name · email UQ · password_hash (argon2id)
                       role ('admin') · status enum(active|suspended) · created_by FK→admins
                       last_login_at · failed_login_attempts · locked_until

memberships            LA membresía (una vigente; versionado condicional)
                       id PK · name · description · price_usd · active · created_by FK→admins

membership_benefits    beneficios de cada versión
                       membership_id PK FK · benefit_id PK FK

membership_payments    el pago único por chofer
                       id uuid PK · driver_id FK (único vigente) · membership_id FK (versión pagada)
                       invoice_id FK→invoices · amount_usd (snapshot)
                       status enum(pending|paid|refunded)
                       paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins

subscription_plans     catálogo de tarifas (versionado condicional)
                       id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
                       price_usd · allowed_vehicle_types smallint[] (null = todos; oculto)
                       active · created_by FK→admins

driver_subscriptions   la tarifa contratada (PREPAGO)
                       id uuid PK · driver_id FK · plan_id FK
                       status enum(pending_payment|active|scheduled|expired|cancelled)
                       started_at (la del wizard arranca al aprobar) · current_period_start/end · cancelled_at
                       CONSTRAINTS: única 'active' y máx. una 'scheduled' por chofer

subscription_payments  pagos por período (adelanto ×N = N filas paid)
                       id uuid PK · driver_subscription_id FK · invoice_id FK→invoices
                       period_start · period_end · amount_usd (snapshot)
                       status enum(pending|paid|overdue|refunded)
                       paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins

invoices               comprobante interno de cada cobro (NUEVA)
                       id uuid PK · invoice_number UQ (secuencial legible, ej. 2026-000123)
                       driver_id FK→drivers · issued_at · total_usd (snapshot del documento)
                       status enum(issued|voided) · voided_at · voided_by FK→admins
                       registered_by FK→admins
                       (agrupa pagos: sus líneas son los pagos con invoice_id apuntando a ella;
                        wizard: #1 = membresía + tarifa 1; una por período adelantado)
```

**Vista `v_driver_payments`**: unión de ambas tablas de pagos (ahora con número de factura) para historiales.

### 5.3 Flota (2)

```
vehicle_types    id smallint PK · name UQ (moto, carro, camioneta) · active
vehicles         id · driver_id FK · vehicle_type_id FK (NULLABLE) · registered_by FK→admins
                 brand · model · year · color · plate UQ · approval_status enum(pending|approved|rejected)
```

### 5.4 Operación de viajes (5) — módulo futuro

```
trip_requests      id · client_id FK→clients · mode enum(flat|auction) · requested_vehicle_type_id FK
                   origin/destination geography(Point) · *_address · quoted/offered_amount_usd
                   estimated_* · search_radius_km · status enum(searching|offered|assigned|expired|cancelled)
                   expires_at

trip_offers        id · request_id FK · driver_id FK · amount_usd
                   status enum(pending|accepted|rejected|expired) · expires_at · UNIQUE (request_id, driver_id)

trips              id · request_id FK UQ · client_id FK · driver_id FK · vehicle_id FK
                   final_fare_usd · exchange_rate · estimated_* · distance_method
                   status enum(assigned|arrived|in_progress|completed|cancelled)
                   cancelled_by · cancel_reason · payment_confirmed · *_at

trip_route_points  id bigint · trip_id FK · point geography(Point) · recorded_at

ratings            id · trip_id FK · rater_id FK→users · ratee_id FK→users · score 1-5
                   comment · hidden · UNIQUE (trip_id, rater_id)
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

### 5.7 Gremio (5)

```
benefits             id · name · description · active
benefit_requests     id · driver_id FK · benefit_id FK · status enum(pending|approved|rejected)
                     notes · reviewed_by FK→admins · reviewed_at
                     (valida: miembro + beneficio en SU versión pagada)
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

**Núcleo:** login admin · gestión de admins · choferes (wizard con reglas por origen, cola de pendientes, perfil gestionable) · requerimientos configurables · membresía (versionado condicional, beneficios por versión, pagos/reembolsos) · tarifas (catálogo, suscripciones con activación diferida, adelanto ×N) · **facturación interna** (emisión automática al registrar cobros, anulación con rastro, numeración secuencial) · vehículos · verificación email · infraestructura push.

**Secciones:** dashboard · documentos/requerimientos con alertas · beneficios · auditoría · capacitaciones · historiales (pagos + **facturas**).

**Pospuesto:** promociones de membresía · factura fiscal (SENIAT — con el contador) · settings y tarifas de viaje · clientes · viajes · ratings · tickets · envío real de push.

## 7. Cubierto sin tabla propia

Ganancias/reportes/dashboard → consultas (los ingresos ahora también por factura) · historiales → vistas · deep links.

## 8. Observaciones sobre el PDF original

Cancelaciones → resuelto · ambigüedad vehículos → resuelto · zonas tarifarias descartadas · límites → geocerca opcional · "cobro semanal" → membresía + tarifas con adelantos y facturación · IDs duplicados y RNF-PERF-02 sin llenar · surge pricing fuera de alcance.

## 9. Trabajo pendiente (en orden)

1. **Regenerar paquete visual y artifact** (los actuales v6 no incluyen `invoices`).
2. **Flujos críticos**: wizard completo con facturación (pasos 1-4 según origen → aprobación → activación → renovación/adelantos con facturas → gracia → suspensión; rechazo con doble reembolso y anulación de facturas) · despacho y subasta (módulo viajes).
3. **Refinamiento lógico**: tipos, enums, constraints, índices, vistas, numeración secuencial de facturas (secuencia por año), lógica de réplica del versionado condicional.
4. **Matriz de permisos**. 5. **DDL y migraciones** — solo con autorización explícita.

## 10. Hacia v8 (aprobado, próximo a implementar)

- **Rediseño del estado del chofer** (modelo cerrado 2026-07-23): el estado se modela como
  **`driver_status` + el boolean `is_available`**. El enum lleva la *situación* y se amplía
  (sin backfill; `approved` **permanece** como estado sano base, badge visible) con `paused`
  (licencia administrativa: deuda 0, congela la tarifa, la pone el admin), `overdue` (mora) y
  `penalized`. El boolean `is_available` lleva la *disponibilidad* voluntaria del chofer
  (`active`/`inactive`, default `true`, no congela la tarifa), ortogonal al enum.
  `overdue`/`penalized` los deriva el motor de deuda (nunca a mano; override = pago externo).
  **Dividido en fases**: A (enum + `paused`) ejecutable ya; B (`overdue`/`penalized` + motor)
  depende de la propuesta de tarifa. Espec:
  [proposals/estados-del-chofer/](../proposals/estados-del-chofer/README.md).
- **Tarifa con deuda y penalización**: motor de mora/penalización que dispara `overdue`/
  `penalized`. Espec: [proposals/tarifa-penalizacion/](../proposals/tarifa-penalizacion/README.md).

Ambas son el mismo esfuerzo (Fase B) y requieren migración de enums + regeneración de modelos.

---
*Documento vivo. Diagramas regenerables pidiendo "regenerar diagramas BD".*
