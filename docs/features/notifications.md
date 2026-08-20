# Sistema de avisos al afiliado

> Estado al **2026-08-20**: Fases 1, 1b, 2 y 3 **implementadas y desplegadas**. Falta la
> **Fase 4 (Firebase)**. El sistema **funciona entero sin push**: los avisos se escriben, se
> listan en la bandeja de la app y la campana los cuenta. Lo único que no ocurre todavía es que
> el teléfono suene.
>
> Decisiones con su porqué: [decisions-log.md](../decisions/decisions-log.md) (entradas del
> 2026-08-19 y 2026-08-20) · Tablas: [schema.md §Dominio 9](../database/schema.md) ·
> Endpoints: [endpoints.md](../api/endpoints.md).

## Por qué existe

El motor de deuda decide solo: emite el cobro el viernes, marca la mora el lunes y penaliza al
superar el tope. El afiliado **no se enteraba de nada**. Los cinco bugs corregidos el 19 y el 20
de agosto compartían el mismo hilo — el pago rechazado que no se veía, el inicio programado que
nadie le decía, la mora que le caía encima sin aviso. Cada arreglo hizo que la app diga la verdad
**cuando el chofer la abre**. Esto es lo que hace que se entere **cuando ocurre**.

## Alcance de la v1 (cerrado)

**Solo avisos automáticos** de dinero y aprobación: 15 casos, enumerados en el enum
`notification_type`. **Sin panel de campañas manuales** (`push_campaigns` está pospuesta a
propósito). Añadir un caso cuesta una migración, y ese roce es deseado.

## Cómo funciona

```
  HECHO (transacción)                    BUZÓN                      ENTREGA
┌─────────────────────┐         ┌──────────────────────┐    ┌────────────────────┐
│ approve/reject pago │         │                      │    │ notification-      │
│ revisión documento  │──notify─▶  notifications        │───▶│ dispatcher (60 s)  │──▶ push
│ revisión vehículo   │  (mismo │  · es la BANDEJA     │    │ · NODE_ENV=prod    │
│ solicitud           │  cliente│  · es el BUZÓN       │    │ · notifications_   │
│ motor de deuda      │   de tx)│  · deliver_after     │    │   enabled          │
└─────────────────────┘         └──────────────────────┘    └────────────────────┘
                                           │
                                           │ GET /me/notifications
                                           ▼
                                   bandeja en la app  +  campana en el header
```

**Una sola tabla hace de bandeja y de buzón de salida.** `notifications` *es* la fila que la app
lista y *es* la fila que el despachador tiene que enviar. Dos tablas solo podrían contradecirse.

**El aviso se escribe dentro de la transacción del hecho que anuncia.** Si el pago se revierte,
el aviso se va con él. Por eso `writeNotification`/`notify` reciben el **cliente de la
transacción**, no el pool — esa es la diferencia real con `writeAudit`, que escribe *después*
porque una operación fallida no debe dejar bitácora.

**Nunca se llama al proveedor dentro de una transacción de dinero.** Colgaría el tick del motor
tras una llamada de red (ya pasó algo así con la multa) y un push antes del COMMIT avisa de algo
que puede no ocurrir.

### `deliver_after`: separar el AVISO del HECHO sin perder la atomicidad

El motor marca la mora a las 00:05 y, **en esa misma transacción**, programa el mensaje para las
~7:00 am. Una mala noticia a las doce y cinco de la noche despierta a alguien por algo que no
puede resolver hasta que abra la oficina. La alternativa —un segundo proceso que relea los hechos
para avisar— rompe justo la propiedad que da valor al buzón.

Lo mismo sostiene el **recordatorio**: al emitir el cobro del viernes se programa un único aviso
para el domingo por la tarde (uno, no uno diario). **Aprobar el pago lo borra**: recordarle que
pague lo que acaba de pagar es el ruido que hace que la gente silencie los avisos de una app —
y con ellos, los que sí importan. Un recordatorio **ya enviado** no se borra: sería reescribirle
el historial.

### Reclamo de la cola, sin estado `sending`

El despachador toma el lote con `SELECT … FOR UPDATE SKIP LOCKED` dentro de **una** transacción.
Un estado `sending` es justo lo que dejaría filas encalladas para siempre la primera vez que el
proceso muera a media entrega; así un caído hace ROLLBACK a `pending` y el siguiente pase las
recoge. **Entrega al menos una vez**, que para un aviso es el lado correcto del error.

`skipped` **no es un fallo**: significa que no había a dónde enviar (sin token vivo) o que todos
los tokens estaban muertos. La bandeja ya tiene el aviso, y para los choferes cuyo teléfono nunca
podrá recibir push (Huawei sin Play Services desde 2019, permiso denegado en Android 13+) ese es
el único canal que existe. Por eso **la bandeja no es opcional**.

## Los dos candados contra el push accidental

⚠️ **Producción y desarrollo comparten la misma base de datos.**

| Candado | Qué impide |
|---|---|
| El plugin **no programa el timer** fuera de `NODE_ENV=production` | Un backend local sencillamente **no tiene despachador**, ni con la bandera encendida. Sin esto, probar un rechazo de pago en tu máquina manda el monto a un chofer real, y dos backends corriendo mandan el push dos veces |
| `app_settings.notifications_enabled` (apagado por defecto), leído en cada tick | El interruptor de negocio, igual que `debt_engine_enabled`. Se apaga y se enciende sin redesplegar |

El interruptor lo lee **el plugin**, no la función de despacho. Así la suite prueba la entrega sin
tocar la fila global que lee el backend desplegado: una prueba que necesita encender el
interruptor de verdad es una prueba que puede dejar mandando push reales si una aserción muere
antes de restaurarlo (ya pasó el 18/08 con el motor de deuda).

⚠️ **Riesgo que los candados NO cubren**: un aviso escrito desde tu backend local queda en la BD
compartida y **producción lo despacharía**. Mientras `notifications_enabled` esté apagado no pasa
nada; encenderlo exige tener claro que ya no se prueba a ciegas contra prod.

## Los 15 avisos y de dónde salen

| Aviso | Lo emite | Cuándo |
|---|---|---|
| `charge_issued` | `debt-scheduler` | Se emite la semana (viernes) |
| `charge_reminder` | `debt-scheduler` | Programado para el domingo 4pm; se **borra** si paga antes |
| `debt_overdue` | `debt-scheduler` | El chofer pasa a `overdue`. Entrega a las 7am |
| `penalty_applied` | `debt-scheduler` | El chofer pasa a `penalized`. Entrega a las 7am. La multa es **opcional** en el texto (se puede cruzar el tope con una multa anterior sin pagar, y no se multa dos veces) |
| `driver_reactivated` | `debt-scheduler` | `penalized` → `approved` **únicamente**. Un moroso que pagó nunca estuvo fuera de la calle |
| `tariff_starting` | `drivers.service.startTariff` | El admin establece el inicio |
| `payment_received` | `payment-submissions.repository.create` | **Solo** si el pago lo reporta él desde la app: por panel tiene al empleado delante |
| `payment_approved` | `payment-submissions.repository.approve` | Dentro de la transacción del dinero |
| `payment_rejected` | `payment-submissions.repository.reject` | **Con el motivo**. Es el aviso que justifica todo el sistema |
| `application_approved` / `application_rejected` | `applications.service` | Veredicto de la solicitud. El rechazo **no lleva motivo**: hoy no se pide ninguno y inventarlo sería poner palabras en boca del admin |
| `document_approved` / `document_rejected` | `documents.service.review` | Nombra **cuál** documento: un afiliado puede tener varios rechazados |
| `vehicle_approved` / `vehicle_rejected` | `drivers.service.reviewVehicle` | Nombra la placa |

### Dónde NO es atómico, y por qué

- **El motor de deuda** escribe sus avisos sobre el pool, después de cada paso — igual que ya
  hace con su bitácora. El tick es una secuencia de sentencias independientes ya confirmadas;
  envolver el motor entero en una transacción para ganar atomicidad de un mensaje mantendría
  bloqueadas filas de dinero durante todo el pase.
- **`startTariff`** avisa después de `enrollment.approve`, releyendo la fecha. Pasarle un cliente
  a esa función amplía el radio de impacto sobre código de dinero a cambio de poco: nada de esto
  es reversible de forma que deje el aviso huérfano, y el afiliado ya ve la fecha en su Inicio.

## La redacción vive en un solo sitio

`src/modules/notifications/notification-messages.ts`. **Los servicios dicen QUÉ pasó; el catálogo
decide cómo se lee.** Sin la separación, el mismo hecho se redacta de tres formas en tres módulos
y nadie puede revisar de un vistazo el tono que recibe el afiliado.

`MessageInput` es una **unión discriminada**: no se puede añadir un caso sin su redacción, y el
compilador caza un aviso al que le falte un dato.

**El texto se guarda ya redactado en la fila.** El teléfono nunca compone: si lo hiciera, la
bandeja y el push empezarían a decir cosas distintas y corregir una palabra exigiría publicar un
APK. Del `type` la app solo deriva **el icono y su color**.

## La bandeja (app)

- **Lista solo los avisos cuyo `deliver_after` ya pasó.** No es un detalle de entrega colándose en
  la lectura: es lo que la bandeja SIGNIFICA. Un recordatorio programado para el domingo no ha
  ocurrido, y mostrarlo hoy le enseña un aviso sobre una semana que no ha empezado.
- **Paginación por keyset** (`before=<id>`), no OFFSET: llegan avisos mientras hace scroll y el
  OFFSET le movería la ventana debajo, repitiendo o saltándose filas. Se pide una fila de más y
  eso responde «¿hay más?» sin un `count(*)` sobre una tabla que solo crece.
- **Marcar leído es idempotente y no mueve `read_at` la segunda vez**: cuándo lo leyó es un hecho,
  no la última vez que lo abrió.
- El filtro por usuario va **dentro del WHERE**: un id ajeno no coincide, responde igual y no
  revela si el aviso existe.
- **Abrir un aviso lo marca**, primero en local y luego contra el servidor. Leer no es algo que el
  chofer deba HACER: un botón «marcar como leído» es un toque extra para contarle a la app lo que
  acaba de ver, y hacerle esperar el viaje de red es la app dudando de él.

## La campana (app)

Va en el **header**, no en la isla flotante (decisión de Luis, tras evaluar ambas): la isla navega
entre lugares donde uno *está*, mientras que los avisos se consultan y se cierran — y la isla
gasta uno de los ~3 cupos cómodos que hacen falta para Viajes. Ventaja concreta del header: ahí el
**dorado está libre** (en la isla ya significa «pestaña activa»), así que el indicador se lee sin
ambigüedad.

**El contador viaja dentro de `/driver-auth/me/account`**, que la app ya pide en cada pantalla —
nunca en una llamada aparte: un dato de segunda llamada que falla sin señal deja la campana
mintiendo mientras el resto de la pantalla está fresco (fue exactamente el bug del «vehículo en
uso»).

**El dueño del contador es el shell** (`driver_shell.dart`), como el chofer y el interruptor de
disponibilidad: las dos pestañas pintan un header desde ahí, y dos cargas independientes mostraban
dos campanas distintas. El shell también pasó a ser dueño del **estado de cuenta** completo — el
Inicio pedía su propio `GET /me/account` y eran dos llamadas al arrancar leyendo copias distintas
del mismo dato. La pantalla de avisos **devuelve el contador al cerrarse**: refrescar la cuenta al
volver sería otra ida al servidor por un número que ya conocía.

## Archivos

**Backend**

| Archivo | Responsabilidad |
|---|---|
| `src/db/migrations/1752450000000_notifications-outbox.cjs` | Tablas, enums e interruptor |
| `src/modules/notifications/notification-writer.ts` | Única puerta de escritura (`notify`, `notifyMany`) |
| `src/modules/notifications/notification-messages.ts` | La redacción de los 15 casos |
| `src/modules/notifications/notifications.repository.ts` | Lectura de la bandeja y el contador |
| `src/modules/notifications/notifications.routes.ts` | `/driver-auth/me/notifications` |
| `src/plugins/notification-dispatcher.ts` | Despachador (quinto scheduler) |
| `src/notifications/push-sender.ts` | Interfaz `PushSender` + `LogPushSender` |

**App**

| Archivo | Responsabilidad |
|---|---|
| `lib/domain/entities/notification_item.dart` | `NotificationItem` · `NotificationPage` |
| `lib/domain/repositories/notifications_repository.dart` | Contrato |
| `lib/data/repositories/notifications_repository_impl.dart` | Implementación |
| `lib/features/notifications/presentation/screens/notifications_screen.dart` | La bandeja |
| `lib/features/notifications/presentation/widgets/notification_tile.dart` | La fila (icono/color por tipo) |
| `lib/shared/widgets/driver_header.dart` | La campana con su contador |
| `lib/features/home/presentation/screens/driver_shell.dart` | Dueño del contador y del estado de cuenta |

## Pruebas

| Suite | Qué cubre |
|---|---|
| `tests/notification-outbox.test.ts` (9) | El buzón: una transacción que revierte no deja aviso · sin teléfono → `skipped` · retención por `deliver_after` · reintentos y abandono al tercero · token muerto revocado · el token es único global |
| `tests/notification-events.test.ts` (6) | Dónde nacen: rechazo con motivo · un veredicto que no ocurre no deja aviso · aprobar borra el recordatorio futuro pero **no** el ya enviado · documento y vehículo nombrados |
| `tests/notification-inbox.test.ts` (7) | La bandeja: orden y contador · el aviso diferido no se lista ni cuenta · marcar es idempotente · `read-all` respeta lo diferido · **un chofer no ve ni marca los avisos de otro** · paginación sin repetir · el contador viaja en `/me/account` |

Backend **55/55**. App **58/58** + `flutter analyze` limpio.

## Fase 4 — lo que falta (Firebase)

Todo lo anterior funciona sin esto. Firebase es la parte que da guerra (cuenta,
`google-services.json`, Gradle, APK nuevo) y por eso se dejó al final.

1. **Cuenta y proyecto Firebase**; `google-services.json` en la app (es identificador público y
   **sí se versiona**). La clave de servidor va **solo** en `edv-route-backend/.env` (regla 3).
2. **`FcmPushSender`** implementando `PushSender`. Es la única pieza que cambia: el despachador,
   el buzón y la bandeja no se tocan. Mandar **mensajes de notificación** (los pinta el sistema),
   **no** mensajes de datos: sobreviven mucho mejor a Xiaomi/Oppo/Vivo y funcionan con la app
   cerrada.
3. **Endpoints de `device_tokens`**: registrar al abrir y al rotar, **revocar al cerrar sesión**.
   ⚠️ Si no se revoca, el siguiente que use ese teléfono recibe los montos y los motivos de
   rechazo del anterior. El `UNIQUE` global del token tapa el otro lado (reapunta la fila cuando
   otro chofer inicia sesión en el mismo aparato), pero **hay que cerrar las dos puertas**.
4. **Permiso de notificaciones en Android 13+** (se puede negar; la bandeja sigue siendo el canal).
5. **Encender `notifications_enabled`** — y solo entonces empiezan a salir push reales.

**Coste**: FCM es gratis. iOS pediría los $99/año de Apple; hoy solo hay APK Android, no aplica.
