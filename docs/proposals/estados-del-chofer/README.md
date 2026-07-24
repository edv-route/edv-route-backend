# Propuesta / Tarea — Rediseño del estado del chofer

> **ESTADO: MODELO CERRADO · Fase A ✅ implementada (2026-07-23) · Fase B pendiente.** Analizado
> y cerrado con Luis el 2026-07-23. Este documento es la **especificación autoritativa** del
> modelo de estados del chofer. **Fase A implementada** (migración `1752250000000`: enum +
> `paused`, endpoints de pausa/reanudación, congelamiento de tarifa, badges e indicador de
> disponibilidad). **Fase B** (`overdue`/`penalized` + motor de deuda + pago externo) sigue
> bloqueada por el motor de la propuesta de
> [tarifa con deuda y penalización](../tarifa-penalizacion/README.md). Ver
> [Plan de fases](#plan-de-fases).
>
> ⚠️ Este modelo **reemplaza** la primera versión de la propuesta (misma fecha), en la que
> `paused` era voluntario del chofer y `approved` un transitorio interno que saltaba a
> `active`. Tras la discusión de diseño con Luis, el modelo cambió: ver [Modelo cerrado](#modelo-cerrado).

## Problema

Hoy el estado administrativo del chofer (`drivers.status`) tiene solo 4 valores —
`pending`, `approved`, `rejected`, `suspended`— y el estado que determina si **opera** vive
aparte, en el plano de la tarifa (`driver_subscriptions.status`). Faltan los estados reales
del día a día: un chofer de licencia, uno en mora con sus tarifas, uno penalizado por
incumplir. Y falta separar dos cosas que hoy se confunden:

- **Un hecho administrativo** ("el admin lo aprobó", "está de licencia", "fue expulsado").
- **Una decisión voluntaria del chofer** ("quiero / no quiero recibir viajes ahora").

Son **ejes distintos** y deben modelarse por separado.

## Modelo cerrado

El estado del chofer se compone de **dos columnas ortogonales** más un **plano de deuda
derivado**. La clave del modelo es **quién escribe cada valor**:

| Origen de escritura | Qué representa | Dónde vive |
|---|---|---|
| **Administrativo** (admin humano / sistema) | La situación del chofer frente a la empresa | enum `driver_status` |
| **Deuda** (motor automático; el admin la salda, no la escribe a mano) | Si está al día, en mora o penalizado | enum `driver_status` (derivado de la deuda) |
| **Disponibilidad** (el chofer, desde su app) | Si quiere recibir viajes ahora | boolean `is_available` (ya existe) |

> **Decisión estructural (cierra la pregunta abierta "¿enum unificado o derivado?"):**
> **un enum + un boolean.** `driver_status` lleva la *situación* (administrativa + deuda,
> mutuamente excluyentes) y `is_available` lleva la *disponibilidad* voluntaria (ortogonal,
> coexiste con la situación). No son tres columnas: los estados de deuda **reemplazan**
> temporalmente a `approved` en el mismo enum, y `active`/`inactive` es un plano aparte
> porque **coexiste** con la situación (un chofer puede estar `overdue` **e** `inactive`).

### `driver_status` (enum) — la situación

Un chofer está en **exactamente uno** de estos estados. En pantalla es un **badge propio**
(igual trato para todos, incluido "Aprobado").

| Estado | En pantalla | ¿Opera? | ¿Quién lo escribe? | Cómo se llega |
|---|---|---|---|---|
| `pending` | Pendiente | No | Sistema | Registro sin aprobar. |
| `approved` | Aprobado | Sí (si `is_available`) | **Admin** | Cumplió requisitos + membresía pagada + tarifa vigente + aprobación del admin. **Estado sano base.** |
| `rejected` | Rechazado | No | **Admin** | Rechazo en el registro (doble reembolso + facturas anuladas). |
| `overdue` *(NUEVO)* | En mora | **Sí** (hasta el tope) | **Motor de deuda** (nunca a mano) | Se retrasó en el pago; acumula deuda dentro del tope (2 semanas). |
| `penalized` *(NUEVO)* | Penalizado | No | **Motor de deuda** (nunca a mano) | Superó el tope de deuda. Debe saldar para reactivarse. |
| `paused` *(NUEVO)* | Pausado | No | **Admin** | Licencia (vacaciones / médica). Exige **deuda 0**. **Congela la tarifa.** |
| `suspended` | Suspendido | No | **Admin** | Suspensión mayor / expulsión de la empresa. |

**Notas clave:**
- **`approved` NO es interno ni transitorio**: es el estado sano en reposo. "Aprobado" =
  el admin certificó que el chofer cumplió los requisitos de ingreso y tiene sus pagos.
  Es un badge visible como cualquier otro.
- **`approved` ≠ `inactive`**: son ejes distintos y no se mezclan. `approved` es un hecho
  administrativo; `inactive` es una decisión voluntaria del chofer (ver abajo).
- **`overdue` y `penalized` nunca se escriben a mano.** Los deriva el motor de deuda a partir
  de la tarifa. El admin no cambia el estado: cambia la **deuda** (registrando el pago), y el
  estado cae por gravedad (ver [Override por pago externo](#override-por-pago-externo)).

### `is_available` (boolean, ya existe) — la disponibilidad

Plano **ortogonal** a `driver_status`. Lo maneja el **chofer desde su app** (pendiente de
construir). Solo tiene sentido cuando el chofer **opera** (`approved` u `overdue`).

| Valor | En pantalla | Significado |
|---|---|---|
| `true` | Activo | Quiere recibir viajes. **Valor por defecto** al aprobar. |
| `false` | Inactivo | No quiere recibir viajes ahora. **Voluntario.** |

- **`inactive` NO congela la tarifa**: la deuda **sigue creciendo** aunque el chofer esté
  inactivo. Es una decisión voluntaria; un chofer inactivo que no paga cae en `overdue` →
  `penalized` igual. El único camino para no acumular deuda es pedir `paused` (licencia).
- Un chofer puede ponerse `inactive` **aunque tenga deuda** (recuerda: se puede deber hasta
  2 semanas y seguir operando). `inactive` solo evita recibir viajes.

## Reglas de negocio fijadas

1. **Aprobar** deja al chofer en `approved` con `is_available = true` (Activo por defecto).
   Exige, como hoy, membresía + tarifa pagadas.
2. **`paused` (licencia)** — la coloca el **admin**, por acuerdo con el chofer:
   - Solo si el chofer tiene **deuda 0** (si debe, primero salda).
   - Es **infinita**: el admin decide cuándo levantarla (acuerdo directo admin–chofer).
   - **Congela la tarifa** mientras dura (no acumula deuda).
   - Al **levantarla**, el chofer vuelve a `approved` + `active`, y el reloj de la tarifa
     **se reancla al lunes 00:00 siguiente**.
3. **`inactive`** es voluntario del chofer, **no** congela la tarifa (la deuda sigue).
4. **`overdue` / `penalized`** los dispara el motor de deuda automáticamente según los topes
   configurables de la propuesta de tarifa-penalización. El admin no los escribe.
5. **Override por acuerdo externo** = **registrar un pago externo** (ver abajo).
6. **`suspended`** se reserva para la expulsión (criterio del admin). Reactivación manual → `approved`.

## Visualización (dos indicadores independientes)

El panel muestra **dos capas separadas**, no una derivación que las colapse:

- **Badge de `driver_status`**: `Pendiente` · `Aprobado` · `Rechazado` · `En mora` ·
  `Penalizado` · `Pausado` · `Suspendido`.
- **Indicador de `is_available`**: `Activo` / `Inactivo` — se muestra **solo** cuando el
  chofer opera (`approved` u `overdue`); en el resto de estados no aplica.

Ejemplos de lectura combinada: **"Aprobado · Activo"**, **"En mora · Inactivo"**,
**"Pausado"** (sin indicador de disponibilidad), **"Suspendido"** (sin indicador).

## Transiciones

```
registro:
  pending ──aprobar (exige pagos)──▶ approved (is_available = true)
  pending ──rechazar──▶ rejected            (doble reembolso + facturas anuladas)

operación (chofer approved):
  approved ──se atrasa (motor)──▶ overdue ──paga / pago externo──▶ approved
  overdue  ──supera el tope (motor)──▶ penalized ──paga / pago externo──▶ approved
  approved ──admin pausa (deuda 0)──▶ paused ──admin levanta──▶ approved + active
                                                                 (reancla al lunes 00:00)
  approved ──expulsión (admin)──▶ suspended ──reactivación manual (admin)──▶ approved

disponibilidad (plano paralelo, boolean is_available, default true):
  active ⇄ inactive     (el chofer, desde su app; NO toca la tarifa)
```

`overdue` y `penalized` los dispara **automáticamente** el motor de deuda/penalización (el
`subscription-scheduler`), según los topes configurables definidos en la propuesta de
[tarifa con deuda y penalización](../tarifa-penalizacion/README.md). Por eso el plano de
deuda es el **mismo esfuerzo (diseño v8)** que esa propuesta.

## Override por pago externo

Cuando el admin y el chofer llegan a un **acuerdo externo** (el chofer paga la deuda directo
al admin, fuera del sistema), el modelo **no** ofrece un botón de "forzar estado". En su
lugar, el admin **registra el pago externo**:

- Se reutiliza el flujo de cobro que **ya existe** (`enroll` / `renew` → `subscription_payments`
  + `invoices` + recibo). El pago externo **emite su comprobante** como cualquier cobro
  (regla de oro #7: el dinero se registra con rastro, no se inventa un estado).
- Al saldar, la deuda queda en **0 de verdad**, y el motor **deja de marcar** `overdue`/
  `penalized` porque ya no hay deuda. **Una sola fuente de verdad** (la deuda), sin overrides
  que el scheduler pise en el siguiente tick.
- **Decisión**: el acuerdo externo se modela como **pago externo** (entra dinero, emite
  recibo), **no** como condonación sin dinero. Debe quedar constancia del motivo (auditoría).

*(Detalle a resolver con el motor: si el pago externo de un `penalized` incluye o no la
semana de penalización/multa. Vive en el motor de deuda, no bloquea la Fase A.)*

## Plan de fases

### Fase A — ✅ implementada (2026-07-23, migración `1752250000000`)

- **BD**: enum `driver_status` + **`paused`**; `is_available` default `true` (+ backfill de
  `approved`); columna **`paused_at`**. Modelos regenerados, `schema.md` actualizado.
- **Backend**:
  - Aprobar deja al chofer en `approved` con `is_available = true`.
  - Endpoints `POST /drivers/:id/pause` (exige `approved` + tarifa `active` al día) y `/resume`.
  - Congelamiento de la tarifa: el `subscription-scheduler` salta a los `paused`; `resume`
    desplaza las ventanas de período no consumidas por el lapso de la pausa (**ventana móvil**;
    el reanclaje "al lunes 00:00" se difiere a Fase B).
  - Auditoría `driver.paused` / `driver.resumed`.
- **Frontend**:
  - Badge **"Pausado"** (azul) en lista, franja del perfil y filtros.
  - Indicador `Activo`/`Inactivo` (a partir de `is_available`) en la tarjeta de estado.
  - Acciones en el perfil: **pausar (licencia)** / **reanudar**.
- **Cabos cerrados** (revisión de completitud, verificados E2E):
  - **Capacitaciones**: un `paused` **puede inscribirse** (sigue siendo miembro, en licencia
    temporal); antes solo `approved`.
  - **Dashboard**: cuenta los `paused` con indicador propio **"En pausa"** (no se agrupan con
    los suspendidos).
  - **Robustez**: salir de `paused` por el `PATCH /drivers/:id` genérico (p. ej. `paused →
    suspended`) **limpia `paused_at`** — sin ancla huérfana.

### Fase B — bloqueada por el motor de deuda

- **BD**: ampliar el enum con **`overdue`** y **`penalized`**.
- **Backend**: motor de deuda (`subscription-scheduler`) que dispara `approved → overdue →
  penalized` según los topes; override por **pago externo**; reanclaje al lunes.
- **Frontend**: badges `En mora` / `Penalizado`; acción de registrar pago externo.
- **Depende de**: cerrar e implementar la propuesta de
  [tarifa con deuda y penalización](../tarifa-penalizacion/README.md) (mismo esfuerzo, diseño v8).

## Impacto de implementación (checklist para el diseño v8)

- **Base de datos**: `ALTER TYPE driver_status ADD VALUE` incremental (`paused` en Fase A;
  `overdue`, `penalized` en Fase B) → **migración nueva** → `npm run migrate` → `npm run
  typecheck` → **actualizar `docs/database/schema.md`** y `database-design-v7.md` en el mismo
  cambio. **Sin backfill de datos**: `approved` sigue siendo `approved` (no se renombra).
- **Backend**: ver Fase A / Fase B arriba.
- **Frontend**: badges + indicador de disponibilidad + acciones de pausa (A) y pago externo (B).

## Preguntas resueltas (antes abiertas)

1. **¿Enum unificado o derivado?** → **Un enum `driver_status` + el boolean `is_available`**
   existente. La deuda se deriva; la disponibilidad es ortogonal.
2. **`paused` (licencia)** → administrativa (la pone el admin), exige deuda 0, infinita,
   congela la tarifa, reancla al lunes al levantarla.
3. **Beneficios por estado** → pendiente de detallar con el motor de deuda (Fase B); `approved`
   = todos; `penalized`/`suspended` = ninguno; `paused` a confirmar.
4. **Override admin de `overdue`/`penalized`** → vía **pago externo** (no condonación),
   con constancia. La deuda queda en 0 y el motor no re-marca.
5. **`active`/`inactive`** → boolean `is_available` existente, lo maneja el chofer desde su
   app, default `active`, no congela la tarifa.

## Fuente

Pedido de Luis, 2026-07-23. Cerrado tras discusión de diseño (mismo día): clasificación por
origen de escritura (administrativo / deuda / disponibilidad), `approved` como estado sano
visible, `paused` como licencia administrativa que congela la tarifa, `active`/`inactive`
como toggle voluntario del chofer, y override por pago externo.
