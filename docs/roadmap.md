# Roadmap y estado del proyecto

> Actualizado: 2026-07-24. **La lógica del módulo admin está COMPLETA** (primer entregable
> del diseño v7). En curso: **pulido incremental de la UI sección por sección** (formularios,
> componentes de marca, registro en 2 pasos); pendiente el rediseño visual completo. Después,
> módulos post-admin.

## ✅ Completado y verificado

| Bloque | Contenido | Estado |
|---|---|---|
| Infraestructura | Supabase (Postgres + PostGIS 3.3.7, Data API off) · repos GitHub separados · migraciones versionadas · modelos generados (Kanel) con regeneración automática | ✅ |
| Auth | Login usuario/contraseña · argon2id · JWT 8h · lockout 5 intentos/15 min · guard global | ✅ |
| Catálogos | Tipos de vehículo · Requerimientos (obligatoriedad solo desde app) · Settings (API + **pantalla**) | ✅ |
| Dinero | Membresía con **versionado condicional** y beneficios por versión (el catálogo de beneficios se gestiona **dentro de Membresía**, ya no es sección propia) · Tarifas (período/vehículos fijos en UI por ahora, versionado) | ✅ |
| Afiliados | **Registro transaccional** (`POST /drivers/register`: datos + documentos + vehículo + pago, todo en una sola transacción; archivos subidos después, 2026-07-21) con **datos personales estructurados** (nombre en 4 campos, fecha nac. ≥18, documento V/E/J, teléfono +58, dirección) · **documento + contraseña obligatorios por panel** = login de la app del chofer · wizard 4 pasos · **flota y documentos también gestionables desde el perfil** (datos vivos) · cola de pendientes · perfil gestionable · aprobar (exige pagos) / rechazar (doble reembolso + facturas anuladas) · paginación y búsqueda | ✅ |
| Facturación | Emisión automática por cobro · numeración **continua global** · anulación con rastro | ✅ |
| Ciclo de tarifas | Vencimiento a las 00:00 (`business_timezone`) · **scheduler**: suspensión inmediata + consumo de adelantos · renovación con **reactivación automática** · badges Vigente/Por vencer/Vencida | ✅ |
| Administradores | CRUD completo · sin auto-suspensión · cambio de contraseña | ✅ |
| Auditoría | **Cobertura total**: todos los módulos auditan (afiliados, catálogos, membresía, tarifas, admins, settings y scheduler) vía `writeAudit` compartido · **UI**: pantalla con filtros (origen, evento, admin, fechas en tz negocio) y paginación · `GET /audit-logs` + `/facets` | ✅ |
| Dashboard | `GET /dashboard/summary` (afiliados incl. **en mora/penalizados**, tarifas por vencer por cobertura pagada / vencidas, documentos por vencer/vencidos, facturación 7 días) · pantalla con tarjetas enlazadas, feed de actividad (reutiliza `/audit-logs`) y panel de alertas (incl. mora/penalización) | ✅ |
| Documentos | Vista global `GET /documents` (filtros: estado, requerimiento, afiliado/placa, por vencer ≤ N días) · pantalla con dueño enlazado · scheduler propio que marca `expired` a medianoche (tz negocio) con auditoría de sistema · el vencimiento alerta, **no bloquea** | ✅ |
| Historiales | Vista `v_driver_payments` · `GET /invoices` + `GET /payments` (filtros, `driverId` para historial por afiliado) · pantalla Facturación con tabs Facturas/Pagos · enlace desde el perfil | ✅ |
| Capacitaciones | Migración `trainings` + `training_attendees` · CRUD (cancelar/completar, nunca borrar) · inscripción solo aprobados con cupo atómico · asistencia · pantalla con panel de asistentes | ✅ |
| Archivos (Storage) | Bucket **privado** en Supabase tras la interfaz `StorageProvider` · subida vía backend (PDF/JPG/PNG, 10 MB, validación por contenido) desde wizard y perfil · lectura con URL firmada de 60 s · `POST/GET /documents/:id/file` | ✅ |
| Configuración | Pantalla de `app_settings` (zona horaria, aviso de pago, gracia) con edición por tipo y auditoría | ✅ |
| Métodos de pago (Pieza 1) | Catálogo `payment_methods` (7 tipos, `details` jsonb validado por tipo; banco = selector de bancos nacionales) + sección con cards y formulario condicional. Las cuentas donde el afiliado paga; informativo, no pasarela | ✅ |
| Comprobante de pago (Pieza 2) | Los cobros (enroll/pago externo) capturan **método + referencia + banco emisor + comprobante** (Storage) y los estampan en la factura; Facturación muestra los datos y "Ver comprobante". El modal muestra los **datos de la cuenta** del método elegido y sube el comprobante por **dropzone** (2026-07-24). Pendiente menor: cablear la renovación y el QR de cripto | ✅ |
| Cambio de tarifa | `renew` con `planId`: programado (arranca al agotar lo pagado, lo activa el scheduler) o inmediato si está vencida · cancelación con reembolso y anulación | ✅ |
| Credenciales app del chofer | `users.password_hash` (argon2id, mín. 6, admite solo números) · usuario = documento · se crean en el registro por panel · el chofer podrá entrar a la app cuando exista | ✅ |
| Componentes de marca (UI) | `shared/components/select` (desplegable custodiado con teclado y ARIA) · `shared/components/password-input` (ojo mostrar/ocultar) · `shared/directives/password-policy` · validación visible global (`.ng-invalid.ng-touched`) · `cursor:pointer` global | ✅ |

## 🔜 Siguiente fase

1. **Rediseño visual del panel** — modernizar el frontend (decisión de Luis 2026-07-13:
   la lógica primero, el diseño después). Toda la lógica ya está detrás de APIs estables.
2. **Módulos post-admin** (pospuestos conscientemente): apps móviles, viajes/subasta,
   clientes, tickets, push real, Supabase Auth.

## 🔧 Tareas aprobadas, pendientes de implementar

- **⭐ Rediseño del estado del chofer — Fase A ✅ implementada (2026-07-23), Fase B pendiente** —
  el estado se modela como **un enum `driver_status` + el boolean `is_available`**. **Fase A
  implementada** (migración `1752250000000`): el enum incorpora **`paused`** (licencia
  administrativa: la pone el admin, exige tarifa al día, **congela** la tarifa vía `paused_at`);
  endpoints `POST /drivers/:id/pause` y `/resume`; el `subscription-scheduler` salta a los
  pausados; aprobar deja `is_available = true`; badges (`Pausado`) e indicador de disponibilidad
  `Activo`/`Inactivo` en el frontend. `approved` sigue siendo el estado sano base (badge visible).
  **Fase B pendiente** (`overdue`/`penalized` + motor de deuda + override por **pago externo**):
  **depende** de la propuesta de tarifa con deuda/penalización (mismo esfuerzo, diseño v8). Espec:
  [proposals/estados-del-chofer/README.md](proposals/estados-del-chofer/README.md).
- ✅ **Registro de afiliado transaccional** — **implementado 2026-07-21** (wizard de 4 pasos
  `Datos → Documentos → Vehículo → Pago`, registro transaccional al final, gestión de flota/
  documentos también desde el perfil). Ver
  [proposals/registro-2-pasos/README.md](proposals/registro-2-pasos/README.md).

## ⚠️ Decisiones pendientes (no bloquean el rediseño)

- **Cobro de tarifas con deuda y penalización (Fase B del estado del chofer)** — propuesta de
  la dueña que **cambia el patrón de tarifas actual**. Documentada en
  [proposals/tarifa-penalizacion/](proposals/tarifa-penalizacion/README.md); **análisis de
  impacto técnico (diseño v8) ya hecho** en
  [analisis-impacto-v8.md](proposals/tarifa-penalizacion/analisis-impacto-v8.md) (modelado de la
  deuda derivada de `subscription_payments`, impacto por capa, sub-fases B1–B4). **B1 hecho**
  (2026-07-23, migración `1752260000000`): infraestructura aditiva — enum `overdue`/`penalized`
  + 6 claves de `app_settings` del motor con valores seed, **sin cambiar el cobro**. **B2 hecho**
  (`src/plugins/debt-scheduler.ts`): emisión del cargo semanal, marcado `overdue` y **derivación**
  del estado (0 = approved · 1..tope = overdue · >tope = penalized), con **interruptor maestro
  `debt_engine_enabled` apagado por defecto** — el cobro en producción sigue intacto; verificado
  E2E. **B3 hecho**: cargo de **multa** (`charge_kind`, visible como "Penalización"), **pago
  externo** (`POST /drivers/:id/external-payment`: salda todos los cargos con una factura y deja
  constancia) y **reactivación** diferida (`reactivates_at` → lunes siguiente) o manual
  (`/reactivate`, exige deuda 0). **B4 — parte dashboard ✅ (2026-07-24)**: `overdue`/`penalized`
  en `GET /dashboard/summary` + alertas de mora/penalización en el panel (hoy 0, el motor sigue
  apagado). **Modelo de negocio cerrado formalmente + anclaje al lunes de los flujos de cobro
  (`approve`/`renew`/`changePlan`/`resume`) implementado detrás del flag (2026-07-24)**; el **plan
  de migración** al anclaje semanal está diseñado
  ([plan-migracion-anclaje.md](proposals/tarifa-penalizacion/plan-migracion-anclaje.md)). Queda,
  **antes de encender el motor**, ejecutar esa migración de datos y validar el ciclo con reloj real.
- ¿Un documento obligatorio vencido **bloquea** la operación del chofer? Hoy solo alerta.
- Contrato de afiliación firmado: Storage ya está listo, falta el flujo de subida.
- Facturación fiscal SENIAT: análisis con el contador.

## ⏸️ Pospuesto conscientemente (decisiones registradas)

- **Supabase Auth** (cuenta del chofer): `users.auth_user_id` listo para vincular sin migrar PKs.
  El login propio (documento + contraseña) ya existe; Supabase Auth sería una capa opcional futura.
- **Contrato de afiliación firmado** (`drivers.contract_url`): la infraestructura de Storage ya
  existe; falta el flujo de subida del contrato.
- **Notificación al chofer** (badge + push en su app): diseñada; la app no existe aún.
- **Facturación fiscal SENIAT**: análisis aparte con el contador.
- **Módulos post-admin**: apps móviles, viajes/subasta, clientes, tickets, push real.

## Credenciales y datos de prueba (entorno dev)

> Los afiliados de prueba se **borraron por completo** al introducir los datos personales
> estructurados (2026-07-16); la numeración de facturas se reinició en 1.

- Admins: `admin` y `luis` (contraseñas comunicadas por chat; cambiarlas en Administradores).
- Afiliados actuales: **Pedro José Pérez González** (V-12345678, aprobado, factura #1) ·
  **Luis Dario Villegas Vargas** (V-27123123, pendiente).
- Membresía vigente $175 · tarifas Semanal $10 y Mensual Motos $35.
