# Verificación de pagos (v9) — flujo de aprobación

> **ESTADO (2026-08-03):**
> - ✅ **Fase 1 — BD** (migraciones `1752340000000_payment-approval-flow` +
>   `1752350000000_payment-submission-context`).
> - ✅ **Fase 2 — Backend COMPLETO** (29/29 tests): endpoints de envío + liquidación al aprobar
>   despachada por `purpose` (`debt`/`advance`/`enroll`) + motor de deuda congelado + Efectivo
>   Divisa. Cobros del panel reconducidos a envío (alta, enroll, adelanto, deuda); solo el
>   **cambio de plan** sigue liquidando directo.
> - ✅ **Fase 3/4 — Panel + perfil**: bandeja "Por aprobar", sección de revisión con
>   Aprobar/Rechazar (modal de confirmación), detalle de factura con comprobantes inline,
>   mensajes "en revisión" / "rechazado" en el perfil.
> - ✅ **Pendientes cerrados**: **Efectivo Divisa** en la captura (monto + hasta 5 fotos) y
>   **cambio de plan** por envío (`purpose=change_plan`). **Todos los cobros del panel van por el
>   flujo de envío.** La app del chofer (`edv-route-mobile`) consume este contrato — es la
>   referencia para su implementación.
>
> **Este documento es el CONTRATO para el equipo de la app del chofer.** La app debe adaptarse
> a este flujo: envía el pago, lo deja *pendiente* y muestra al chofer el estado hasta que un
> admin lo apruebe o rechace. Los endpoints marcados 🚧 son el contrato acordado; sus rutas y
> payloads pueden ajustarse en la implementación — cualquier cambio se refleja aquí y en
> [api/endpoints.md](../../api/endpoints.md).

## Por qué

Hoy un cobro se **liquida al instante**: al registrarlo, los cargos nacen `paid` y la factura
queda pagada; el comprobante es solo evidencia adjunta que **no dispara ninguna verificación**.
No hay forma de que el sistema valide que la información de un pago sea real, no esté duplicada
o no sea fraudulenta. Este cambio introduce esa validación: **todo pago pasa por un admin**
antes de contar como pagado.

## El modelo: "envío de pago" (payment submission)

Un **envío de pago** es lo que el chofer (o un admin en su nombre) **manda**: **un** pago que
cubre uno o más cargos (semanas de tarifa y/o membresía), con **un** conjunto de datos del
pagador y **de 1 a 5 imágenes** de comprobante/billetes. Se queda **`pending`** hasta que un
admin lo revisa.

```
                 ┌───────────► approved  → se liquidan los cargos, se emite la factura,
   enviar pago ──┤                          se asigna el pago (como hoy). Mensaje: se quita.
   (pending)     └───────────► rejected  → los cargos siguen debidos. Mensaje al chofer:
                                           "Su pago fue rechazado, genere uno nuevo o
                                            póngase en contacto con el administrador."
```

Reglas cerradas (decididas por Luis, 2026-08-03):

1. **Todos los pagos quedan pendientes**, incluidos los que registra el admin (alta, enroll,
   renovación, pago externo/efectivo). Nada se da por pagado sin una aprobación explícita.
   → **Consecuencia**: el **alta pasa a 2 pasos** — registrar el pago (queda pendiente) →
   aprobarlo → recién ahí se puede aprobar al chofer.
2. **La factura se materializa AL APROBAR**, no al enviar (coherente con "la factura es el
   recibo de dinero recibido"). Mientras el envío está pendiente **no hay factura**: hay cargos
   debidos + un envío pendiente. Al aprobar se crea **una** factura que agrupa los cargos
   cubiertos, con su método/referencia/comprobante. Esto **elimina el bug** por el que un
   adelanto de N semanas generaba N facturas y los datos del pago caían solo en la primera.
3. **El motor de deuda se congela** mientras haya un envío pendiente que cubre la deuda: no
   acumula nueva mora ni penaliza. Si se rechaza, se reanuda; si se aprueba, se salda.
4. Un pago **rechazado nunca se borra** (regla de dinero: queda el rastro con su motivo). El
   chofer genera uno nuevo.
5. **A lo sumo un envío pendiente por chofer** a la vez (garantía física, ver abajo): un nuevo
   envío espera a que se resuelva el anterior. Es parte del control anti-duplicados.

## Estados que ve el chofer (para la app)

Estos son los mensajes que la app debe mostrar en el perfil del chofer. Reemplazan/complementan
las bandas actuales (deuda / próximo cobro):

| Situación | Mensaje en el perfil del chofer |
|---|---|
| Debe dinero o tarifa por vencer, **sin** envío pendiente | El de hoy: deuda / próximo cobro, con botón para pagar |
| Envío **pendiente** de aprobación | **"Pago en revisión — pendiente de aprobación."** (se oculta el botón de pagar) |
| Envío **aprobado** | Se **quita** el mensaje y se asigna el pago (queda al día, como hoy) |
| Envío **rechazado** | **"Su pago fue rechazado, genere uno nuevo o póngase en contacto con el administrador."** + botón para generar uno nuevo |

## Modelo de datos (✅ ya en la BD)

Migración `1752340000000_payment-approval-flow`. Detalle físico en
[database/schema.md](../../database/schema.md).

- **`payment_submissions`** — cabecera del envío: `driver_id`, `status`
  (`payment_submission_status`: `pending` \| `approved` \| `rejected`), `amount_usd`,
  datos del pagador (`payment_method_id`, `payment_reference`, `payer_bank`, `paid_on`,
  `payer_phone`, `payer_id`, `payer_account`), `note`, `source` (`app` \| `admin`),
  `submitted_by` (admin; `null` = vino de la app), `reviewed_by`, `reviewed_at`,
  `rejection_reason`, `invoice_id` (la factura materializada al aprobar; `null` mientras
  pendiente/rechazado).
- **`payment_submission_files`** — de 1 a 5 imágenes por envío (`storage_path`, `position`).
  El límite de 5 se valida en la capa de servicio.
- **`subscription_payments.submission_id`** y **`membership_payments.submission_id`**
  (nullable) — vinculan cada cargo al envío que lo paga. Al aprobar se liquidan; al rechazar
  se desvincula (`submission_id = null`) para que un nuevo envío pueda reclamarlos.
- **`payment_methods.admin_only`** (boolean, default `false`) — los métodos con `admin_only =
  true` **no se exponen a la app**.
- **`payment_method_type`** ahora incluye **`cash_usd`** ("Efectivo Divisa").
- Garantía física: índice único parcial `payment_submissions_one_pending_per_driver`
  (`WHERE status = 'pending'`).

## Endpoints (🚧 contrato, por implementar en Fase 2)

Prefijo global `/api/v1`. Autenticación admin con el JWT actual; el token del chofer (app) se
definirá con el auth de chofer (hoy el `auth` es solo admin).

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| `POST` | `/drivers/:id/payment-submissions` | admin (y, futuro, chofer) | Crea un envío `pending`. Multipart: metadatos del pago + `purpose` + 1..5 imágenes |
| `GET` | `/payment-submissions?status=pending` | admin | Bandeja "Por aprobar" |
| `GET` | `/payment-submissions/:id` | admin | Detalle + URLs firmadas de las imágenes |
| `POST` | `/payment-submissions/:id/approve` | admin | Liquida cargos, emite factura, asigna pago |
| `POST` | `/payment-submissions/:id/reject` | admin | `{ reason }`; deja el rastro y avisa al chofer |

Cuerpo de creación (borrador):

```jsonc
// multipart/form-data
{
  "purpose": "debt" | "advance" | "enroll",   // qué cubre
  "weeks": 4,                                   // solo advance/enroll
  "paymentMethodId": 3,
  "paidOn": "2026-08-03",
  "reference": "1548754548",                   // según método (no aplica a cash_usd)
  "payerBank": "0134 - Banesco",               // transfer / pago_movil
  "payerPhone": "+58412...", "payerId": "V-12345678",   // pago_movil
  "payerAccount": "correo@ej.com",             // zelle / binance
  "amountUsd": "40.00",                        // obligatorio en cash_usd
  "note": "...",
  "files": [ /* 1..5 imágenes; obligatorio salvo efectivo/contacto */ ]
}
```

## "Efectivo Divisa" (`cash_usd`) — solo admin

- **No se ofrece en la app** (`admin_only = true`). La app filtra el catálogo por
  `admin_only = false`.
- Al **crear el método** solo se pide nombre/etiqueta (no hay datos de cuenta).
- Al **cobrar** con este método, la captura cambia: pide **fecha del pago + monto (USD) + de 1
  a 5 fotos de billetes**; no pide referencia, banco emisor ni datos del pagador.

## Qué debe adaptar el equipo de la app

1. **Catálogo de métodos**: consumir solo los `admin_only = false` (nunca mostrar `cash_usd`).
2. **Enviar pago** contra `POST /drivers/:id/payment-submissions` (con el auth del chofer cuando
   exista); tras enviar, el chofer queda **en revisión**.
3. **Perfil del chofer**: mostrar los 4 estados de la tabla de arriba (incluido el texto exacto
   de rechazo).
4. **Un envío pendiente a la vez**: deshabilitar el botón de pagar mientras haya uno en revisión.

## ⚠️ Pendientes conocidos (2026-08-03) — panel v9 COMPLETO, falta el lado app

El flujo desde el **panel admin** está terminado y desplegado (crear → aprobar/rechazar,
Efectivo Divisa, cambio de plan; todos los cobros van por envío). Para cerrar el ciclo con la
**app del chofer** faltan, en el BACKEND, estos dos puntos concretos:

1. **Guard del chofer en la creación.** Hoy `POST /drivers/:id/payment-submissions` está detrás
   del guard admin (`app.authenticate`). Para que el chofer POStee desde la app con su token
   `driver` (de `/driver-auth/login`) hay que **permitir `authenticateDriver`** en esa ruta (o
   exponer una paralela) y validar que el `:id` sea el propio chofer del token. El servicio ya
   acepta `source: 'app'` y `submittedBy: null`.
2. **Actor-usuario en la auditoría.** `writeAudit` (`audit-writer.ts`) solo soporta
   `actorAdminId`; con `source='app'` el actor queda `null`. Extenderlo con `actorUserId` +
   columna `audit_logs.actor_user_id` (ya existe) para registrar al chofer que envía.

**Menores / decisiones abiertas** (no bloquean la app):
- No hay "des-aprobar" un pago ya aprobado (se revierte anulando la factura resultante, `voided`).
- Un envío pendiente congela al chofer sin límite: no hay recordatorio ni caducidad.
- Los endpoints directos `/enroll`, `/subscription/renew`, `/external-payment` siguen vivos (el
  panel ya no los usa): conviene deprecarlos o protegerlos para que no salten la revisión.
- Efectivo Divisa en el **alta (wizard)** no está verificado (genera un envío `debt`; debería andar).
- Falta un **smoke test E2E** completo del ciclo en navegador (panel).
