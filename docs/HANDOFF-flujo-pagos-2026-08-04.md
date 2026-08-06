# HANDOFF — Flujo de PAGO / FACTURACIÓN / APROBACIÓN (admin + backend) · 2026-08-04

> Tarea AISLADA: arreglar el flujo de pago/aprobación del **panel admin** (`edv-route-admin`) y su
> lógica en el **backend** (`edv-route-backend`). **NO es la app Flutter** — la app se trabaja en OTRA
> ventana con `edv-route-mobile/docs/HANDOFF-2026-08-04.md`. No pisar archivos de `driver-auth`/
> `registration`/wizard de la app.
> Reglas de Luis (`C:\Users\luisv\.claude\CLAUDE.md`): chat en **español**, código en **inglés**; si el
> prompt termina en `?` = solo-lectura; ser directo/crítico; avisar antes de codear algo que rompa
> SoC/DRY; **no pushear sin que Luis lo pida**. Están en **DESARROLLO** (BD Supabase dev, modificable).
> **Verificar cada cambio** (backend `npm run typecheck`; admin `npm run build`) — Luis está molesto por
> parches a medias sin verificar el flujo completo. **Este flujo debe quedar PERFECTO, no un parche.**

---

## Contexto: qué pasó (escenario real de Luis)

Modelo v9: el alta se registra SIN pago → emite **factura de deuda** (opción A) = membresía + **1 semana**
de tarifa; el pago capturado va como **submission `pending`** que un admin aprueba en Facturación →
"Por aprobar" → `/billing/submissions/:id`. Al aprobar, `settleDebtOnClient` marca los cargos `paid`.

Luis registró un chofer y pagó **$225 en Efectivo Divisa** porque **pagó 5 semanas de tarifa por
adelantado** (membresía $175 + 5 × $10 = **$225**), pero el sistema solo emitió deuda de **$185**
(membresía + **1** semana). El submission quedó con `amount_usd = $225` pero la factura/deuda es $185.
**Ya se hizo (commits 2026-08-04, en `main`):** `a9bdc86` (el wizard reenvía `amountUsd` — bug de v9), y
`29256d4` (botón "Ir al pago para aprobarlo" en la banda "Pago en revisión" del perfil). Falta lo de abajo.

---

## LOS 4 FIXES (prioridad de arriba abajo)

### 🔴 FIX 1 (CRÍTICO — pérdida de dinero) — el pago del alta debe soportar N semanas de adelanto
**Problema:** al registrar/cobrar el alta, el efectivo (y cualquier método) solo salda la deuda de **1
semana** ($185). Si el chofer paga **N semanas por adelantado** ($225 = 5 semanas), el excedente **se
pierde en silencio**: `settleDebtOnClient` (`src/modules/drivers/enrollment.repository.ts:637-722`) suma
los cargos existentes (membresía + 1 semana = $185), no el `amount_usd` del submission; el excedente de
$40 (4 semanas) no genera crédito, ni cargos de semanas extra, ni traza. La factura queda en $185.

**Qué se necesita:** que la captura del pago del alta permita indicar **cuántas semanas** se pagan, y que
al aprobar se emitan/salden **membresía + N semanas** (no 1). El backend YA tiene el camino de adelanto:
- `purpose='advance'` en el submission → `PaymentSubmissionsService` (`prepareAdvanceContext`) valida N
  semanas y guarda el `context`; al aprobar despacha a `EnrollmentRepository.settleAdvanceOnClient` que
  emite **UNA factura** con las N semanas. (Ver `src/modules/payment-submissions/payment-submissions.service.ts`
  y `enrollment.repository.ts` — buscar `settleAdvance`, `prepareAdvanceContext`.)
- PERO el flujo del **alta** (wizard `driver-wizard.ts` `buildDebtForm`, y "Registrar pago" del perfil
  `driver-detail.ts` ~:505-523) manda `purpose='debt'` (1 semana). Y **Efectivo Divisa** hoy solo captura
  monto + fotos, sin nº de semanas.

**Trabajo (admin + backend):**
1. En la captura de pago del admin (`src/app/features/drivers/payment-capture.ts` / `.html`) permitir
   **elegir cuántas semanas** se pagan en el alta (default 1). Para Efectivo Divisa hay que decidir el UX
   (¿selector de semanas + el monto? ¿derivar semanas del monto?) — **CONSULTAR a Luis** el UX exacto.
2. Cuando N>1, el submission del alta debe ir con `purpose='advance'` + `periods=N` (o el mecanismo de
   advance existente) para que al aprobar se emitan N semanas y la factura refleje el total real ($225).
3. Verificar que `settleAdvanceOnClient`/`prepareAdvanceContext` cubran el caso del ALTA (membresía + N
   semanas) desde el submission, sin duplicar la factura de deuda ya emitida en el registro.
4. **Regla del excedente / cobertura**: el total pagado ($225) debe corresponder EXACTO a membresía + N
   semanas; nada debe perderse. Si el monto no cuadra con N semanas, avisar (no descartar).
> Es una decisión de negocio + implementación; NO improvisar. Mapear el flujo advance completo antes de tocar.

### 🟠 FIX 2 — al aprobar, el comprobante (fotos) debe quedar en la factura
Hoy el módulo `payment-submissions` **no toca `proof_url`**: al aprobar (`approve` en
`src/modules/payment-submissions/payment-submissions.repository.ts:370-381`) estampa en la factura
`payment_method_id/reference/payer_*` pero **no el comprobante** → la factura muestra "Sin comprobante"
aunque el submission tiene las fotos (`payment_submission_files`). El "Registrar pago" estándar sí muestra
comprobante en otros flujos — **replicar ese comportamiento**: copiar/vincular la(s) imagen(es) del
submission al `proof_url` de la factura al aprobar (o exponerlas desde la factura). Verificar cómo el resto
de facturas obtienen su comprobante (`billing.repository.ts`, `billing.html:199-206` usa `hasProof` =
`proof_url IS NOT NULL`) y dejar el efectivo/submission consistente.

### 🟡 FIX 3 — deshabilitar el botón "Aprobar" del chofer hasta que el pago esté aprobado
En el perfil (`src/app/features/drivers/driver-detail.html:62-71`, botón "Aprobar" que llama
`confirmAction.set('approve')` → aprueba el CHOFER), **deshabilitarlo mientras haya `pendingSubmission()`**
(`driver-detail.ts:143`). Hoy si se pulsa con pago pendiente, el backend lo bloquea (`assertApprovable`,
`src/modules/drivers/drivers.service.ts:566-579`) con un error confuso de "deuda". Deshabilitar el botón
(y/o tooltip "Aprueba primero el pago") + opcionalmente mejorar el mensaje del backend.

### 🟡 FIX 4 — chofer RECHAZADO: ocultar la banda "Deuda pendiente" y el botón "Registrar pago"
Cuando `driver.status === 'rejected'`, el perfil (`driver-detail.html` / `.ts`) NO debe mostrar la banda
"Deuda pendiente" ni el botón **"Registrar pago"** (header del perfil) — ya no aplican (ver captura: chofer
"Luis David Villegas Vargas V-22198956", Rechazado, pero sigue mostrando deuda + Registrar pago).
Condicionar esas dos piezas a que el estado no sea `rejected` (y probablemente tampoco tenga sentido con
`rejected` mostrar el bloque de deuda). Buscar en `driver-detail.html` la banda de deuda (`@if (hasDebt())`)
y el botón "Registrar pago" del header, y excluir `rejected`.

---

## Diagnóstico ya hecho (rutas verificadas, reutilizar)
- "Por aprobar": `billing.ts` tab `'review'` (`:37`,`:59`,`:186-203`), `billing.html:69-77`; lista
  `GET /payment-submissions?status=pending` (`payment-submissions.api.ts:22-27`; SQL
  `payment-submissions.repository.ts:174-213` — sin filtros por source/purpose/método).
- Revisión/aprobación: ruta `/billing/submissions/:id` (`app.routes.ts:72-78`), componente
  `payment-submission-detail.ts` (`approve` :84-97 → `POST /payment-submissions/:id/approve`).
- Perfil: `driver-detail.ts` (`pendingSubmission` :143, `approve` chofer :348-364), `driver-detail.html`
  (banda pago revisión :113-120 — ya tiene el botón; botón aprobar chofer :62-71).
- Deuda del alta: `enrollment.repository.ts` `enrollDebtOnClient` :100-160 (total = membresía + 1 semana,
  :115). Aprobación deuda: `settleDebtOnClient` :637-722 (suma cargos = $185, no el efectivo).
- Historial perfil (`driver-payments.ts:126-152`) no lista submissions; template `driver-payments.html:30-33`
  imprime "Pagado el {fecha}" aun para "Pendiente" (bug menor de label, corregir si se toca).

---

## Comandos
| Dónde | Comando |
|---|---|
| backend typecheck | `npm --prefix C:\Project\edv\edv-route-backend run typecheck` |
| backend suite (⚠️ BD dev + apaga `debt_engine_enabled`) | `npm --prefix C:\Project\edv\edv-route-backend test` |
| admin build | `Push-Location C:\Project\edv\edv-route-admin; npm run build; Pop-Location` |
| push (solo si Luis lo pide) | backend/admin → `git -C <dir> add -A; git commit; git push origin main` (Railway auto) |

## Gotchas
- BD dev; reencender el motor si la suite lo apaga: `UPDATE app_settings SET value='true'::jsonb WHERE
  key='debt_engine_enabled';` (Luis lo corre en SU Supabase; el MCP de Supabase de la sesión apunta a otro
  proyecto `reintegracion22`, NO a la BD de EDV).
- Backend y admin tienen repo `main` con deploy auto en Railway. **La app NO tiene repo** (se trabaja en
  otra ventana; no tocar sus archivos).
- Commits de dinero nunca se borran (regla del proyecto); facturas se anulan/reembolsan con rastro.
- Chofer de prueba con el problema del adelanto: buscar el que tenga submission cash $225 pendiente.
