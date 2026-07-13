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

- Scheduler de vencimientos (gracia → suspensión automática) — bloque 4.
- Vista global de documentos con alertas de vencimiento, UI de auditoría, dashboard real,
  historiales de pagos/facturas, capacitaciones.
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
