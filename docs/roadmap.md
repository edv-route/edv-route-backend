# Roadmap y estado del proyecto

> Actualizado: 2026-07-13. Estado del **módulo admin** (primer entregable según el diseño v7).

## ✅ Completado y verificado

| Bloque | Contenido | Estado |
|---|---|---|
| Infraestructura | Supabase (Postgres + PostGIS 3.3.7, Data API off) · repos GitHub separados · migraciones versionadas · modelos generados (Kanel) con regeneración automática | ✅ |
| Auth | Login usuario/contraseña · argon2id · JWT 8h · lockout 5 intentos/15 min · guard global | ✅ |
| Catálogos | Tipos de vehículo · Requerimientos (obligatoriedad solo desde app) · Beneficios · Settings (API) | ✅ |
| Dinero | Membresía con **versionado condicional** y beneficios por versión · Tarifas (daily→annual, versionado) | ✅ |
| Afiliados | Wizard 4 pasos (cédula opcional por panel) · cola de pendientes · perfil gestionable · aprobar (exige pagos) / rechazar (doble reembolso + facturas anuladas) · paginación y búsqueda | ✅ |
| Facturación | Emisión automática por cobro · numeración **continua global** · anulación con rastro | ✅ |
| Ciclo de tarifas | Vencimiento a las 00:00 (`business_timezone`) · **scheduler**: suspensión inmediata + consumo de adelantos · renovación con **reactivación automática** · badges Vigente/Por vencer/Vencida | ✅ |
| Administradores | CRUD completo · sin auto-suspensión · cambio de contraseña | ✅ |
| Auditoría (datos) | `audit_logs` registrando todas las acciones (admin y sistema) | ✅ (sin UI) |

## 🔜 Pendiente para completar el módulo admin (orden recomendado)

1. **Auditoría (UI)** — endpoint paginado con filtros + pantalla. La tabla ya se llena sola.
2. **Dashboard real** — endpoint de resumen (afiliados activos, pendientes, facturación de la
   semana, tarifas por vencer/vencidas) + feed de actividad desde `audit_logs`.
3. **Documentos (vista global)** — listado transversal con filtros y alertas de vencimiento;
   paso adicional del scheduler que marque `expired` los vencidos.
4. **Historiales** — facturas y pagos por afiliado y globales (vista `v_driver_payments`).
5. **Capacitaciones** — única pieza que requiere migración (`trainings`, `training_attendees`):
   CRUD + inscripción + asistencia.

## ⏸️ Pospuesto conscientemente (decisiones registradas)

- **Supabase Auth** (cuenta del chofer): `users.auth_user_id` listo para vincular sin migrar PKs.
- **Storage** (archivos reales de documentos/contratos): hoy se registran metadatos.
- **Notificación al chofer** (badge + push en su app): diseñada; la app no existe aún.
- **Cambio de plan al renovar** (hoy 409 si el plan fue archivado).
- **Facturación fiscal SENIAT**: análisis aparte con el contador.
- **Módulos post-admin**: apps móviles, viajes/subasta, clientes, tickets, push real.

## Credenciales y datos de prueba (entorno dev)

- Admins: `admin` y `luis` (contraseñas comunicadas por chat; cambiarlas en Administradores).
- Afiliados de prueba: Pedro Pérez (aprobado, renovado, facturas #1–#6) · María Rechazada
  (rechazada con reembolsos y factura anulada) · "Sin Pagos" (wizard incompleto).
- Membresía vigente $175 con "Seguro funerario" · tarifas Semanal $10 y Mensual Motos $35.
