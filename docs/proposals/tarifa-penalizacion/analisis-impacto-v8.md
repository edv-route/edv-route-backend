# Análisis de impacto — Motor de deuda y penalización (diseño v8)

> **ESTADO: análisis técnico, previo a la implementación.** Fecha: 2026-07-23. Este documento
> traduce la [propuesta de negocio](README.md) a un plan de ingeniería: qué cambia respecto a
> producción, cómo se modela la deuda sobre el esquema actual, el impacto por capa, las
> decisiones que faltan cerrar (con recomendación) y las sub-fases verificables. **No se ha
> escrito código.** Es el paso que la propuesta pide explícitamente ("requiere análisis de
> impacto y aprobación final antes de implementar").
>
> Es la **Fase B** del [rediseño del estado del chofer](../estados-del-chofer/README.md):
> `overdue` y `penalized` los dispara este motor. La Fase A (estado `paused`, congelamiento de
> tarifa) ya está implementada.

## 1. Qué cambia respecto a lo que está en producción

| Tema | Hoy (producción) | v8 (motor de deuda) | Capa afectada |
|---|---|---|---|
| Ventana del período | **Móvil** desde `now()` (decisión 2026-07-13) | **Anclada al lunes 00:00** (semana calendario) | `enrollment.repository`, scheduler |
| Al vencer sin pagar | **Suspensión inmediata** (`grace = 0`): `driver_subscriptions → expired` | Sigue operando hasta el **tope de deuda** (2 semanas); luego `penalized` | scheduler, `driver_status` |
| Concepto de "deuda" | No existe (prepago puro) | **Semanas debidas** = cargos emitidos y no pagados | derivado de `subscription_payments` |
| Concepto de "penalización" | No existe | **Cargo extra** (1 semana) al superar el tope | `subscription_payments` (concepto nuevo) |
| Emisión del cobro | Manual (`enroll`/`renew`) | **Automática semanal** (viernes emite la semana del lunes) | scheduler (job nuevo) |
| Reactivación | Inmediata al pagar | Pagar 4 semanas → **lunes siguiente** (auto) o inmediata (admin) | scheduler, `enrollment.repository` |
| Estado operativo | `driver_subscriptions.status` | Se **deriva** a `driver_status` (`overdue`/`penalized`) | Fase A + este motor |

**Lo que ya juega a favor** (no hay que construirlo): la separación estado-tarifa vs.
administrativo; el reembolso/anulación con rastro; el estado `paused` (congela la tarifa) e
`inactive` (acumula) de la Fase A; y el override por **pago externo** ya definido.

## 2. Modelado técnico de la deuda (sin tablas nuevas)

**Decisión de modelado recomendada: la deuda se DERIVA, no se almacena en un contador.** Se
reutiliza `subscription_payments` como libro de cargos semanales y el valor de enum
**`overdue`** que **ya existe** en `subscription_payment_status` (hoy sin uso):

- El **job semanal** (viernes) inserta la fila de la semana siguiente con `status = 'pending'`
  y su factura (ventana `[lunes 00:00, lunes+7 00:00]`). Es un **cargo emitido**, no pagado.
- El chofer paga → la fila pasa a `paid` (flujo de cobro existente, `enroll`/`renew`).
- Llega el lunes y no se pagó → la fila pasa a **`overdue`** (semana debida).
- **Semanas debidas** = `count(*)` de filas `overdue` (o `pending` ya vencidas) de la
  suscripción. El **estado del chofer se deriva**:

  | Semanas debidas | `driver_status` derivado |
  |---|---|
  | 0 | `approved` (al día) |
  | 1 … tope (2) | `overdue` (opera) |
  | > tope | `penalized` (no opera; deuda congelada en el tope) |

- La **penalización** es una fila de cargo extra (una factura/pago con concepto "multa") que
  se emite al cruzar el tope; forma parte de las 4 semanas para reactivar.
- El **pago externo** (override del admin) salda las filas impagas por el flujo de cobro normal
  → semanas debidas = 0 → el chofer vuelve a `approved` **por derivación**. Sin escribir el
  estado a mano, sin overrides que el scheduler pise (coherente con lo cerrado en Fase A).

**Por qué derivar y no un contador:** una columna `weeks_owed` sería una segunda fuente de
verdad que el scheduler tendría que mantener sincronizada con los pagos — el mismo antipatrón
que rechazamos en el rediseño de estados. Las filas de pago **ya son** la verdad contable
(regla de oro #7: el dinero se registra, no se infiere).

## 3. Decisiones que faltan cerrar (con recomendación)

Estas son de **negocio**: no las cierro yo. Doy opciones y una recomendación para acelerar.

1. **Alcance del cobro semanal.** La propuesta es puramente semanal (viernes→lunes), pero el
   catálogo soporta `daily/weekly/monthly/annual` (hoy activos: Semanal $10, Mensual Motos $35).
   - **A (recomendada):** el motor de deuda aplica **solo a tarifas semanales**; el resto sigue
     con el prepago actual, o se retira del catálogo. Acota el riesgo; se generaliza después.
   - **B:** generalizar la deuda a "N períodos" para cualquier periodicidad.
   - ⚠️ Sub-decisión de A: **¿qué pasa con la tarifa Mensual Motos** existente y sus
     suscriptores? (mantenerla en prepago / migrarla a semanal / archivarla).

2. **Anclaje al lunes vs. ventana móvil.** Confirmar que v8 **reemplaza** la ventana móvil por
   **semana anclada al lunes 00:00** (tu "el reloj sigue el próximo lunes" ya lo apuntaba).
   - **Recomendada:** sí, anclada al lunes, **solo** para las tarifas del motor de deuda.

3. **Hora exacta de cobro** *(pregunta abierta de la propuesta)*: la imagen dice "viernes 6 pm";
   producción hoy corta a las 00:00.
   - **Recomendada:** **configurable** en `app_settings` (`billing_day`, `billing_hour`,
     `week_anchor_day`), seed **viernes 18:00 / lunes 00:00** en `business_timezone`.

4. **Membresía del expulsado** *(pregunta abierta)*: al pasar a `suspended` (expulsión), ¿qué
   pasa con el pago vitalicio de membresía ya cobrado?
   - **Recomendada:** **conservarla congelada** (no se devuelve ni se borra — regla de oro #7);
     si el chofer regresara, ya la tiene. Alternativas: devolver / marcar perdida.

5. **Parámetros configurables** (la propuesta ya lo pide). Claves nuevas en `app_settings`:
   `debt_cap_weeks` (2), `penalty_weeks` (1), `billing_day` (5=viernes), `billing_hour` (18),
   `week_anchor_day` (1=lunes), `reactivation_mode` (`auto`|`manual`, default `auto`).
   - **Recomendada:** confirmarlas con esos valores seed.

## 4. Mapa de impacto por archivo

- **Migración nueva** (`ALTER TYPE`, incremental como en Fase A):
  - `driver_status` += `overdue`, `penalized`.
  - Claves de `app_settings` (decisión #5).
  - Posible columna de apoyo en `driver_subscriptions` para el ancla semanal (a evaluar).
- **`plugins/subscription-scheduler.ts`** — el mayor cambio: hoy avanza/expira ventanas móviles.
  v8 añade: **emisión semanal** (viernes), **marcado `overdue`** (lunes), **transición
  `penalized`** al superar el tope, y **derivación** de `driver_status`. Debe seguir **saltando
  a los `paused`** (ya implementado). Ojo con la idempotencia (corre cada 60 s).
- **`modules/drivers/enrollment.repository.ts`** — anclaje al lunes en la creación de períodos
  (hoy `now() + interval`); el **`resume`** de la pausa pasa de "ventana móvil" a "reancla al
  lunes"; nuevo flujo de **reactivación** (4 semanas, auto/manual).
- **`modules/drivers/drivers.service.ts` / `.routes.ts`** — endpoint de **pago externo**
  (override auditado que salda deuda) y de **reactivación**; `renew` convive con la emisión
  automática.
- **`modules/drivers/drivers.repository.ts`** — el cálculo de "por vencer / cobertura pagada"
  (`max(period_end)`) cambia al concepto de "semanas debidas".
- **Dashboard** — conteos de `overdue`/`penalized`; y el pendiente ya anotado de contar los
  `paused`.
- **Frontend** — badges `En mora`/`Penalizado`, acción de **registrar pago externo**, avisos de
  plazo; mapear los nuevos estados en lista/perfil/filtros.
- **Migración de datos** — las suscripciones `active` actuales (ventana móvil) hay que
  **reconciliarlas** con el nuevo modelo de cargos semanales anclados. No es trivial: es dinero.

## 5. Sub-fases de implementación (verificables una a una)

Tocar el cobro en producción exige pasos pequeños y verificados, no un big-bang:

- **B1 — Esquema y parámetros ✅ (2026-07-23, migración `1752260000000`):** enum
  `overdue`/`penalized` (ya eran parte del modelo de estados cerrado) + las 6 claves de
  `app_settings` del motor con los valores confirmados, marcadas "en preparación (sin efecto
  hasta B2)". **No cambia el comportamiento del cobro.** typecheck limpio, migración aplicada.
- **B2 — Motor de emisión y mora ✅ (2026-07-23, `src/plugins/debt-scheduler.ts`):** job con
  **interruptor maestro `debt_engine_enabled` (false por defecto)** — apagado, el motor es
  inerte y el cobro no cambia. Emite el cargo semanal (`pending`, **sin factura**: la factura
  es comprobante de dinero recibido y se emite al cobrar), marca `overdue` las semanas ya
  arrancadas sin pagar y **deriva** `driver_status` (0 = approved · 1..tope = overdue · >tope =
  penalized). El penalizado no recibe cargos nuevos → deuda congelada en el tope. Alcance:
  **solo planes semanales**; el `subscription-scheduler` deja de expirarlas mientras el motor
  esté activo. Exporta `runDebtEngineTick` para ejercitarlo sin el timer. **Verificado E2E**:
  inerte con flag off · 1 semana → overdue · 3 semanas (tope 2) → penalized · sin cargos al
  penalizado · saldar → approved · idempotente.
- **B3 — Penalización, reactivación y pago externo ✅ (2026-07-23, migración `1752280000000`):**
  cargo de **multa** (`charge_kind = 'penalty'`, emitido en la transición a `penalized`, visible
  como "Penalización" en el historial y contable como deuda); **reactivación diferida**
  (`drivers.reactivates_at`: en modo `auto` el saldado rejoin el lunes siguiente) y **manual**
  (`POST /drivers/:id/reactivate`, exige deuda 0); **pago externo**
  (`POST /drivers/:id/external-payment`: salda todos los cargos en una transacción, emite una
  factura que los agrupa y deja constancia del motivo). **Verificado E2E**: 3 semanas → penalizado
  + multa · multa no duplicada · pago externo salda 4 cargos con 1 factura · saldado → sigue
  penalizado hasta el lunes · reactivación manual → aprobado · idempotente.
- **B4 — Frontend + dashboard:** badges, acciones, avisos, conteos. Verificación: build + E2E UI.

## 6. Riesgos

- **Es dinero en producción.** Un error en la emisión/mora cobra de más o suspende a quien no
  debe. Mitigación: sub-fases, reloj simulable en tests, y no borrar nunca (anular con rastro).
- **Migración de las suscripciones vivas** al nuevo anclaje semanal (punto 4). Requiere un plan
  de datos explícito antes de B2.
- **Idempotencia del job semanal**: el scheduler corre cada 60 s; la emisión debe ser
  exactamente-una-vez por semana (guardas por ventana, no por tiempo de ejecución).
- **Convivencia de periodicidades** si se elige el alcance A (semanal) con la Mensual Motos viva.

## 7. Estado y siguiente paso

**B1 hecho** (2026-07-23): infraestructura aditiva y reversible, sin cambiar el cobro. Las
inclinaciones de Luis quedaron como valores seed de las claves (alcance **solo semanal**,
Mensual Motos en **prepago**, membresía del expulsado **congelada**, tope 2 / penalización 1 /
viernes 18:00 / lunes 00:00 / reactivación auto+manual), **sin cerrar formalmente** el modelo
(pueden cambiar ajustando las claves).

**B2 hecho** (2026-07-23): el motor existe, está probado y **apagado** (`debt_engine_enabled =
false`). El cobro en producción **sigue intacto**; encenderlo es una decisión de negocio, no un
despliegue. El frontend ya sabe pintar `overdue`/`penalized` (badges, filtros, tarjeta de
estado) para que activarlo no deje el panel a medias.

**B3 hecho** (2026-07-23): el ciclo de dinero está completo — mora, multa, pago externo y las dos
reactivaciones. El motor **sigue apagado**; el cobro en producción no ha cambiado en ningún
momento.

**Siguiente: B4 —** lo que falta del panel: **conteos de `overdue`/`penalized` en el dashboard**
(el mismo cabo que tuvimos con `paused`) y **avisos de plazo/deuda** (cuántas semanas debe y hasta
cuándo tiene para pagar). Los badges, filtros y las acciones de pago externo / reactivación ya
están.

⚠️ **Antes de encender el motor** sigue pendiente lo de mayor riesgo: el **plan de migración de
las suscripciones `active` vivas** al anclaje semanal (secciones 4 y 6) y validar el ciclo
semanal completo con el reloj real.
