# Profesionales del Volante — Diseño de base de datos (v5)

> ⚠️ **REEMPLAZADO por [database-design-v6.md](database-design-v6.md)** (2026-07-08, sexta ronda: beneficios por versión con versionado condicional, promociones suprimidas, tabla de requerimientos, wizard de 4 pasos con tarifa incluida, ratings por rol con clients reintroducida). Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v5 cerrado (quinta ronda: membresía única de pago único con promociones; adelanto de períodos en tarifas) · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 8 de julio de 2026 · reemplaza a [database-design-v4.md](database-design-v4.md)
> **Fuente:** PDF de requisitos (EDV route, Ing. Yornel Marval) + decisiones de las sesiones de diseño (confirmaciones de la dueña)
> **Diagramas:** [database-erd-v5-admin.png](database-erd-v5-admin.png) (módulo admin v5 con membresía, promociones, beneficios y tarifas — al día) · [database-erd-v4.png](database-erd-v4.png) (modelo completo, ⚠️ refleja v4 en el bloque de membresías) · regenerar el paquete completo al congelar. Índice: [README.md](README.md).

---

## Historial de cambios v4 → v5 (quinta ronda, 2026-07-08 — confirmado por la dueña)

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Membresía vuelve a ÚNICA con PAGO ÚNICO vitalicio** (revierte las membresías múltiples recurrentes de v4); `membership_subscriptions` eliminada; `membership_payments` vuelve a un pago por chofer | Confirmación de la dueña |
| 2 | **NUEVA `membership_promotions`**: ventanas temporales (~1 año) con descuento (porcentaje o monto fijo) sobre el pago de membresía; solo una activa a la vez; aplicación automática | Requisito de la dueña |
| 3 | **Beneficios de membresía globales y vigentes**: todos los miembros gozan de los beneficios actuales de la empresa; la versión pagada congela solo el precio. `membership_benefits` eliminada → flag `benefits.granted_by_membership` | Respuesta a la ambigüedad del vitalicio (regla de los 150 ajustada: solo precio) |
| 4 | **Adelanto de períodos en tarifas**: "pago × N" genera N filas de pago pagadas, cada una con su período exacto. Cero cambios de esquema | Caso de las 10 semanas |
| 5 | **Períodos adelantados no consumidos: NO reembolsables** (regla dura elegida; ⚠️ debe constar en el contrato de afiliación) | Decisión de negocio |
| 6 | `membership_grace_hours` desaparece (la membresía no vence) | Consecuencia del pago único |

**Conteo v5: 30 tablas en 8 dominios** (31 − membership_subscriptions − membership_benefits + membership_promotions) + 1 vista (`v_driver_payments`).

## 1. Contexto del producto

Plataforma de transporte (tipo taxi/carrera) de un gremio. Roles: **Usuario** (cliente, app móvil), **Chofer** (en pantalla "Afiliado", app móvil) y **Administrador** (panel web, plano aparte).

- **Pago del viaje externo**; la plataforma registra referencia y confirmación.
- **El negocio cobra al chofer**: membresía única de pago único (lo hace miembro de por vida y da acceso a los beneficios vigentes) + tarifa recurrente prepago (diaria a anual, lo habilita a operar). Sin comisión por viaje.
- **Modo subasta/negociación** además de tarifa plana. **Gremio**: aprobación, contratos, beneficios, capacitaciones. **Tracking laxo**. Contexto: Venezuela.

**Orden de construcción:** primero el módulo admin completo; después las apps.

### Glosario (código vs pantalla)

| En pantalla | En código/BD | Qué es |
|---|---|---|
| Afiliado | `drivers` / `driver_id` | El chofer miembro del gremio |
| Membresía | `memberships` | Pago único vitalicio que hace miembro y da los beneficios vigentes |
| Promoción | `membership_promotions` | Descuento temporal sobre el pago de membresía |
| Tarifa | `subscription_plans` | Plan recurrente (diario→anual) que habilita operar |
| Tarifa de viaje | `fare_rules` | Precio del viaje para el pasajero |

### Ciclo de vida del chofer (v5)

```
Registro (app o admin) → [pending] → paga LA MEMBRESÍA una sola vez
  (si hay promoción vigente, el descuento se aplica automáticamente)
  → admin aprueba (exige membresía pagada) → [MIEMBRO de por vida: beneficios vigentes]
  → contrata TARIFA (prepago; puede adelantar N períodos) → [operativo]
  → renueva tarifa cada período · tarifa vencida + gracia → suspendido para operar
Rechazo tras pago de membresía → reembolso registrado (refunded)
Adelantos de tarifa no consumidos → NO reembolsables (⚠️ en contrato)
```

"Miembro" se deriva de `membership_payments.status = paid` — vitalicio, no se almacena ni vence.

## 2. Arquitectura técnica (sin cambios)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

- Backend propio Fastify, único punto de entrada; las apps jamás tocan la BD.
- Dos planos de identidad: usuarios/choferes en Supabase Auth · admins con auth propio (argon2id, lockout).
- Supabase = Postgres + PostGIS + Auth (apps) + Storage. Push FCM + Capacitor; admin por WebSocket.
- Migraciones versionadas · pool propio · RLS opcional como defensa en profundidad.
- Sin APIs pagas en dev: PostGIS (distancia = línea recta × circuity factor), Leaflet/MapLibre + OSM, Photon, deep link a Google Maps, FCM. Costo inevitable: Apple Developer 99 USD/año.

## 3. Decisiones de negocio vigentes

### Dominio de viajes (sin cambios)

1. Cancelaciones: ambos roles, con registro y métricas. 2. Moneda dual USD/Bs con tasa congelada por viaje. 3. Vehículos del chofer, admin aprueba, vehículo "actual". 4. Subasta: expiraciones configurables, una contraoferta por chofer. 5. Tarifa plana: base + km + min por tipo de vehículo × multiplicador horario. 6. Geocercas opcionales apagadas. 7. Ruta: puntos periódicos. 8. Distancia: línea recta × factor, `distance_method` preparado. 9. Matching: radio expansivo con tope + expiración. 10. Cliente elige tipo de vehículo. 11. Promociones de viajes: solo campañas push, sin cupones (las promociones de membresía son otra cosa — ver 21).

### Identidad y panel

12. Dos tipos de usuario en `users` (`role: user | driver`); `admins` aparte con auth propio en Fastify. Una cuenta = un tipo.
13. Verificación email obligatoria (Supabase Auth); sin OTP SMS.
14. Registro dual de choferes (app → `pending`; admin → `approved`); cola = `drivers.status = pending`, sub-filtro por membresía pagada.
15. Perfil del chofer gestionable por admin (info, foto, suscripciones, contraseña solo vía reset). Auditado.
16. Tipo de vehículo nullable + camioneta; solo BD/backend. ⚠️ Deuda para el módulo de viajes.
17. Capacitaciones con entidad propia.
18. Alcance del panel: núcleo + dashboard + documentos con vencimientos + beneficios + auditoría + capacitaciones + historiales. Pospuesto: pantallas de settings y tarifas de viaje, y todo lo dependiente de apps/viajes.

### Membresía (v5 — confirmada por la dueña)

19. **Membresía única de pago único, vitalicia**: un solo pago afiliará al chofer de por vida. Una sola membresía vigente (versionada: editar precio = archivar y crear; la versión congela **solo el precio** pagado).
20. **Beneficios globales y vigentes**: todos los miembros gozan de los beneficios actuales de la empresa (`benefits.granted_by_membership = true`); los cambios de beneficios aplican a todos por igual, sin listas por versión.
21. **Promociones de membresía** (`membership_promotions`): ventanas temporales (ej. un año) con descuento **porcentual o de monto fijo**; **solo una activa a la vez** (constraint); **aplicación automática** a todo pago registrado durante su vigencia — el admin no decide el precio, lo ve calculado. El pago congela el monto final y la promoción aplicada.
22. **Flujo**: el pago de membresía ocurre antes de la aprobación; aprobar exige pago; contratar tarifa exige ser miembro. Rechazo tras pago → reembolso registrado.
23. Solicitar un beneficio (`benefit_requests`) exige ser miembro y que el beneficio esté actualmente otorgado por la membresía.

### Tarifas (prepago recurrente)

24. Catálogo de tarifas (`subscription_plans`, UI "Tarifas"): daily/weekly/monthly/annual; inmutables por versión; `allowed_vehicle_types` array nullable oculto en frontend.
25. **Una tarifa activa por chofer** (+ máx. una `scheduled`); prepago; scheduler genera el pago siguiente antes del vencimiento (+ push); gracia configurable (`subscription_grace_hours`, seed 24h); vencida + gracia → suspendido para operar; cambio de plan al vencer lo pagado.
26. **Adelanto de períodos ("pago × N")**: el admin registra el adelanto y el sistema genera N filas de pago pagadas, cada una con su período exacto y misma fecha de registro. Granularidad completa en historiales y reportes. El cambio de plan programado arranca al agotarse lo pagado.
27. **Adelantos no consumidos: NO reembolsables** (retiro o suspensión). ⚠️ Debe constar en el contrato de afiliación — riesgo de conflicto si no se comunica.
28. Pagos en tablas separadas + vista `v_driver_payments` para historiales. No se fusionan membresía y tarifa en una abstracción genérica.

### Supuestos fijados

Sin viajes programados · sin paradas intermedias · soporte = tickets simples · capacitaciones notificadas por push.

## 4. Convenciones del modelo

- Montos en **USD**; los pagos congelan monto final (y promoción aplicada); los viajes congelan tasa USD→Bs.
- **Inmutabilidad por versión** en planes vendibles (`memberships`: solo precio; `subscription_plans`: precio y atributos). `fare_rules` versionada con `valid_from`/`valid_to`.
- `geography` = PostGIS. Enums para estados; constraints blindan máquinas de estado y unicidades (una tarifa activa, una promoción activa, un pago de membresía vigente).
- Tipos **preliminares** hasta el refinamiento. `created_at` en todas las tablas.

## 5. Modelo de datos — 30 tablas en 8 dominios

### 5.1 Identidad (3)

```
users        id uuid PK (ref auth.users) · role enum(user|driver) · full_name · email UQ
             phone · photo_url · status enum(active|suspended)
             avg_rating · rating_count · cancel_count (comunes a ambos tipos)

drivers      user_id PK FK→users · status enum(pending|approved|suspended)
             source enum(app|admin) · registered_by FK→admins (null = app)
             current_vehicle_id FK→vehicles · is_available bool
             last_location geography(Point) · last_location_at · contract_url

documents    id · driver_id FK (null) · vehicle_id FK (null) · doc_type
             file_url (Storage) · expires_at date · status enum(valid|expired|rejected)
             CHECK: exactamente un dueño
```

### 5.2 Administración, membresía y tarifas (7)

```
admins                   id uuid PK · full_name · email UQ · password_hash (argon2id)
                         role text ('admin'; previsto para niveles) · status enum(active|suspended)
                         created_by FK→admins (null = semilla) · last_login_at
                         failed_login_attempts · locked_until

memberships              LA membresía (una vigente; versionada — la versión congela el precio)
                         id PK · name · description · price_usd
                         active bool (constraint: solo una activa) · created_by FK→admins

membership_promotions    promociones de membresía (NUEVA en v5)
                         id PK · membership_id FK · name
                         discount_type enum(percent|fixed) · discount_value numeric
                         starts_at · ends_at (ventana, ej. 1 año)
                         active bool (constraint: solo una activa) · created_by FK→admins
                         (aplicación AUTOMÁTICA durante la vigencia)

membership_payments      el PAGO ÚNICO de afiliación por chofer
                         id uuid PK · driver_id FK (único pago vigente; refunded no cuenta)
                         membership_id FK (versión pagada) · promotion_id FK (null = precio base)
                         amount_usd (snapshot del precio FINAL con descuento)
                         status enum(pending|paid|refunded)
                         paid_at · refunded_at · refunded_by FK→admins · registered_by FK→admins

subscription_plans       catálogo de tarifas (UI "Tarifas"; versiones inmutables)
                         id PK · name · description · billing_period enum(daily|weekly|monthly|annual)
                         price_usd · allowed_vehicle_types smallint[] (null = todos; oculto)
                         active bool · created_by FK→admins

driver_subscriptions     la tarifa contratada (PREPAGO; admite adelanto de N períodos)
                         id uuid PK · driver_id FK · plan_id FK
                         status enum(pending_payment|active|scheduled|expired|cancelled)
                         started_at · current_period_start · current_period_end · cancelled_at
                         CONSTRAINTS: única 'active' y máx. una 'scheduled' por chofer

subscription_payments    pagos por período de la tarifa (el adelanto genera N filas paid)
                         id uuid PK · driver_subscription_id FK
                         period_start · period_end · amount_usd (snapshot)
                         status enum(pending|paid|overdue|refunded*)
                         paid_at · registered_by FK→admins
                         (*refunded existe solo como salvaguarda de auditoría; política vigente:
                          adelantos no consumidos NO se reembolsan)
```

**Vista `v_driver_payments`**: unión de membership_payments + subscription_payments para el historial del perfil y la sección Historiales.

**Estados de la tarifa contratada:** `pending_payment` → `active` → renueva mientras se pague (o consuma adelantos) → `expired` (vencida + gracia) | `cancelled`; `scheduled` arranca al agotarse lo pagado.

### 5.3 Flota (2)

```
vehicle_types    id smallint PK · name UQ (moto, carro, camioneta) · active
vehicles         id · driver_id FK · vehicle_type_id FK (NULLABLE, solo BD/backend)
                 registered_by FK→admins (null = chofer) · brand · model · year · color
                 plate UQ · approval_status enum(pending|approved|rejected)
```

### 5.4 Operación de viajes (5) — módulo futuro

```
trip_requests      id · client_id FK→users · mode enum(flat|auction) · requested_vehicle_type_id FK
                   origin/destination geography(Point) · *_address · quoted/offered_amount_usd
                   estimated_distance_km · estimated_duration_min · search_radius_km
                   status enum(searching|offered|assigned|expired|cancelled) · expires_at

trip_offers        id · request_id FK · driver_id FK · amount_usd
                   status enum(pending|accepted|rejected|expired) · expires_at
                   UNIQUE (request_id, driver_id)

trips              id · request_id FK UQ · client_id FK · driver_id FK · vehicle_id FK
                   final_fare_usd · exchange_rate · estimated_* · distance_method
                   status enum(assigned|arrived|in_progress|completed|cancelled)
                   cancelled_by · cancel_reason · payment_confirmed · *_at timestamps

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
push_campaigns   id · created_by FK→admins · audience enum(users|drivers|all) · title · body · sent_at · sent_count
```

### 5.7 Gremio: soporte, beneficios y capacitaciones (5)

```
benefits             catálogo del gremio
                     id · name · description · active
                     granted_by_membership bool  ← qué otorga la membresía HOY (lista global,
                     editable desde la pantalla de membresía; sin listas por versión)

benefit_requests     id · driver_id FK · benefit_id FK
                     status enum(pending|approved|rejected) · notes · reviewed_by FK→admins · reviewed_at
                     (backend valida: miembro + beneficio actualmente otorgado por la membresía)

support_tickets      id · trip_id FK (null) · opened_by FK→users · subject · description
                     status enum(open|in_review|resolved|closed) · resolved_by FK→admins · resolved_at

trainings            id · title · description · location · starts_at · ends_at · capacity (null = sin cupo)
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
                 event_type · entity · entity_id · data jsonb · created_at
                 CHECK: máx. un actor
```

## 6. Alcance del módulo admin (primer entregable)

**Núcleo:** login admin · gestión de admins · choferes (registro dual, cola de pendientes con sub-filtro de membresía pagada, perfil completo gestionable) · **membresía** (editar con versionado de precio, beneficios globales por flag, **promociones** con activación única y aplicación automática, registro de pagos y reembolsos) · **tarifas** (catálogo, suscripciones, pagos, **adelanto × N períodos**) · vehículos · verificación email · infraestructura push.

**Secciones agregadas:** dashboard (ingresos de membresías + tarifas; con adelantos, reportable por fecha de cobro o por período cubierto) · documentos con vencimientos · beneficios · auditoría · capacitaciones · Historiales (vistas).

**Pospuesto:** pantallas de settings y tarifas de viaje · usuarios/clientes · viajes · ratings · tickets · envío real de push.

## 7. Cubierto sin tabla propia

Ganancias/reportes/dashboard → consultas · historiales → vistas · llamadas/WhatsApp/navegación → deep links.

## 8. Observaciones sobre el PDF original

Cancelaciones no contempladas → resuelto · ambigüedad vehículos → resuelto · zonas tarifarias descartadas · límites geográficos → geocerca opcional · "cobro semanal" del PDF → evolucionó a membresía única + tarifas recurrentes con adelantos · IDs duplicados y RNF-PERF-02 sin llenar · surge pricing fuera de alcance.

## 9. Trabajo pendiente (en orden)

1. **Regenerar diagramas, imágenes y artifact** a v5 al congelar el módulo admin.
2. **Flujos críticos**: afiliación completa (pago con promoción → aprobación → tarifa → renovación/adelantos → gracia → suspensión) · despacho y subasta (módulo viajes).
3. **Refinamiento lógico**: tipos, enums, constraints parciales (única membresía activa, única promoción activa, única tarifa activa, único pago vigente), índices, vistas.
4. **Matriz de permisos** (dos planos de identidad).
5. **DDL y migraciones** — solo con autorización explícita.

---
*Documento vivo. Diagramas regenerables pidiendo "regenerar diagramas BD".*
