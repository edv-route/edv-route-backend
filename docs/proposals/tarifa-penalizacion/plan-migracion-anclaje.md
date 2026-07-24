# Plan de migración — anclaje semanal (prerequisito para encender el motor de deuda v8)

> **ESTADO: diseño, previo a ejecución.** Fecha: 2026-07-24. Este documento define cómo llevar
> las suscripciones **semanales vivas** del modelo actual (**ventana móvil**) al modelo del motor
> de deuda (**semana anclada al lunes**) **sin cobrar de más, sin borrar dinero y de forma
> reversible**. Es el gate de mayor riesgo antes de poner `debt_engine_enabled = true`
> ([analisis-impacto-v8 §4 y §6](analisis-impacto-v8.md)). **No se ejecuta nada hasta aprobarlo.**

## 0. El gap (por qué hace falta)

Hoy los períodos se crean con **ventana móvil**: `subscription_payments.period_start` queda anclado
a la fecha de aprobación/cobro (alineado a medianoche del día correspondiente), **no al lunes**.
Cada semana pagada es **una fila** `status = 'paid'`; un adelanto ×N son N filas consecutivas.

El motor v8 (`plugins/debt-scheduler.ts`) emite el cargo de la semana que arranca el **próximo
lunes** con `period_start = date_trunc('week', now())` (lunes exacto) y un **guard de idempotencia**
que solo reconoce cobertura si existe una fila con **ese `period_start` exacto**, `charge_kind =
'period'` y `status <> 'refunded'`.

**Riesgo:** los pagos móviles existentes **no** caen en lunes exactos, así que el guard **no los
reconoce**. Al encender el motor, emitiría un cargo `pending` para la semana del lunes **aunque el
chofer ya la tenga pagada**; el lunes ese cargo pasa a `overdue` → **cobro indebido / mora falsa /
suspensión de quien no debe**. Es exactamente el riesgo que el análisis marca como "dinero".

## 1. Dependencia crítica que NO es de datos (léase primero)

Migrar los datos existentes **no basta**. Los flujos de cobro (`enroll`, `renew`, `changePlan`,
`resume` en `enrollment.repository.ts`) siguen creando períodos con **ventana móvil**. Si se enciende
el motor sin cambiarlos, **cada pago nuevo** (una renovación adelantada) volvería a caer fuera del
lunes y el motor lo recobraría — el mismo bug, para datos nuevos.

➡️ **Prerequisito de código, junto con esta migración:** anclar al lunes la creación de períodos de
tarifas `weekly` en `enroll`/`renew`/`changePlan` y el re-anclaje al lunes en `resume`
(hoy hace *shift* móvil). Es la sección 4 del análisis; sin ella, la migración de datos se degrada
en cuanto alguien renueve.

> ✅ **Implementado el 2026-07-24** detrás del flag `debt_engine_enabled` (con el motor apagado, el
> cobro sigue en modo prepago; verificado con typecheck + prueba de anclaje). Queda ejecutar la
> migración de datos de las suscripciones vivas.

## 2. Alcance y sub-casos

| Caso | Tratamiento |
|---|---|
| `active` + plan `weekly` **al día** (cobertura vigente) | **Caso principal**: re-anclaje automático (§4) |
| `active` + `weekly` **sin cobertura vigente** (debería estar `expired`) | **Pre-condición**: resolver a mano **antes** de migrar (cobrar o ajustar). La migración automática **asume al día** |
| `expired` + `weekly` | No se migra: el motor no toca subs no-`active`. Se resuelve al renovar (con el anclaje-lunes del §1). Listar y decidir caso por caso |
| `paused` (licencia) | El motor ya los salta. El re-anclaje al lunes ocurre en `resume` (código §1), no aquí |
| `scheduled` / `pending_payment` | No-`active`: el motor no los toca. Sin acción |
| Planes `monthly`/`annual` | Fuera del motor (solo `weekly`). Siguen en prepago. Sin acción |

## 3. Estrategia: re-anclaje "a favor del chofer"

Reescribir (`UPDATE`) el `period_start`/`period_end` de la **cobertura no consumida**
(`status = 'paid'`, `charge_kind = 'period'`, `period_end > now()`) para que ocupe **semanas-lunes
consecutivas desde el lunes de la semana en curso**.

- **No duplica dinero ni crea filas**: solo cambia la ventana temporal de pagos ya registrados;
  `amount_usd`, `invoice_id` y el rastro quedan intactos (regla de oro #7).
- **No toca los pagos ya consumidos** (`period_end <= now()`): son historia y son **inertes** para
  el motor (no son `pending`, no cuentan como deuda, no chocan con el guard).
- **Redondeo a favor del chofer**: si la cobertura terminaba a mitad de una semana, esa semana queda
  como pagada completa. Nunca en contra de quien ya pagó.

Resultado: el guard del motor **reconoce** las semanas cubiertas (mismos lunes) y **no recobra**; el
primer cargo `pending` que emitirá es el de la **primera semana-lunes sin cobertura**.

## 4. Algoritmo por suscripción (SQL conceptual, `tz = business_timezone`)

```sql
-- Re-ancla la cobertura NO consumida a lunes consecutivos desde el lunes actual.
WITH anchor AS (
  SELECT date_trunc('week', (now() AT TIME ZONE :tz)) AS monday_local  -- lunes 00:00 local
), ordered AS (
  SELECT sp.id, row_number() OVER (ORDER BY sp.period_start) - 1 AS idx
  FROM subscription_payments sp
  WHERE sp.driver_subscription_id = :sub
    AND sp.status = 'paid'
    AND sp.charge_kind = 'period'
    AND sp.period_end > now()               -- solo cobertura vigente/futura
)
UPDATE subscription_payments sp SET
  period_start = (a.monday_local + make_interval(days => o.idx * 7))       AT TIME ZONE :tz,
  period_end   = (a.monday_local + make_interval(days => (o.idx + 1) * 7)) AT TIME ZONE :tz
FROM ordered o, anchor a
WHERE o.id = sp.id;

-- Alinea la ventana "actual" de la suscripción a la semana en curso.
UPDATE driver_subscriptions ds SET
  current_period_start = (SELECT monday_local FROM anchor)                      AT TIME ZONE :tz,
  current_period_end   = ((SELECT monday_local FROM anchor) + interval '7 days') AT TIME ZONE :tz
WHERE ds.id = :sub;
```

Con `k` = nº de filas re-ancladas (semanas de cobertura restante), quedan cubiertas
`[lunes_actual … lunes_actual + (k-1)]`; el motor emitirá el `pending` de `lunes_actual + k`.

## 5. Procedimiento de ejecución (runbook)

1. **Ventana controlada**: elegir un momento sin cobros concurrentes (idealmente **lunes temprano**,
   para que "la semana en curso" sea nítida). Motor **apagado** todo el tiempo.
2. **Diagnóstico (read-only)** — dimensionar y detectar los casos que rompen la pre-condición:
   ```sql
   SELECT ds.status, p.billing_period,
          count(*) FILTER (WHERE sp.status='paid' AND sp.period_end > now()) AS semanas_vigentes
   FROM driver_subscriptions ds
   JOIN subscription_plans p ON p.id = ds.plan_id
   LEFT JOIN subscription_payments sp ON sp.driver_subscription_id = ds.id
   WHERE p.billing_period = 'weekly'
   GROUP BY ds.id, ds.status, p.billing_period;
   ```
   Resolver a mano los `active` sin cobertura vigente y listar los `expired` (§2).
3. **Backup**: `pg_dump` de `subscription_payments` y `driver_subscriptions` (o snapshot/branch de
   Supabase). Es el punto de retorno.
4. **Dry-run**: correr el script en modo simulación (reporta el antes/después de cada fila, no
   escribe). Revisar que ningún chofer pierda semanas ni gane de más allá del redondeo.
5. **Apply**: script **transaccional**, una suscripción por unidad, **auditando** cada cambio
   (actor sistema, evento `subscription.reanchored`). Idempotente (re-ejecutar no altera lo ya
   anclado).
6. **Verificación** (motor aún apagado) — §6.
7. **Encender**: solo si §6 pasa, `debt_engine_enabled = true`. Observar el primer ciclo real
   (emisión del viernes, mora del lunes) con logs.

## 6. Verificación (antes de encender)

- Cada `active`/`weekly` al día: sus pagos `paid` vigentes están en **lunes consecutivos** desde el
  lunes actual, **sin huecos ni solapes**, `count = semanas_vigentes` del diagnóstico.
- `runDebtEngineTick` en un **branch de Supabase** con **reloj simulado** avanzando semana a semana:
  1. no recobra semanas cubiertas (el guard las reconoce);
  2. emite el `pending` de la primera semana no cubierta el viernes;
  3. mora al lunes, penalización al superar el tope (2), sin re-multar;
  4. saldar → `approved`; idempotente en cada tick.
- Convivencia con `subscription-scheduler`: confirmar que su *advance* de weekly no pelea con el
  motor (el *expire* de weekly ya está inhibido por el flag).

## 7. Reversibilidad

- La migración **solo hace `UPDATE`** de `period_start/end` y `current_period_*`; con el dump del
  paso 3 se restaura el estado exacto.
- El motor arranca **apagado**: si la verificación falla, se apaga (ya lo está) y se revierte sin
  que se haya cobrado nada.
- Nada se borra ni se anula: los importes y facturas no se tocan.

## 8. Entregables pendientes (para implementar tras aprobación)

1. ✅ **Código §1 (2026-07-24)**: anclaje al lunes en `approve`(enroll)/`renew`/`changePlan` y
   re-anclaje en `resume` para weekly, **detrás del flag** `debt_engine_enabled`; verificado
   (typecheck + prueba de anclaje en `tests/debt-engine.test.ts`).
2. ✅ **Script `scripts/reanchor-weekly.ts` (2026-07-24)**: `npm run db:reanchor` (dry-run,
   read-only) / `npm run db:reanchor -- --apply` (transaccional + auditoría `subscription.reanchored`).
   Aborta si alguna suscripción weekly activa no tiene cobertura vigente (pre-condición). **No** es
   migración de esquema → no regenera modelos. **Dry-run verificado contra dev.**
3. **Validación con reloj simulado** en branch (§6).
4. **Runbook de corte** firmado con Luis (día/hora, responsable, criterio de rollback).

> Con esto cubierto y verificado, encender el motor deja de ser un salto de fe: es un cambio de
> flag sobre datos ya consistentes.
