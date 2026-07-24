# Propuesta / Tarea: Registro de afiliado en 2 pasos + gestión de flota y documentos desde el perfil

> Estado: **✅ IMPLEMENTADA (2026-07-21)** · Analizada 2026-07-16 · Decisión de Luis.
> Registro por `POST /drivers/register` **transaccional** (todo o nada). **Matiz de negocio:**
> los pasos de **documentos y vehículo se mantuvieron en el wizard** (pedido de la dueña, no
> se movieron fuera del alta): se acumulan en el cliente y entran en la misma transacción; los
> archivos se suben después. La gestión de flota/documentos desde el **perfil** también se
> implementó (datos vivos). Wizard final: 4 pasos (datos → documentos → vehículo → pago).
> Verificado E2E (con/sin pago, con vehículo+documento, atomicidad). Detalle:
> [decisions-log.md](../../decisions/decisions-log.md#2026-07-21).
> Pendiente menor (gap preexistente): acción en el perfil para cobrar a un `pending` sin pago.
> Esta es una tarea autocontenida: contiene todo lo necesario para ejecutarla sin más contexto.

## Objetivo

Rediseñar el alta de afiliados para que **el registro solo ocurra al pulsar el botón
final** (hoy se crea en la BD al pulsar "Guardar" en el paso 1) y para corregir el modelo
de dominio: documentos y vehículos son **datos vivos** (vencen, se renuevan, se reemplazan),
pertenecen a la **gestión continua** del chofer, no a la foto del alta.

## Cambio de forma

**Wizard actual (4 pasos, persistencia incremental):**
`1. Datos → 2. Documentos → 3. Vehículo → 4. Pagos` — cada paso escribe en la BD al instante;
el paso 1 crea el afiliado al "Guardar".

**Wizard nuevo (2 pasos, registro transaccional al final):**
`1. Datos personales → 2. Pago` — todo se acumula en el cliente y se envía en **una sola
transacción** al botón final. Sin archivos en el registro → sin la complicación de multipart.

**Documentos y vehículos migran al perfil del chofer** (`driver-detail`), que se vuelve el
centro de gestión de flota y papeles.

## Por qué (registrado para no reabrir el debate)

- La **aprobación ya exige solo los pagos**, nunca documentos ni vehículo → el wizard nuevo
  se alinea con la regla real de aprobación.
- Con registro = persona + pago (datos planos), el envío transaccional único es trivial:
  **desaparece el problema de los archivos** que bloqueaba el "registrar solo al final".
- El perfil ya es la superficie de archivos (subir/ver ya existe); se extiende, no se inventa.

## Decisiones tomadas (confirmar si algo cambió)

1. **Vehículo opcional al alta.** Un chofer puede quedar sin vehículo tras registrarse; se
   agrega desde el perfil antes de operar. El "debe tener vehículo para operar" es un gate del
   módulo de viajes (futuro), no del registro.
2. **Pago opcional al alta.** Mantener "finalizar sin pago": sin pago el afiliado queda
   `pending`; con pago se crea + inscribe atómicamente. La aprobación posterior exige los pagos.
3. La obligatoriedad de requerimientos (`isRequired`) solo bloquea el registro **desde la app**,
   nunca por panel → quitar documentos del wizard no rompe ninguna regla.

## Plan de implementación (en este orden)

### 1. Backend — endpoint transaccional de registro
- Nuevo `POST /drivers/register` que recibe datos personales + (opcional) `{ planId, periods }`
  y crea, **en una sola transacción**: `users` + `drivers` + (si hay pago) `membership_payments`
  + `driver_subscriptions` (scheduled) + `subscription_payments` + `invoices`.
- Reutilizar la lógica ya existente: `DriversService.create` (composición de nombre, hash de
  contraseña, validación 18+) y `EnrollmentRepository.enroll` (ya hace pagos+facturas en TX).
  Idealmente refactorizar para compartir la transacción, no duplicar.
- Mantener `POST /drivers` y `PATCH /drivers/:id` para edición desde el perfil.
- Verificar E2E: registro solo-persona (queda pending, sin facturas) y registro persona+pago
  (afiliado + factura #N en una transacción; si el pago falla, no queda nada).
- Actualizar `docs/api/endpoints.md`.

### 2. Frontend — wizard a 2 pasos
- `driver-wizard`: eliminar pasos 2 (documentos) y 3 (vehículo). Quedan `1. Datos` y `2. Pago`.
- El botón final llama a `POST /drivers/register` con lo acumulado en el cliente (nada se
  persiste antes). Sin pago → botón "Registrar" (queda pendiente); con pago → "Registrar y
  facturar".
- **Quitar el interruptor temporal `devUnlockSteps`** de `driver-wizard.ts` (queda obsoleto:
  con 2 pasos y registro transaccional no hay guardado temprano que evitar). Buscar el comentario
  "⚠️ TEMPORARY dev switch (Luis 2026-07-16)".
- El botón "Guardar" del paso 1 desaparece (ya no persiste; solo valida y avanza).

### 3. Frontend — gestión desde el perfil (`driver-detail`)
- **Agregar vehículo**: modal/formulario que reutiliza `POST /drivers/:id/vehicles`. El markup
  del formulario **ya existe** en el wizard paso 3 (moverlo, no reescribir). La sección
  "Vehículos" del perfil hoy solo lista; agregarle el botón "+ Agregar vehículo".
- **Agregar documento**: modal/formulario que reutiliza `POST /drivers/:id/documents` + la
  subida de archivo a `POST /documents/:id/file` (ya existe en el perfil para documentos
  existentes). El markup del formulario **ya existe** en el wizard paso 2 (moverlo). La sección
  "Documentos" del perfil hoy muestra pendientes y adjunta archivos a docs existentes; agregarle
  "+ Agregar documento".

### 4. Verificación y docs
- `npm run typecheck` (backend) + `ng build` (frontend) limpios.
- E2E por curl del flujo nuevo.
- Actualizar: `docs/api/endpoints.md`, `docs/roadmap.md` (fila Afiliados), `docs/architecture/overview.md`
  (flujo de registro), `docs/decisions/decisions-log.md`.

## Estado actual relevante (para arrancar)

- Endpoints que YA existen y se reutilizan: `POST /drivers`, `PATCH /drivers/:id`,
  `POST /drivers/:id/documents`, `POST /drivers/:id/vehicles`, `POST /drivers/:id/enroll`,
  `POST /documents/:id/file`, `GET /documents/:id/file`.
- ⚠️ Hay un interruptor **temporal** `devUnlockSteps = true` en `driver-wizard.ts` que hoy
  desbloquea la navegación libre (para trabajar la UI sin crear afiliados). **Eliminarlo** en el
  paso 2 de este plan.
- Afiliados semilla en dev: Pedro José Pérez González (V-12345678, aprobado, factura #1),
  Luis Dario Villegas Vargas (V-27123123, pendiente).
