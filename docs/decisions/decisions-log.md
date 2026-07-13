# Registro de decisiones

Decisiones de negocio y técnicas en orden cronológico. Las decisiones de modelado de datos
detalladas viven en [database/database-design-v7.md](../database/database-design-v7.md);
aquí queda el resumen ejecutivo y las decisiones posteriores al diseño.

## 2026-07-07 — Fundamentos

| Decisión | Motivo |
|---|---|
| Backend propio (Node.js + Fastify) como único punto de entrada; las apps jamás tocan la BD | Robustez y escalabilidad sobre velocidad de entrega |
| PostgreSQL + PostGIS alojado en Supabase, usado solo como Postgres gestionado | Infraestructura administrada sin acoplarse al BaaS |
| Sin APIs pagas en desarrollo: distancias con PostGIS, mapas OSM, push FCM | Control de costos |
| Moneda dual: precios anclados en USD, viajes congelan tasa en Bs | Contexto Venezuela |

## 2026-07-07/08 — Siete rondas de diseño de BD (v1 → v7)

Resumen: membresía única de pago único vitalicio con beneficios por versión · tarifas prepago
(diaria→anual) con gracia y suspensión automática · **versionado condicional** en membresía y
tarifas ("regla de los 150 USD": editar con pagos = archivar y crear versión nueva) ·
requerimientos de documentos configurables **por origen** (obligatorios solo desde la app) ·
facturación interna uniforme con anulación con rastro · wizard de registro de 4 pasos ·
auditoría. Detalle completo y cronología: [database/README.md](../database/README.md).

## 2026-07-10 — Decisiones de implementación

| Decisión | Motivo |
|---|---|
| Login del admin con **usuario y contraseña** (se añadió `username` único a `admins`; el email queda como contacto) | Pedido del negocio |
| **Numeración de facturas continua** (secuencia global única, sin reinicio anual) | Evitar cualquier ambigüedad de números repetidos entre años |
| **Cédula (`national_id`)**: obligatoria al registrarse desde la app, opcional al registrar por el panel | Coherente con la regla de requerimientos por origen |
| **Integración Supabase Auth pospuesta** (modo prueba): `users.id` propio + columna `auth_user_id` para vincular después | Permite avanzar sin migrar claves primarias más adelante |
| Data API de Supabase deshabilitada | Hardening: solo Fastify accede a los datos |
| Sin ORM: SQL directo (`pg`) + migraciones versionadas (node-pg-migrate) | Control total de SQL, PostGIS, índices parciales y transacciones |
| **Modelos por tabla generados desde la BD** (Kanel → `src/db/models/`, regenerar con `npm run db:types` tras cada migración); los repositorios derivan sus tipos de esas filas | Entidades tipo POJO sin riesgo de desincronización: se generan desde la verdad (la BD), no se mantienen a mano |
| Vehículos registrados por el panel nacen aprobados | El admin es la autoridad de aprobación |
| Storage de archivos pospuesto: los documentos registran metadatos (`file_url` nullable) | Modo prueba |

## Pendientes conocidos

- Vista global de documentos con alertas de vencimiento, historiales de pagos/facturas,
  capacitaciones.
- Subida real de archivos (Supabase Storage) e integración Supabase Auth.
- Facturación fiscal SENIAT: análisis aparte con el contador (el comprobante actual es interno).

## 2026-07-13 — Vencimientos y renovación (bloque 4)

| Decisión | Motivo |
|---|---|
| Los períodos vencen a las **00:00** (zona `business_timezone`, seed America/Caracas) del día correspondiente; ventana móvil, **sin anclaje al calendario** | Anclar solo semanales al domingo obligaría lógicas distintas para mensuales/anuales |
| **Suspensión inmediata** al vencer (`subscription_grace_hours = 0`, la clave sigue configurable) | Decisión de negocio; la clave queda por flexibilidad futura |
| El estado de tarifa es **independiente** del estado administrativo del chofer: la suscripción pasa a `expired` (no opera) y el pago de renovación la **reactiva automáticamente** | No contaminar la suspensión administrativa; reactivación sin intervención manual |
| Alerta `payment_reminder_days` (seed 3) días antes del vencimiento: badge en el panel HOY; badge + push en la app del chofer cuando exista (documentado, no implementado) | La app del usuario aún no se desarrolla |
| El scheduler consume adelantos automáticamente (avanza al siguiente período pagado) y audita cada transición con actor sistema | Los adelantos ×N corren sin intervención |

## 2026-07-13 — Auditoría (UI del módulo admin)

| Decisión | Motivo |
|---|---|
| La API de auditoría es **solo lectura** (`GET /audit-logs`, `GET /audit-logs/facets`): las entradas las escriben los servicios que actúan, nunca el cliente | Integridad del rastro: un log que se puede editar por HTTP no es auditoría |
| Los filtros `from`/`to` interpretan **días calendario en `business_timezone`** (predicados sargables que conservan el índice de `created_at`) | Consistente con los vencimientos a las 00:00 locales; "hoy" significa lo mismo en toda la app |
| `/facets` deriva eventos, entidades y actores **realmente presentes** en el log | Sin catálogos duplicados en el frontend que se desincronicen al añadir eventos |
| Cada entrada resuelve el afiliado afectado (`entity_id` o `data->>'driverId'`) para enlazar al perfil | La auditoría se navega por personas, no por uuids |
| `SettingsRepository.get(key, fallback)` como lectura compartida de configuración | Tercer consumidor de `business_timezone`; se elimina la duplicación futura |

## 2026-07-13 — Cobertura total de auditoría + dashboard real

| Decisión | Motivo |
|---|---|
| **Todos los módulos auditan** (catálogos, membresía, tarifas, administradores, settings) vía el helper compartido `writeAudit` (`modules/audit-logs/audit-writer.ts`); el scheduler y afiliados se refactorizaron al mismo helper | Se decidió ANTES del dashboard para que el feed de actividad nazca completo; una sola ruta de escritura al log |
| El versionado condicional emite eventos distintos: `*.updated` (in place) vs `*.versioned` (réplica con `previousId`) | El log distingue una edición simple de una nueva versión con suscriptores |
| `admin.password_changed` no registra la contraseña ni su hash | El evento en sí es el rastro; jamás material sensible en `data` |
| "Por vencer" (dashboard **y** badge del listado) = **cobertura pagada** (`max(period_end)` de pagos `paid`, adelantos incluidos) ≤ `payment_reminder_days`. Un chofer con adelantos vigentes NO está "por vencer" | Decisión de Luis: el aviso mide quién necesita pagar de verdad; un mismo criterio en toda la app |
| "Facturación de la semana" = **últimos 7 días móviles** (anuladas excluidas), no semana calendario | Sin ambigüedad de "cuándo empieza la semana"; un lunes por la mañana no muestra $0 |
| El feed de actividad del panel **reutiliza `GET /audit-logs`** (no hay endpoint de feed propio) | Una sola fuente para la actividad; el dashboard solo agrega números |
