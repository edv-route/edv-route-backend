# Ubicación de los afiliados — propuesta

> Estado: **Fases 1, 2 y 3 HECHAS** · Falta la 4 (el panel) y probarlo en un teléfono · Fecha: 2026-08-24 · Pedido por Luis
>
> Orden de trabajo pedido: **primero la app y el backend**; el panel del admin se aborda después,
> cuando todo esto esté funcionando.

## Qué se quiere

Saber **dónde ha estado cada afiliado mientras trabaja**. La app manda su coordenada cada 10
minutos, el servidor la guarda con su momento, y el historial se conserva un número configurable
de días (30 por defecto).

Solo reporta quien **está trabajando**: aprobado, con la tarifa arrancada y con su interruptor de
disponibilidad en activo. Quien se pone inactivo deja de reportar en el acto.

## 0 · Para qué es el dato, y por qué manda el ritmo

**Es una app de carreras y habrá un mapa** (confirmado por Luis, 2026-08-24). Eso convierte la
ubicación en dos cosas distintas con necesidades opuestas:

| Uso | Ritmo que necesita |
|---|---|
| **Historial**: por dónde anduvo, auditar, resolver disputas | 10 minutos sobra |
| **Asignar una carrera al más cercano** | 30–60 segundos |

**Un coche a 40 km/h recorre casi 7 km en 10 minutos.** Asignar por un punto de hace nueve minutos
puede mandar al chofer que ya cruzó la ciudad y dejar fuera al que estaba a dos cuadras.

**La salida es que el ritmo lo decida el servidor**, no un número compilado en el APK:

- **En reposo** (activo, esperando trabajo): 10 minutos. Es el estado normal y el que gasta batería
  todo el día.
- **Buscando carrera o en viaje**: 30–60 s, solo mientras dura.

El backend **no se entera de la diferencia**: recibe puntos igual. Quién dispara el envío y cada
cuánto es cosa de la app, y el número vive en `app_settings` — mismo patrón que el motor de cobro y
los avisos. El día que se encienda Viajes se sube la frecuencia desde el panel y **todos los
teléfonos obedecen sin publicar un APK**.

## Decisiones ya tomadas (Luis, 2026-08-24)

| Punto | Decisión | Lo que implica |
|---|---|---|
| **Cada cuánto** | **10 minutos, configurable desde el servidor** | Rebajado desde 60 s. Divide entre diez el volumen y el gasto de batería. Configurable porque **para asignar carreras 10 min no sirve** (ver §0) |
| **Con la app cerrada** | **Sí** | Hace falta un **servicio en primer plano** con notificación permanente |
| **Sin señal** | **Guardar y reenviar** | Cola local en el teléfono; el servidor acepta puntos con fecha pasada |
| **Chofer parado** | **Guardar todo igual** | Sin filtro por distancia. A 10 minutos el ahorro no compensa la complejidad |
| **Sesión** | **Alargar el token actual** | Una variable de entorno. ⚠️ Ver la advertencia más abajo |

## Los números, con la frecuencia acordada

Un punto cada 10 minutos = 144 al día por chofer.

| Flota | Filas en 30 días | Peso aproximado |
|---|---|---|
| 10 choferes (hoy) | 43.200 | ~6 MB |
| 50 choferes | 216.000 | ~28 MB |
| 100 choferes | 432.000 | ~55 MB |

La base ocupa hoy **21 MB** de los 500 MB del plan gratuito de Supabase. Con la frecuencia de 60 s
que se planteó al principio, cien choferes se habrían comido la base entera; a 10 minutos el
sistema aguanta el crecimiento previsible sin cambiar de plan.

**Aun así, el borrado de los días viejos es parte del diseño desde el primer día**, no un añadido:
una tabla que solo crece es una bomba de relojería en una base de 500 MB.

---

## 1 · La base de datos

### `driver_locations` — el historial

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | bigint | PK |
| `driver_id` | uuid | FK → `drivers.user_id`, CASCADE |
| `point` | `geography(Point, 4326)` | La coordenada. PostGIS 3.3.7 ya está instalado |
| `accuracy_m` | real | Precisión que reportó el teléfono. Un punto con 2 km de error no es un punto |
| `recorded_at` | timestamptz | **Cuándo lo tomó el teléfono** |
| `created_at` | timestamptz | **Cuándo llegó al servidor** |

**Dos fechas, no una.** Con la cola local, un punto puede llegar horas después de tomarse. El
recorrido se dibuja con `recorded_at`; la diferencia entre ambas cuenta cuánto tiempo estuvo sin
señal, que es información operativa real.

**Índice** por `(driver_id, recorded_at DESC)`: sirve al «enséñame el recorrido de este chofer
entre estas dos horas», que es la única consulta que se va a hacer, y también a la purga.

### `drivers.last_location` + `last_location_at` — la última conocida

Dos columnas en la tabla que ya existe. **No es duplicar el dato**: el mapa en vivo pregunta «dónde
está cada uno ahora», y responder eso desde el historial obliga a buscar el último punto de cada
chofer entre decenas de miles de filas, cada vez que alguien abre el mapa. Aquí es una lectura
directa.

> El diseño v7 ya las contemplaba y **nunca se implementaron** — no existen hoy en la base.

### El ajuste configurable

`app_settings` gana dos claves, igual que el resto de la configuración (nacen en la migración, el
panel solo edita su valor):

| Clave | Por defecto | Para qué |
|---|---|---|
| `location_retention_days` | 30 | Cuántos días de historial se conservan |
| `location_interval_seconds` | 600 | Cada cuánto reporta la app **en reposo**. Se sube el día que llegue Viajes, sin publicar APK |

La app pregunta el intervalo al arrancar y obedece. Un valor que no llega (sin señal al abrir) cae
en el último conocido, y si no hay ninguno, en 600.

---

## 2 · El backend

### Recibir el punto

`POST /driver-auth/me/locations`, con el token del chofer. Acepta **un lote de puntos**, no uno
solo: la cola local acumula mientras no hay señal, y mandarlos de uno en uno serían veinte
peticiones seguidas al recuperar cobertura.

**Quién puede reportar** — la misma pregunta que ya responde el resto del sistema:

- `status = 'approved'` **y** `tariff_start_set_at IS NOT NULL` (está operando de verdad)
- `is_available = true` (él decidió estar disponible)

Un `overdue` **sí** reporta: debe semanas pero sigue trabajando, igual que sigue pudiendo operar.
Un `penalized`, `paused`, `suspended` o `applicant`, **no**.

Si no cumple, la respuesta lo dice explícitamente para que la app **apague el servicio** en vez de
seguir intentándolo cada 10 minutos contra una puerta cerrada.

**Puntos con fecha pasada**: se aceptan hasta un tope (24 h). Sin tope, cualquiera con el token
podría inventarse un recorrido de la semana pasada.

### Borrar lo viejo

Un **scheduler diario**, como los cinco que ya existen (`document-scheduler`,
`applicant-cleanup-scheduler`…): borra lo anterior a `location_retention_days`. Lee el ajuste en
cada pasada, así cambiar el número en el panel surte efecto sin redesplegar.

⚠️ **Prod y dev comparten base**: el borrado tiene que respetar el mismo candado que el despachador
de avisos — que un backend local no borre el historial de producción.

---

## 3 · La app

Es la parte más difícil, y no por el código: por Android.

### El servicio en primer plano

Android mata las apps en segundo plano a los pocos minutos. Para seguir reportando con la app
cerrada hace falta un **servicio en primer plano**: una notificación permanente en la barra que
diga algo como *«EDV Route · compartiendo tu ubicación»*. Es lo que hacen Uber y DiDi.

Que sea visible **no es un mal necesario, es lo correcto**: el chofer tiene derecho a saber, en
todo momento y de un vistazo, que se le está localizando.

**Paquetes**: `geolocator` + `flutter_foreground_task`. Ambos libres y maduros.

⚠️ **`flutter_background_geolocation` queda descartado**: es el que más se recomienda por ahí, pero
su SDK nativo es propietario y **cuesta 500 USD por app** para compilar en release. Funciona en
depuración sin licencia, que es justo la trampa — se descubre al generar el APK final.

### Permisos

Android 10+ separa «ubicación mientras usas la app» de **«ubicación todo el tiempo»**, y la segunda
hay que pedirla en una segunda pantalla que el usuario debe conceder a mano en los ajustes del
sistema. Es el punto donde más gente se cae del flujo, así que necesita una pantalla propia que
explique **para qué** antes de pedirlo.

No se distribuye por Play Store (es un APK directo), así que no hay revisión de políticas que pasar
— pero la obligación de explicarlo al chofer es la misma.

### La cola local

Los puntos se guardan en el teléfono y se mandan cuando hay conexión. Al enviarse con éxito, se
borran. Con un tope de tamaño: si un chofer pasa tres días sin señal, no tiene sentido guardar 432
puntos ni mandarlos todos de golpe.

### Cuándo arranca y cuándo para

- **Arranca** al ponerse activo, y al abrir la app si ya estaba activo.
- **Para** al ponerse inactivo, al cerrar sesión, y cuando el servidor responde que ya no puede
  reportar (lo suspendieron, lo penalizaron, o le quitaron la tarifa).

Ese último caso es el que evita que un chofer suspendido siga siendo rastreado.

---

## 4 · La sesión que no caduca

Hoy la app **ya guarda la sesión** y la reanuda al abrir. Lo que se rompe es que **el token dura 8
horas**: cerrar la app y volver al día siguiente te deja fuera. Sin arreglar esto, **el rastreo se
apaga solo cada noche**.

**Decisión de Luis**: alargar la caducidad del token actual (`JWT_EXPIRES_IN`), que es una variable
de entorno.

### ⚠️ Advertencia, y el complemento que la hace segura

Un token de un año **no se puede revocar**. Y ese token abre la deuda del chofer, sus pagos y ahora
su ubicación en tiempo real: un teléfono robado o prestado sigue reportando dónde está esa persona
durante meses.

**El complemento propuesto**: que **`authenticateDriver` compruebe el estado del chofer**, que hoy
solo mira la firma (pendiente conocido desde el 2026-08-21, `src/plugins/auth.ts`). Con esa
comprobación, suspender a alguien desde el panel lo deja fuera **al instante**, aunque su token siga
vivo un año. Es la revocación que al token largo le falta.

Cuesta una consulta por petición, que es justo lo que se evitó al no cerrar sesiones en la
recuperación de clave — pero aquí ya no es opcional: **es la única forma de cortarle el acceso a
alguien**. Y de paso tacha ese pendiente, que ya hacía falta para cuando llegue Viajes.

---

## 4b · Lo que el mapa va a necesitar (y hoy no está)

Anotado ahora aunque el panel se aborde después, porque **condiciona lo que se guarda desde el
primer punto** — y un dato que no se guardó no se recupera.

- **Un punto impreciso no se descarta, se marca.** El teléfono reporta su margen de error: dentro
  de un edificio o con el GPS frío puede ser de 500 m o más. Para el historial vale igual —dice por
  qué zona anduvo—, pero **el mapa en vivo y la asignación de carreras tienen que poder ignorarlo**,
  o acabarás mandando a alguien a una dirección que el teléfono se inventó. Por eso `accuracy_m` se
  guarda siempre y el filtro se aplica al leer, no al escribir.
- **Cuánto hace que no reporta.** El mapa tiene que distinguir «está aquí» de «aquí estaba hace tres
  horas». Sin eso, un chofer con el teléfono apagado o sin datos aparece disponible y se le asignan
  carreras que nunca va a atender. Se deriva de `last_location_at`: pasado cierto margen (dos o
  tres veces el intervalo configurado), deja de contar como presente.

Ninguna de las dos cuesta nada ahora: una es una columna que ya está en el diseño y la otra es una
resta. Las dos son carísimas de añadir cuando ya hay un mes de historial sin ellas.

## 5 · Orden de trabajo

| Fase | Qué | Dónde | Estado |
|---|---|---|---|
| **1** | Tablas, ajustes, endpoint de recepción y purga diaria | Backend | ✅ **Hecha** (2026-08-24) |
| **2** | Token largo + validación del estado en el guard | Backend | ✅ **Hecha** (2026-08-24) |
| **3** | Permisos, servicio en primer plano, cola local y arranque/parada | App | ✅ **Hecha** (2026-08-24) · sin probar en dispositivo |
| **4** | Verlo: mapa en vivo e historial por chofer | Panel | **Planificada** (2026-08-27) → [`fase-4-mapa.md`](./fase-4-mapa.md) |

Las fases 1 y 2 son independientes de la 3: el backend puede probarse con peticiones sueltas antes
de que la app mande un solo punto.

---

## 6 · Preguntas abiertas (no bloquean el arranque)

1. **¿Qué pasa si un chofer se queda activo toda la noche?** Seguiría reportando desde su casa
   mientras duerme. ¿Se apaga solo a cierta hora, se le recuerda ponerse inactivo, o se deja como
   está y es su responsabilidad?
2. **¿Se le avisa explícitamente la primera vez?** La notificación permanente ya lo hace visible,
   pero un aviso claro al activar el rastreo —del estilo del consentimiento de privacidad que ya
   existe en el registro— sería más honesto y deja rastro de que lo aceptó.
3. **¿Precisión?** Alta consume más batería. A 10 minutos la diferencia es pequeña, pero conviene
   decidir si vale un punto con 500 m de error o se descarta.
4. **¿Cuánto tiempo sin reportar cuenta como «desconectado»?** Hace falta para que el panel
   distinga «está aquí» de «aquí estaba hace tres horas». Es de la fase 4.
