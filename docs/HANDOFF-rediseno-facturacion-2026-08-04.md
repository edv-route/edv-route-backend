# HANDOFF — Rediseño de FACTURACIÓN (factura vs recibo de pago) · 2026-08-04

> Continuación del trabajo del `HANDOFF-flujo-pagos-2026-08-04.md`. Ese arregló el flujo de
> pago del alta; **este documenta el REDISEÑO completo de facturación** que vino después.
> **Tarea:** panel admin (`edv-route-admin`) + backend (`edv-route-backend`). **NO** es la app
> Flutter (`edv-route-mobile`, otra ventana). Reglas de Luis (`C:\Users\luisv\.claude\CLAUDE.md`):
> chat en **español**, código/comentarios en **inglés**; si el prompt termina en `?` = **solo
> lectura** (no modificar); ser directo/crítico; **avisar antes** de codear algo que rompa SoC/DRY;
> **NO pushear sin que Luis lo pida**. Verificar cada cambio (backend `typecheck`, admin `build`).
> Memoria viva del tema: `C:\Users\luisv\.claude\projects\C--Project-edv\memory\rediseno-facturas-recibos.md`.

---

## Estado: REDISEÑO CERRADO · todo en verde · NADA PUSHEADO

Backend `npm run typecheck` ✅ y admin `npm run build` ✅ tras cada paso. Fase 1 (BD) **ya
ejecutada** (migración + reset corridos). Falta solo: **prueba end-to-end en navegador** (Luis),
**push** cuando Luis lo pida, y **decisión A** (opcional, ver abajo).

## El modelo (decisiones cerradas con Luis — no re-preguntar)

- **Factura = una deuda de UN concepto** (membresía · 1 semana de tarifa · penalización). Número
  propio, se paga **completa** (nunca fracción). Estados mostrados: `issued` (por cobrar) → `overdue`
  (en mora) → `paid` / `voided`. Revierte la decisión "1 factura por cobro" (2026-07-28).
- **Recibo de pago (`payment_submissions`) = documento con número propio (`submission_number`)**
  que cubre 1..N facturas. Estados: `pending` → `approved` / `rejected` / **`reverted`**.
- **El recibo GENERA sus facturas al CREARSE**, en `pending` (deuda), ligadas por
  `invoices.submission_id`. Aprobar → pagadas; **rechazar → quedan en deuda**. Única excepción:
  registro **sin pago** → 2 facturas de deuda (membresía + 1 semana) SIN recibo.
- **Vínculos:** `invoices.submission_id` = recibo que la **generó** (null = deuda sin recibo).
  `charge.submission_id` (membership_payments/subscription_payments) = recibo que la **pagó**.
- **El pago (método/referencia/comprobante) vive en el RECIBO**, no duplicado en cada factura.
- **Pago parcial:** el cobro de deuda selecciona **qué facturas** cancela (cada una completa); el
  recibo lleva `invoiceIds` (comma-separated) y `settleDebt` salda solo esas.
- **Reversión** de un recibo aprobado, con motivo: `refund` (reembolso → anula sus facturas) o
  `correction` (la deuda saldada vuelve a deber, para re-cobrar). Estado `reverted` con rastro; si
  pierde la membresía, el chofer vuelve a `pending`.
- Numeración de facturas y recibos: **secuencias separadas**, continuas. Membresía: 1 factura, solo
  en el alta.

## Fase 1 — Base de datos (YA EJECUTADA)

- Migración `src/db/migrations/1752360000000_billing-receipts.cjs`: `invoices.submission_id` (FK) ·
  `payment_submissions.submission_number` (+ `payment_submission_number_seq`) · estado enum
  `reverted` · `payment_reversal_type` (`refund`/`correction`) · `reverted_at/by` + `reversal_type`
  + `reversal_reason`.
- Script `scripts/reset-data.ts` (`npm run db:reset`): borra choferes + dinero de prueba, conserva
  catálogos/admins, reinicia numeración. **Destructivo** (la BD es la MISMA que usa Railway).

## Backend — archivos tocados

- **`modules/drivers/enrollment.repository.ts`** (motor de emisión):
  - `createInvoice(+submissionId)`; TODOS los métodos → **1 factura por concepto**.
  - `enrollOnClient` → genera membresía + N semanas **`pending`** (deuda) ligadas al recibo (lo llama
    `payment-submissions.repository.create`, NO el approve).
  - `markReceiptChargesPaid(client, submissionId)` → el approve salda los cargos del recibo.
  - `enrollDebtOnClient` → 2 facturas de deuda (registro sin pago).
  - `settleAdvanceOnClient` / `settleChangePlanOnClient` → N facturas (1/semana), generan `paid` al aprobar.
  - `settleDebtOnClient(+invoiceIds)` → marca pagadas + vincula recibo; **pago parcial** por selección; ya no agrupa.
  - `reverseReceipt` → reversión (void generadas + refund cargos; deuda solo saldada → pending; membresía perdida → chofer pending).
  - `reject` (chofer) → ahora anula también cargos **pending/overdue** (no solo `paid`), así el rechazado no deja fantasmas.
- **`modules/payment-submissions/`**:
  - `repository.create` → para `enroll` invoca `enrollOnClient` (genera pending); `approve` (enroll) → `markReceiptChargesPaid`; approve ya no estampa pago en factura (vive en recibo); `reverse(...)`.
  - `service.create` rama debt → `invoiceIds` (parcial) o toda la deuda; `service.reverse`.
  - `selectedInvoicesTotal(driverId, invoiceIds)`; `list`/`findDetail` con `submissionNumber`, `purpose`, items con `invoiceNumber`/período, campos de reversión.
  - `routes.ts` → parseo `invoiceIds` (comma-sep); `POST /payment-submissions/:id/reverse` {reversalType, reason}.
- **`modules/billing/billing.repository.ts`**: `CHARGE_LATERAL` (1 cargo/factura), `INVOICE_STATE_SQL` (+overdue), `INVOICE_CONCEPT_SQL`; `listInvoices`/`getInvoice` con concept/kind/período/submission + pago del recibo. `billing.routes` acepta filtro `overdue`.
- **`plugins/debt-scheduler.ts`**: pasos 1 (semanal) y 5 (penalización) con CTE `eligible→new_invoices→ins` → cada cargo nace con su factura (join por driver_id).
- **`modules/drivers/drivers.service.ts`**: `RegisterInput.deferredEnrollment` (el alta con pago no emite deuda base; el submission enroll la genera); `registerExternalPayment` legacy sin estampado.
- **`modules/driver-auth/driver-auth.routes.ts`**: `invoiceIds: null` (compat; la app no hace parcial).

## Frontend (admin) — archivos tocados

- **`core/models/billing.model.ts`**: InvoiceStatus `+overdue`; InvoiceListItem con concept/kind/período/submissionId/submissionNumber.
- **`core/models/payment-submission.model.ts`**: SubmissionStatus `+reverted`; SubmissionListItem con submissionNumber/purpose; SubmissionItem con invoiceNumber/período; SubmissionDetail con campos de reversión; labels.
- **`features/billing/billing.ts`/`.html`**: 3 pestañas **Pagos** (recibos) · **Facturas** (por concepto) · **Por aprobar**. Filas con "Ver detalle del pago" (no toda la fila clickeable).
- **`features/billing/payment-submission-detail.ts`/`.html`**: N° pago en header; items con N° factura al inicio (alineados); botón **Revertir pago** (solo approved) + modal (refund/correction + razón) + traza revertido; flecha `location.back()` "← Volver" sin `max-w-6xl`.
- **`features/billing/billing-invoice-detail.ts`/`.html`**: flecha `location.back()` "← Volver" sin `max-w-6xl`.
- **`features/billing/payment-submissions.api.ts`**: `reverse(id, type, reason)`.
- **`features/drivers/driver-payments.ts`/`.html`**: historial = **1 fila por recibo** (`submissionsApi.list(driverId)`); "Ver detalles" → /billing/submissions/:id.
- **`features/drivers/driver-detail.ts`/`.html`**: modal "Registrar pago" con **checkboxes de facturas de deuda** (`billingApi.invoices(driverId)` filtrado issued/overdue) + total reactivo `selectedDebtTotal` + envía `invoiceIds`; banda "Próximo cobro" oculta para `rejected`; botón del modal de rechazo = **"Rechazar"** (siempre).

## Docs actualizadas (Fase 6)

`docs/decisions/decisions-log.md` (entrada 2026-08-04) · `docs/api/endpoints.md` (recibos, /reverse, invoiceIds, N facturas) · `docs/database/schema.md` (invoices.submission_id, submission_number, reversión).

## PENDIENTE

1. **Prueba end-to-end** en navegador (Luis): registrar con/sin pago → cobrar total y **parcial** →
   aprobar → **revertir** (refund y correction) → ver Facturas/Pagos/Historial → rechazar un
   registrado sin pago (debe quedar limpio). Motor semanal requiere `debt_engine_enabled = true`.
2. **Push** (solo cuando Luis lo pida): backend + admin a `main` (Railway auto).
3. **Decisión A (opcional):** que un recibo del alta (chofer registrado sin pago) salde su deuda **y**
   genere semanas extra en un mismo cobro. Luis aceptó que el flujo actual basta (2 pasos, o alta con
   pago desde el wizard). Implica combinar debt+advance en el modal + approve.
4. **Limpieza menor:** `paySummary` computed sin uso en `driver-detail.ts`; rama `orphans` de
   `settleDebtOnClient` quedó como defensa (el motor ya emite factura por semana). Choferes rechazados
   ANTES del fix del reject pueden conservar membresía "pending" residual (nuevos quedan limpios).

## Comandos

| Qué | Comando |
|---|---|
| Typecheck backend | `npm --prefix C:\Project\edv\edv-route-backend run typecheck` |
| Build admin | `Push-Location C:\Project\edv\edv-route-admin; npm run build; Pop-Location` |
| Migrar + regenerar modelos | `cd C:\Project\edv\edv-route-backend && npm run migrate` (**ya ejecutado**) |
| Reset datos de prueba | `cd C:\Project\edv\edv-route-backend && npm run db:reset` (destructivo) |
| Dev backend / admin | `npm run dev` (:3000) · `npm start` (:4200) |
| Push (solo si Luis pide) | `git -C <dir> add -A; git commit; git push origin main` |

## Gotchas

- La BD Supabase de dev es la **misma que usa Railway** (prod): `db:reset`/migraciones son
  destructivas/de esquema en producción. Luis las corre en SU entorno.
- El MCP de Supabase de la sesión apunta a **otro** proyecto (`reintegracion22`), NO a la BD de EDV.
- Motor de deuda: `debt_engine_enabled` (jsonb en `app_settings`). La suite de tests lo **apaga** —
  reencender: `UPDATE app_settings SET value='true'::jsonb WHERE key='debt_engine_enabled';`
- Los modelos `src/db/models/` se **regeneran** (kanel), nunca a mano. Límite duro 1000 líneas/archivo.
- Los flujos legacy directos (`/drivers/:id/enroll`, `/external-payment`, `renew`/`changePlan`) no se
  usan en v9 (el panel va por recibos); quedaron compilando pero no son el camino vivo.
