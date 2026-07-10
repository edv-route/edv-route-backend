# Profesionales del Volante — Diseño de base de datos (v1)

> ⚠️ **REEMPLAZADO por [database-design-v2.md](database-design-v2.md)** (2026-07-07, segundo enfoque: módulo admin).
> Cambios mayores en v2: planes de afiliación reemplazan cuotas semanales, tabla `admins` separada con auth propio,
> `driver_applications` eliminada, tipo de vehículo nullable + camioneta. Este archivo queda como registro histórico.

> **Estado:** modelo conceptual v1 cerrado · pendiente: flujos críticos, refinamiento lógico, matriz de permisos, DDL
> **Fecha:** 7 de julio de 2026
> **Fuente de requisitos:** "Requisitos: Aplicación Profesionales del Volante" (EDV route, Ing. Yornel Marval) — PDF
> **Diagramas:** [database-erd-v1.png](database-erd-v1.png) (alta resolución) · [erd-svg/](erd-svg/) (vectoriales) · [documento navegable](https://claude.ai/code/artifact/73b24b23-2944-47d4-b4c7-8cb01f3c47a5)

---

## 1. Contexto del producto

Plataforma de solicitud y despacho de transporte (tipo taxi/carrera) con tres roles: **Cliente** (app móvil), **Conductor afiliado** (app móvil) y **Administrador** (panel web). Particularidades que la distinguen de un clon de Uber y que gobiernan el diseño:

- **El pago del viaje es externo**: se acuerda entre cliente y conductor (efectivo/acordado). La plataforma solo registra la tarifa de referencia y si el pago fue confirmado.
- **El negocio vive de la cuota semanal del afiliado** (distinta para motos y carros), no de comisión por viaje. El módulo financiero real es la membresía.
- **Modo subasta/negociación**: además de la tarifa plana calculada por el sistema, el cliente puede ofertar un monto y los conductores contraofertan.
- **Es un gremio**: afiliación con aprobación, contratos, capacitaciones y beneficios (House Market, servicios hospitalarios).
- **Tracking deliberadamente laxo**: posiciones periódicas (por cambio de estado o intervalo), no streaming continuo.
- Contexto operativo: Venezuela (moneda dual, WhatsApp, motorizados).

## 2. Arquitectura técnica (decidida)

```
Apps móviles (Capacitor, Android/iOS)  ─┐
                                        ├──► Backend Node.js + Fastify ──► PostgreSQL + PostGIS
Panel admin (web, responsive)          ─┘        (REST + WebSockets)         (alojado en Supabase)
```

- **Backend propio Fastify** como único punto de entrada. Las apps **jamás** tocan la base de datos directamente (no usar el SDK cliente de Supabase para datos). Razones: el despacho y la subasta son procesos con estado y timeouts (requieren proceso persistente con scheduler), WebSockets propios para tracking y negociación, autorización compleja de 3 roles en middleware testeable, y jobs programados (cuotas semanales, expiraciones).
- **Supabase** se usa como: PostgreSQL gestionado con PostGIS (+ backups, RNF-RELI-01), **Supabase Auth** como proveedor de identidad (la app obtiene JWT; Fastify solo verifica la firma), y **Storage** para archivos (fotos, documentos, contratos).
- **RLS** queda como defensa en profundidad opcional — la autorización principal vive en Fastify.
- **Notificaciones**: FCM + Capacitor Notifications para las apps móviles (gratis); el panel admin recibe alertas in-app por WebSocket (sin FCM web).
- **Migraciones** del esquema versionadas en el repo del backend (nunca cambios manuales en el dashboard).
- Conexión a Postgres con pool propio; si Fastify escala horizontal, usar el pooler de Supabase (Supavisor).
- Lógica: cálculo de tarifas y matching en servicios de Node; las consultas geoespaciales son SQL/PostGIS ejecutado por el backend.

### Restricciones de costos (fase de desarrollo)

Minimizar APIs pagas:

| Necesidad | Solución gratuita |
|---|---|
| Distancia para tarifa | PostGIS (geodésica origen→destino) × factor de corrección |
| Mapa en las apps | Leaflet / MapLibre GL + tiles OpenStreetMap (MapTiler free tier en prod) |
| Autocompletado de direcciones | Photon (Komoot) o Nominatim |
| Navegación del conductor | Deep link a la app de Google Maps (RF-CON-NAV-01, sin API) |
| Push | FCM (gratuito) |

Costo inevitable: cuenta Apple Developer (99 USD/año) para publicar en iOS.

## 3. Decisiones de negocio cerradas

1. **Cancelaciones**: cliente y conductor pueden cancelar según el estado del viaje. Se registra quién y el motivo (`trips.cancelled_by`, `cancel_reason`) y alimenta contadores (`cancel_count`) para métricas/penalización.
2. **Moneda dual**: tarifas ancladas en **USD**; cada viaje congela `exchange_rate` USD→Bs del momento. El histórico nunca se distorsiona por inflación.
3. **Vehículos**: propiedad del conductor; el admin los aprueba. El conductor marca su vehículo **actual** (`drivers.current_vehicle_id`, imposible tener dos activos).
4. **Subasta**: la solicitud y las contraofertas **expiran** (tiempo configurable por admin). **Una contraoferta por conductor** por solicitud (UNIQUE request+driver).
5. **Cuota semanal**: el admin registra el pago recibido (dinero fuera del sistema); si la semana vence sin pago, el estado pasa a `overdue` y el conductor se **suspende automáticamente** (no recibe solicitudes).
6. **Tarifa plana**: `base + km + minuto` según tipo de vehículo, × **multiplicador por franja horaria** (ej. nocturno). Sin recargos por zona.
7. **Área de servicio**: el modelo soporta geocercas (polígonos PostGIS) configurables, **apagadas por defecto** — sin área activa no hay restricción geográfica. El servicio funciona alrededor del punto de origen del cliente.
8. **Ruta real**: se persisten los **puntos periódicos** del tracking por viaje (`trip_route_points`) — evidencia para disputas sin costo de streaming.
9. **Identidad**: Supabase Auth (registro, verificación email, recuperación de contraseña); Fastify verifica JWT.
10. **Distancia sin APIs**: línea recta (geodésica PostGIS) × `distance_circuity_factor` configurable (~1.3); tiempo estimado = distancia corregida ÷ `avg_speed_kmh` configurable. `trips.distance_method` (`straight`/`route`) prepara la migración futura a servicio de rutas sin contaminar el histórico.
11. **Matching (tarifa plana)**: **broadcast con radio expansivo** — se notifica a todos los conductores disponibles del tipo de vehículo pedido dentro del radio; sin aceptación en X segundos, el radio crece y se re-notifica. Parámetros en `app_settings`: radio inicial, incremento, intervalo, **radio máximo**. La solicitud guarda su oleada vigente (`search_radius_km`). Tope: al llegar al radio máximo sigue re-notificando hasta la **expiración global** de la solicitud.
12. **El cliente elige el tipo de vehículo** (moto/carro) al solicitar (`requested_vehicle_type_id`); la cotización usa la tarifa de ese tipo y solo se notifica a conductores con vehículo actual de ese tipo.
13. **Promociones**: solo campañas push de marketing del admin (`push_campaigns`). Sin cupones ni descuentos que alteren tarifas.

### Supuestos fijados (nadie los ha objetado)

- Sin viajes programados a futuro. Sin paradas intermedias (un origen, un destino).
- Sin verificación de teléfono por SMS (OTP es pago); verificación solo por email.
- Soporte (RF-ADM-SUPPORT-01) = tickets simples ligados a viajes, no chat en vivo.

## 4. Convenciones del modelo

- Montos en **USD** como ancla; conversión con tasa congelada por viaje.
- Tablas **versionadas** (`valid_from`/`valid_to`): nunca se editan; cambiar una tarifa = cerrar vigencia y crear fila nueva. `valid_to = null` significa vigente. Aplica a `fare_rules` y `membership_fees`.
- `geography` = tipo PostGIS (WGS84). Índices GIST en columnas espaciales (refinamiento).
- Estados como enums de PostgreSQL; las máquinas de estado se blindan con constraints (refinamiento).
- Tipos actuales **preliminares** — se congelan en el refinamiento lógico.
- `created_at` en todas las tablas (se omite abajo salvo cuando participa de la lógica).

## 5. Modelo de datos — 24 tablas en 7 dominios

### 5.1 Identidad (5)

```
users                        perfil base (id = auth.users de Supabase)
  id uuid PK · role enum(client|driver|admin) · full_name · email UQ · phone
  photo_url · status enum(active|suspended)

clients                      extensión de rol cliente
  user_id uuid PK FK→users · avg_rating · rating_count · cancel_count

drivers                      extensión de rol conductor
  user_id uuid PK FK→users · affiliation_status enum(pending|approved|suspended)
  current_vehicle_id FK→vehicles (vehículo actual) · is_available bool
  last_location geography(Point) · last_location_at · avg_rating · rating_count
  cancel_count · contract_url (contrato subido por admin, Storage)

driver_applications          formulario inicial de afiliación (RF-CON-REG-01)
  id uuid PK · full_name · phone · email · vehicle_summary
  status enum(pending|approved|rejected) · reviewed_by FK→users · notes · reviewed_at
  (al aprobarse se crea el user + driver)

documents                    documentos de conductor o vehículo
  id uuid PK · driver_id FK→drivers (null) · vehicle_id FK→vehicles (null)
  doc_type · file_url (Storage) · expires_at date · status enum(valid|expired|rejected)
  CHECK: exactamente uno de driver_id/vehicle_id
```

### 5.2 Flota (2)

```
vehicle_types                catálogo: moto, carro (extensible)
  id smallint PK · name UQ · active bool

vehicles                     del conductor, aprobados por admin
  id uuid PK · driver_id FK→drivers · vehicle_type_id FK→vehicle_types
  brand · model · year · color · plate UQ
  approval_status enum(pending|approved|rejected)
```

### 5.3 Operación (5) — el núcleo

```
trip_requests                solicitud EFÍMERA (separada del viaje)
  id uuid PK · client_id FK→clients · mode enum(flat|auction)
  requested_vehicle_type_id FK→vehicle_types
  origin geography(Point) · destination geography(Point)
  origin_address · destination_address
  quoted_amount_usd (solo flat) · offered_amount_usd (solo auction)
  estimated_distance_km · estimated_duration_min
  search_radius_km (oleada vigente del despacho)
  status enum(searching|offered|assigned|expired|cancelled)
  expires_at · created_at

trip_offers                  aceptaciones y contraofertas
  id uuid PK · request_id FK→trip_requests · driver_id FK→drivers
  amount_usd · status enum(pending|accepted|rejected|expired) · expires_at · created_at
  UNIQUE (request_id, driver_id)  ← una contraoferta por conductor

trips                        el viaje confirmado (histórico permanente)
  id uuid PK · request_id FK UQ→trip_requests · client_id FK · driver_id FK · vehicle_id FK
  final_fare_usd · exchange_rate (USD→Bs congelada)
  estimated_distance_km · estimated_duration_min · distance_method enum(straight|route)
  status enum(assigned|arrived|in_progress|completed|cancelled)
  cancelled_by enum(client|driver|admin) · cancel_reason · payment_confirmed bool
  assigned_at · arrived_at · started_at · completed_at · cancelled_at

trip_route_points            tracking periódico (alto volumen; candidata a particionado)
  id bigint PK · trip_id FK→trips · point geography(Point) · recorded_at

ratings                      bidireccionales, moderables
  id uuid PK · trip_id FK→trips · rater_id FK→users · ratee_id FK→users
  score smallint 1-5 · comment · hidden bool (moderación admin)
  UNIQUE (trip_id, rater_id)
```

**Máquinas de estado:**

- `trip_requests`: `searching` → `offered` (recibió contraofertas) → `assigned` | `expired` | `cancelled`
- `trips`: `assigned` → `arrived` → `in_progress` → `completed`; salida a `cancelled` desde cualquier estado no terminal
- En modo flat, una aceptación es una `trip_offer` por el monto cotizado; el primer conductor que acepta genera el viaje. Un solo flujo para ambos modos.

### 5.4 Economía (4)

```
fare_rules                   VERSIONADA · tarifa de viaje por tipo de vehículo
  id PK · vehicle_type_id FK→vehicle_types · base_usd · per_km_usd · per_min_usd
  valid_from · valid_to (null = vigente)

time_multipliers             recargos por franja horaria (globales)
  id PK · label · from_time · to_time · days_of_week smallint[] · multiplier · active

membership_fees              VERSIONADA · cuota semanal por tipo de vehículo
  id PK · vehicle_type_id FK→vehicle_types · weekly_usd · valid_from · valid_to

weekly_dues                  deuda semanal del conductor
  id uuid PK · driver_id FK→drivers · week_start date · amount_usd
  status enum(pending|paid|overdue) · paid_at · registered_by FK→users (admin)
  UNIQUE (driver_id, week_start)
  (el scheduler de Fastify genera las filas semanalmente; overdue suspende al conductor)
```

### 5.5 Comunicación (3)

```
device_tokens                dispositivos FCM del usuario (varios por usuario)
  id uuid PK · user_id FK→users · token UQ · platform enum(android|ios)
  last_seen_at · revoked bool

notifications                historial de push operativas
  id uuid PK · user_id FK→users · type · title · body · payload jsonb
  sent_at · read_at

push_campaigns               marketing del admin (decisión: sin cupones)
  id uuid PK · created_by FK→users · audience enum(clients|drivers|all)
  title · body · sent_at · sent_count
```

### 5.6 Soporte y beneficios (3)

```
support_tickets              disputas (RF-ADM-SUPPORT-01)
  id uuid PK · trip_id FK→trips (null) · opened_by FK→users · subject · description
  status enum(open|in_review|resolved|closed) · resolved_by FK→users · resolved_at

benefits                     catálogo del gremio (House Market, hospitalarios…)
  id PK · name · description · active

benefit_requests             solicitudes del conductor con aprobación admin
  id uuid PK · driver_id FK→drivers · benefit_id FK→benefits
  status enum(pending|approved|rejected) · notes · reviewed_by FK→users · reviewed_at
```

### 5.7 Plataforma (3)

```
service_areas                geocercas opcionales (apagadas por defecto)
  id PK · name · area geography(Polygon) · active bool default false

app_settings                 configuración operativa (key/value)
  key text PK · value jsonb · description · updated_by FK→users · updated_at
  Claves previstas: dispatch_initial_radius_km, dispatch_radius_increment_km,
  dispatch_wave_interval_s, dispatch_max_radius_km, distance_circuity_factor,
  avg_speed_kmh, auction_request_ttl_s, auction_offer_ttl_s, tracking_interval_s

audit_logs                   eventos del sistema (RF-BE-LOG-01; alto volumen)
  id bigint PK · actor_id FK→users (null) · event_type · entity · entity_id
  data jsonb · created_at
```

## 6. Requisitos cubiertos sin tabla propia (por diseño)

- **Ganancias del conductor** (RF-CON-EARN-01), **reportes** (RF-ADM-REPORT-01) y **dashboard** (RF-ADM-DASH-01): consultas agregadas sobre `trips` — fuente única de verdad, sin duplicar datos.
- **Llamada/WhatsApp al contacto** (RF-CLI-COMM-01, RF-CON-COMM-01): deep links en la app, no tocan la BD.
- **Navegación** (RF-CON-NAV-01): deep link a Google Maps.

## 7. Observaciones sobre el documento de requisitos

- No contemplaba **cancelaciones** → resuelto con decisión 1.
- Ambigüedad propiedad del vehículo (RF-CON-VEH-01 vs RF-ADM-USER-D-01) → resuelto con decisión 3.
- "Zonas" en tarifas (RF-ADM-TARIFF-01) → **descartadas**; solo recargo horario (decisión 6).
- "Límites geográficos" (RF-ADM-CONFIG-01) → geocerca opcional apagada (decisión 7).
- IDs duplicados en el PDF (RF-CLI-REQ-01 aparece dos veces) y RNF-PERF-02 con placeholder sin llenar.
- Surge pricing/tarifas dinámicas: mencionadas como "posiblemente" → fuera del alcance v1 (el multiplicador horario cubre el caso nocturno).

## 8. Trabajo pendiente (en orden)

1. **Flujos críticos segundo a segundo**: despacho por radio expansivo y subasta completa como diagramas de secuencia. Casos borde a resolver: dos conductores aceptan a la vez, cancelación simultánea a una aceptación, conductor pierde conexión en viaje, expiración durante negociación.
2. **Refinamiento lógico**: tipos definitivos, enums PostgreSQL, constraints de máquinas de estado, índices (GIST espaciales incluidos), estrategia de particionado para `trip_route_points`/`audit_logs` (solo cuando el volumen lo pida).
3. **Matriz de permisos por rol**: qué lee/escribe cada rol sobre cada entidad → contrato del middleware de autorización de Fastify.
4. **DDL y migraciones** — solo con autorización explícita.

---
*Documento generado a partir de las sesiones de diseño con Claude Code. Los diagramas se regeneran desde las definiciones mermaid; pedir "regenerar diagramas BD" en una sesión futura.*
