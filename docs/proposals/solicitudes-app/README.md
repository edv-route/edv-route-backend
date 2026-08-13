# Propuesta: Solicitudes desde la app (separar solicitante ↔ afiliado)

> **Estado:** **Fases 1 (backend) y 2 (admin) IMPLEMENTADAS y verificadas** (`typecheck` +
> `build`) el 2026-08-11 — migraciones `1752380000000`/`1752390000000` aplicadas a la BD;
> **código sin desplegar aún**. **Fase 3 (app Flutter) pendiente.** **Fecha:** 2026-08-11.
> **Alcance:** 3 proyectos (`edv-route-backend`, `edv-route-admin`, `edv-route-mobile`).
> **Origen:** cambio de negocio pedido por la dirección — evitar inundar el sistema con
> solicitudes pendientes provenientes de la app; separar el proceso de *solicitud* del de
> *afiliación*, y reordenar el registro de la app.
> **Relación con otros docs:** espeja el contrato de pagos v9
> (`docs/proposals/pagos-aprobacion/`); supersede el flujo de registro descrito en
> `edv-route-mobile/docs/HANDOFF-2026-08-10.md` (§2–§6).

---

## 1. Contexto y objetivo

Hoy un registro desde la app cae **mezclado** en la lista de Afiliados y solo se distingue por
la columna `Origen` (la BD ya tiene `drivers.source ∈ {app, admin}`). El registro de la app es
un wizard de 4 pasos que envía **todo al final** (datos + documentos + vehículo + pago) en una
sola transacción.

El negocio quiere:

1. **Separar las solicitudes de la app** en su propia sección/ciclo de vida, sin ensuciar
   Afiliados. Los registros hechos por el **admin** siguen siendo afiliados directos (no cambian).
2. **Reordenar el registro de la app**: el registro es **solo el paso 1** (datos personales +
   cuenta). Documentos y vehículos se cargan **después**, desde una pantalla post-login. El pago
   se difiere a **después de aprobada la solicitud**.
3. **Aprobación granular de documentos**: el admin aprueba/rechaza **cada documento y cada
   vehículo** (con motivo); la solicitud no se aprueba hasta que **todo** esté aprobado.
4. **Aprobar la solicitud = aprobar al afiliado**: el solicitante pasa **directo a `approved`**,
   con sus facturas de **deuda base** (membresía + 1 semana). Queda aprobado **con deuda** hasta
   que paga.
5. **Desacoplar el arranque de la tarifa** de la aprobación: cuándo empieza a correr la tarifa
   se decide en un modal aparte ("Establecer inicio"), no en el acto de aprobar.
6. Añadidos menores: **pantalla informativa** previa (beneficios + precio) y **check de T&C +
   privacidad**.

### Decisión de arquitectura de fondo (Plan B)

**No** se crea una tabla física `driver_applications`. La separación es de **vista y ciclo de
vida**, no de almacenamiento:

- La solicitud vive en la **misma tabla `drivers`** con un estado nuevo `applicant`.
- Motivos: `documents`/`vehicles` ya cuelgan de `drivers` (FK + CHECK de dueño único); toda la
  maquinaria de dinero (enroll, submissions, facturas, auditoría) ya opera sobre `drivers`;
  "solicitante → afiliado" es un `UPDATE status` (atómico) en vez de una migración de filas
  multi-tabla sobre datos + Storage. Reutiliza `source` (ya existe). Cumple SoC/DRY/KISS.
- "No inundar el sistema" es un problema de **presentación** (una sección Solicitudes filtrada),
  no de tablas.

---

## 2. Decisiones congeladas

| # | Decisión | Nota |
|---|---|---|
| D1 | Misma tabla `drivers`, estado nuevo `applicant`; separación por vista | Plan B |
| D2 | Registro de la app = **solo paso 1** (datos + cuenta + privacidad); nace `applicant` | Incremental |
| D3 | Documentos y vehículos se cargan **post-login**, incrementales, **no bloqueantes** | — |
| D4 | Aprobación **por documento** y **por vehículo**, con **motivo de rechazo** | Eje nuevo en `documents` |
| D5 | Solicitud no aprobable hasta que **todo** esté aprobado **y** haya **≥1 vehículo** | Regla dura |
| D6 | **Aprobar solicitud = aprobar afiliado** → `applicant` → `approved` + **deuda base** (membresía + 1 sem) | Colapsa 3→2 aprobaciones; **no** exige deuda 0 |
| D7 | El afiliado `approved` **con deuda no opera** hasta pagar y establecer inicio | "Aprobado sin operar" |
| D8 | Pago (app) = membresía + 1 sem + **adelantar semanas** (flujo `enroll` + `periods` actual) | Reusa lo existente |
| D9 | **Arranque de tarifa desacoplado**: modal "Establecer inicio" (ahora / próximo lunes) | Ver §4.4 |
| D10 | Vigencia de documentos (`document_status`) queda **inerte** (no se elimina ahora) | Cleanup posterior |
| D11 | Consentimiento: **privacidad** al enviar la solicitud (paso 1); **T&C** al pagar | Timestamps con rastro |
| D12 | El registro por **admin** (panel) **no cambia**: crea afiliados directos (`source='admin'`) | — |

---

## 3. Máquina de estados (canal app)

```
   ┌─────────────┐  registro paso 1 (datos + cuenta + privacidad)
   │  (no existe) │ ───────────────────────────────────────────────►  applicant
   └─────────────┘

   applicant  ──(app sube docs + vehículos, incremental)──►  applicant
   applicant  ──(admin aprueba/rechaza cada doc y vehículo)─►  applicant
   applicant  ──[aprobar solicitud: TODO aprobado + ≥1 vehículo]─►  approved  (+ deuda base)
   applicant  ──[rechazar solicitud]──────────────────────────────►  rejected (reintento: vuelve a applicant)

   approved(con deuda)  ──(app paga: enroll + periods, acepta T&C)──►  approved (recibo pending)
   approved(recibo pending) ──[admin aprueba pago]──► approved (deuda 0)  ⇒ dispara modal "Establecer inicio"
   approved(deuda 0) ──[establecer inicio: ahora | próximo lunes]──► tarifa anclada ⇒ OPERA
```

**Notas de la máquina:**

- El **estado del driver** es `approved` desde que se aprueba la solicitud. La *deuda* y el
  *recibo pending* son estados del **dinero** (facturas/submissions), no del driver — igual que
  hoy un `approved` puede tener cargos del motor de deuda.
- "**Aprobado sin operar**" = `status = approved` **con** deuda o **sin** inicio de tarifa
  establecido. La operación real se gatea por la **tarifa anclada** (subscription activa/programada).
- **Rechazo de documento** individual: el documento vuelve a `pending` al resubirse; la solicitud
  sigue `applicant`. **Rechazo de solicitud** completa: `rejected`, con reintento permitido.

### Cambio respecto a la conversación previa (importante)

En iteraciones anteriores se habló de **3 aprobaciones** (solicitud → afiliado → pago) con el
estado intermedio `pending` y "orden libre" entre aprobar-afiliado y aprobar-pago. La decisión
final (D6) **colapsa** "aprobar solicitud" y "aprobar afiliado" en un solo acto:

- **Ya no hay estado `pending` para el canal app** (el solicitante aprobado nace `approved`).
- Quedan **2 aprobaciones**: (1) solicitud/afiliado, (2) pago.
- El modal "Establecer inicio" tiene **un solo disparador**: la aprobación del **pago** (el
  afiliado ya está aprobado; el pago es siempre la segunda condición). Se conservan "posponer" y
  la card llamativa como entradas alternativas (§4.4).

---

## 4. Flujo end-to-end

### 4.1 App — registro y solicitud

1. **Pantalla informativa (pública, previa al registro):** beneficios de la membresía + precio
   (membresía + tarifa semanal) + aviso "al finalizar pagarás mínimo membresía + 1 semana".
   Consume `GET /driver-auth/membership` (enriquecido con beneficios) y `/subscription-plans`.
2. **Registro paso 1:** datos personales + cuenta (cédula + clave) + **check de privacidad**.
   `POST /driver-auth/register` crea `users` + `drivers` (`applicant`), devuelve token. **No**
   exige documentos ni vehículo (a diferencia de hoy).
3. **Pantalla "solicitud enviada / en revisión".**
4. **Post-login — "Completa tu solicitud":** dos cards estilo resumen (referencia visual: la card
   de Tarifa del panel), con badge de progreso:
   - **Documentos** — un *step* por cada `requirement` de `applies_to='driver'` (obligatorio y
     activo). Estado por documento: `falta subir` / `en revisión` / `aprobado` / `rechazado`.
   - **Vehículos** — agregar vehículo(s) + un *step* por cada `requirement` de
     `applies_to='vehicle'`.
   - Los *steps* **no son bloqueantes**: el usuario sube todo sin esperar aprobación; navega libre
     entre ellos. Una pantalla lista aprobados/rechazados; tocar un rechazado abre su detalle
     (documento + **motivo** + editar/reenviar → vuelve a `pending`).
5. **Pago (cuando `approved` con deuda):** se habilita el paso de pago (el paso 4 actual):
   membresía + 1 semana + **adelantar semanas** (`enroll` + `periods`), con **check de T&C**.
   `POST /driver-auth/payment-submissions` → recibo `pending`.

### 4.2 Admin — sección Solicitudes

- **Lista** de solicitudes (`source='app' AND status='applicant'`), separada de Afiliados, con
  buscador en vivo (mismo patrón que las otras listas).
- **Detalle de solicitud** (espejo aligerado del perfil del afiliado): **datos del solicitante +
  Documentos + Vehículos**. **Sin** pagos, deuda, facturas ni semanas (un solicitante aún no
  tiene nada de eso).
- **Aprobar/rechazar** cada documento (con motivo) y cada vehículo (con motivo).
- **Aprobar solicitud**: habilitado **solo** si todos los documentos y vehículos están
  `approved` y hay ≥1 vehículo → `applicant` → `approved` + genera **deuda base**.
- **Rechazar solicitud** → `rejected`.

### 4.3 Admin — perfil del afiliado (ya aprobado, con deuda)

- Aparece en **Afiliados** (ya no en Solicitudes). Muestra la **deuda** (membresía + 1 semana) y,
  al pagar, el recibo `pending`.
- **Aprobar pago** (en Recibos / detalle del submission) → deuda 0 ⇒ dispara el modal de arranque.

### 4.4 Arranque de tarifa desacoplado — modal "Establecer inicio"

El modal reemplaza al actual (que iba pegado a la aprobación). Botones: **"Establecer inicio"**
(con la opción elegida: *comenzar ahora* | *próximo lunes*) y **"Establecer inicio luego"**.

Tres entradas:

- **(A) Automática:** al **aprobar el pago** (con el afiliado ya aprobado), el modal salta solo.
- **(B) Posponer:** "Establecer inicio luego" cierra sin anclar.
- **(C) Card del perfil:** si se pospuso, la **card de Tarifa** del perfil queda **resaltada** con
  un mensaje "aún sin fecha de inicio"; al tocarla, reabre el modal.

Condición para que el arranque sea posible: **afiliado aprobado ∧ pago aprobado ∧ deuda 0**.
Al establecer el inicio, se **anclan** las ventanas de la suscripción (activa o `scheduled` según
la opción) y el afiliado **opera**.

> **Resuelto (Q1 · 2026-08-11):** el arranque desacoplado aplica a **ambos canales** (app y
> panel). Hay un **único** mecanismo de arranque (`start-tariff`); la aprobación **deja de anclar
> la tarifa para todos los afiliados**. El registro por el panel (`driver-wizard` + aprobación)
> también deja de llevar el `startMode` inline y pasa por el mismo modal "Establecer inicio"
> (ver Fase 2). **Matiz:** el desacople del arranque (universal) es **independiente** de la
> relajación de "aprobar sin exigir deuda 0", que es **exclusiva del canal app** (D6): el canal
> panel conserva su gate `assertApprovable` (deuda 0) al aprobar; solo se le separa el arranque.

---

## 5. Modelo de datos (migración)

Una sola migración aditiva (`node-pg-migrate`, `.cjs`), luego `npm run db:types` + `typecheck` +
actualizar `docs/database/schema.md`. **Sin backfill** de filas existentes.

| Objeto | Cambio | Detalle |
|---|---|---|
| enum `driver_status` | **+`applicant`** | `ADD VALUE IF NOT EXISTS` (patrón PG15 ya usado) |
| `documents` | **+`approval_status`** enum `document_approval` (`pending`\|`approved`\|`rejected`) | Eje de **revisión**, separado de la vigencia |
| `documents` | **+`rejection_reason` text null** | Motivo visible al solicitante |
| `documents` | **+`reviewed_by` / `reviewed_at`** (opcional) | Rastro de quién revisó |
| `vehicles` | **+`rejection_reason` text null** | Ya tiene `approval_status` |
| `drivers` | **+`accepted_privacy_at` / `accepted_terms_at`** timestamptz null | Consentimiento con rastro |
| `drivers` | Marcador de **"inicio no establecido"** | A definir: derivar de la suscripción sin anclar, o flag/timestamp explícito |
| `document_status` (valid/expired) | **inerte** | No se toca ahora; cleanup posterior (D10) |

**Defaults de `documents.approval_status`:**

- Documento subido por la **app** → nace `pending` (a revisar).
- Documento subido por el **admin** (perfil/panel) → nace `approved` (el admin es la autoridad;
  coherente con los vehículos que registra el admin, que nacen aprobados).

**Regla de completitud (para aprobar la solicitud):** todos los `documents` requeridos de
`driver` y de cada `vehicle` en `approval_status='approved'`, todos los `vehicles` en
`approval_status='approved'`, y **≥1 vehículo**. Se valida en el service antes de la transición.

---

## 6. Contrato de API (nuevo / modificado)

> Nombres finales se afinan en implementación; el patrón de módulos se respeta:
> `routes` (JSON Schema) → `service` (reglas) → `repository` (SQL).

### Público (app, sin token)

| Método | Ruta | Cambio |
|---|---|---|
| GET | `/driver-auth/membership` | **Enriquecer** con la lista de beneficios (pantalla informativa) |
| GET | `/driver-auth/subscription-plans` | Sin cambio |
| GET | `/driver-auth/requirements` | Sin cambio |
| POST | `/driver-auth/register` | **Reducido a paso 1** (datos + cuenta); persiste `accepted_privacy_at`; **quita** la exigencia de docs/vehículo; nace `applicant` |

### App con token (solicitante)

| Método | Ruta | Cambio |
|---|---|---|
| GET | `/driver-auth/me` (+ checklist) | Devuelve estado + por requirement: `falta`/`en revisión`/`aprobado`/`rechazado`+motivo |
| POST | `/driver-auth/me/documents` | **Nuevo**: crear documento (metadata) de driver o de vehículo |
| POST | `/driver-auth/documents/:id/file` | Existe (subir archivo) |
| POST | `/driver-auth/me/vehicles` | **Nuevo**: crear vehículo post-registro |
| POST | `/driver-auth/vehicles/:vehicleId/images` | Existe (subir imágenes) |
| POST | `/driver-auth/payment-submissions` | Existe; **gateado** a `approved` con deuda; persiste `accepted_terms_at` |

### Admin

| Método | Ruta | Cambio |
|---|---|---|
| GET | `/drivers?source=app&status=applicant` | **Filtro `source`** nuevo en `GET /drivers` (hoy solo `status`/`search`) |
| GET | `/drivers/:id` | Existe; alimenta el detalle de solicitud (vista aligerada) |
| POST | `/documents/:id/approve` \| `/reject` | **Nuevo**: aprobar / rechazar documento (+ `reason`) |
| POST | `/vehicles/:id/approve` \| `/reject` | **Nuevo**: aprobar / rechazar vehículo (+ `reason`) |
| POST | `/drivers/:id/approve-application` | **Nuevo/repurpose**: valida completitud → `applicant`→`approved` + **deuda base**; **no** exige deuda 0 |
| POST | `/drivers/:id/reject-application` | **Nuevo**: → `rejected` |
| POST | `/payment-submissions/:id/approve` | Existe; al aprobar dispara (en el front) el modal de arranque |
| POST | `/drivers/:id/start-tariff` | **Nuevo**: `{ startMode: 'now' \| 'next_monday' }`; ancla la tarifa; exige afiliado aprobado ∧ pago aprobado ∧ deuda 0. **Desacopla** el arranque de `approve` |

> **Reuso backend:** la deuda base reutiliza la ruta ya existente del alta sin pago
> (`enrollDebtOnClient` / `debtAlta`, membresía + 1 semana). El anclaje de tarifa reutiliza la
> lógica de re-anclaje de ventanas de `enrollment.approve`, **movida** a `start-tariff`.

---

## 7. Plan de implementación por fases

Orden: **backend (contrato) → admin (control) → app (consumo)**. Cada fase deja `typecheck`/
`build` en verde y la doc al día (endpoints.md · schema.md · decisions-log.md).

### Fase 1 — Backend (el contrato)

1. **Migración** (§5) + regenerar modelos + `typecheck` + `schema.md`.
2. **Registro reducido**: `driver-auth/register` a solo paso 1; nace `applicant`; persiste
   privacidad; se elimina la validación de completitud (se muda a la aprobación).
3. **Endpoints incrementales de la app** (crear documento, crear vehículo) + **checklist**.
4. **Aprobación granular**: aprobar/rechazar documento y vehículo (con motivo).
5. **Aprobar/rechazar solicitud**: valida completitud → `approved` + deuda base / `rejected`.
6. **Gating** de `payment-submissions` al estado correcto.
7. **Desacople del arranque**: partir `approve` (ya no ancla ni exige deuda 0) y crear
   `start-tariff`. Definir el marcador de "inicio no establecido".
8. **Catálogo público con beneficios** + persistir T&C en el pago.
9. **Doc**.

### Fase 2 — Admin

1. **Sección Solicitudes**: ruta lazy + ítem de menú (grupo Operación) + lista filtrada.
2. **Detalle de solicitud** (espejo aligerado, sin dinero) con aprobar/rechazar por documento y
   por vehículo (+ motivo).
3. **Aprobar solicitud** (deshabilitado hasta completitud total) / rechazar.
4. **Afiliados**: excluir `applicant`.
5. **Desacople del arranque** en el perfil: card de Tarifa resaltada + mensaje cuando falta
   inicio; modal "Establecer inicio" / "Establecer inicio luego"; disparo automático al aprobar
   el pago.
6. **Aprobación del panel** (`driver-wizard` + perfil): la aprobación de afiliados registrados por
   el panel **también** deja de llevar el `startMode` inline (Q1); pasa por el mismo modal
   "Establecer inicio". Su gate `assertApprovable` (deuda 0) se conserva.

### Fase 3 — App

1. **Pantalla informativa** previa (beneficios + precio + aviso de pago), pública.
2. **Registro = solo paso 1** (datos + cuenta + privacidad) → pantalla "en revisión".
3. **Pantalla del solicitante** post-login: cards Documentos + Vehículos + lista de estados.
4. **Detalle de documento rechazado**: ver + motivo + editar/reenviar.
5. **Steps de vehículo**: agregar vehículo + sus documentos.
6. **Paso de pago diferido** (cuando `approved` con deuda): reusa el paso 4 (`enroll` + periods +
   adelanto) + **check T&C**. Enrutado que distingue "aprobado con deuda" (pagar) de "operando".
7. **Enum de estado del cliente**: +`applicant`; enrutado por estado.

---

## 8. Cabos abiertos / a confirmar

- **Q1 — Alcance del desacople del arranque:** ✅ **RESUELTO (2026-08-11):** aplica a **ambos
  canales** (app y panel). Único `start-tariff`; la aprobación deja de anclar la tarifa para todos.
  La relajación de "aprobar sin deuda 0" queda **solo** para app (D6); el panel conserva su gate.
- **Q2 — Marcador de "inicio no establecido":** ¿derivado de la suscripción sin anclar, o columna
  explícita en `drivers`? (define cómo el front decide la card resaltada y el enrutado de la app).
- **Q3 — Editar datos del paso 1 tras enviar** (si el admin detecta un error de tipeo): **fuera de
  alcance** salvo indicación.
- **Q4 — `rejected` de solicitud vs reintento:** al reintentar, ¿el solicitante vuelve a
  `applicant` reutilizando su misma fila `drivers` (recomendado) o se maneja distinto?

## 9. Reglas del proyecto que aplican

- BD ↔ modelos sincronizados: tras la migración, `npm run db:types` + `typecheck`; nunca editar
  `src/db/models/` a mano.
- Doc en el mismo cambio: `endpoints.md`, `database/schema.md`, `decisions/decisions-log.md`.
- Patrón de módulos backend: `routes` → `service` → `repository` (SQL solo en repos).
- Frontend: `core` no importa de `features`; features lazy; UI en español, código en inglés;
  `shared/components/select` para desplegables; formularios con `#f="ngForm"` + `markAllAsTouched()`.
- Dinero: los documentos de dinero no se borran; deuda con rastro; numeración de facturas continua.
- Límite duro de 1000 líneas por archivo fuente.
```
