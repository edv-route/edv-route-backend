# Fase 4 — El mapa en el panel · plan de acción

> Continúa [`README.md`](./README.md) (fases 1-3, hechas y verificadas con datos reales el 2026-08-26).
> Estado: **4a, 4b y 4c implementadas** (2026-08-28) · **4d pendiente** · Pedido por Luis
>
> Maqueta de referencia: canvas de diseño con las cuatro pantallas (escritorio y teléfono),
> publicado el 2026-08-27.

## 0. En una línea

Ver en el panel **dónde está ahora cada afiliado que trabaja**, y **por dónde anduvo** un día
concreto. Los datos ya se están guardando desde el 24 de agosto; lo que falta es leerlos.

---

## 1. Punto de partida real (verificado en el código, no supuesto)

| Pieza | Estado |
|---|---|
| Tabla `driver_locations` + índice `(driver_id, recorded_at DESC)` | ✅ Existe |
| `drivers.last_location` + `last_location_at` + índice GIST parcial | ✅ Existen y **se escriben** |
| `POST /api/v1/driver-auth/me/locations` (la app manda puntos) | ✅ Funciona en producción |
| Purga automática (`src/plugins/location-retention.ts`) | ✅ Corre cada hora, solo en producción |
| Ajustes `location_interval_seconds` (600) y `location_retention_days` (30) | ✅ En `app_settings`, editables desde el panel |
| **Cualquier lectura de esos datos** | ❌ **No existe ninguna** |

Esto último es el tamaño real del trabajo. En todo el backend **no hay un solo `SELECT` sobre
`driver_locations`** —la única sentencia que la toca es el `DELETE` de la purga— y **nadie lee
`drivers.last_location`**: la columna se escribe, tiene su índice GIST esperando, y no la consulta
nadie. Los dos endpoints que el mapa necesita hay que escribirlos enteros.

### Tres cosas que salieron al revisar el código y cambian el plan

**⚠️ Los modelos generados tipan el punto como `unknown`.** Kanel no sabe traducir `geography`, así
que `DriverLocations.point` y `Drivers.last_location` salen como `unknown`. La proyección de
lectura **no se puede derivar** con `Camelize` a secas: hay que declararla a mano
(`Omit<Camelize<DriverLocations>, 'point'> & { lat: number; lon: number }`). El idioma para leer ya
está probado en `tests/locations.test.ts`: castear a `::geometry` y usar `ST_Y` para la latitud y
`ST_X` para la longitud. Ojo con el orden, que se invierte: al **escribir** es
`ST_MakePoint(lon, lat)`.

**⚠️ La purga borra el historial pero nunca toca `drivers.last_location`.** Un afiliado que dejó de
trabajar en marzo conservará su última posición para siempre, aunque su historial ya no exista. Si
el mapa lee esa columna sin más, dentro de unos meses mostrará gente donde ya no está. **La consulta
tiene que descartar lo anterior a la ventana de retención**, y conviene decirlo en el código para
que nadie lo quite pensando que sobra.

**⚠️ El panel no tiene ningún refresco periódico hoy.** Ni un `setInterval`, ni un `timer` de RxJS,
ni WebSocket: los únicos temporizadores del proyecto son los cuatro `setTimeout` de 300 ms del
buscador. Esta sección **estrena ese patrón**, así que hay que dejarlo bien: apoyado en
`takeUntilDestroyed()` —como ya hace `main-layout.ts`— o quedarán temporizadores colgando al navegar.

---

## 2. Decisiones que necesito de Luis

Ninguna bloquea el arranque del backend; todas hacen falta antes de terminar el panel.

| # | Pregunta | Lo que propongo | Por qué |
|---|---|---|---|
| **D1** | ¿Cuándo deja alguien de estar «en línea»? | **Derivarlo del intervalo**, no fijarlo: en línea hasta 2 intervalos, con retraso hasta 3, sin señal a partir de ahí. Con los 600 s de hoy son 20 y 30 minutos | Es la pregunta abierta nº 4 de la propuesta. Derivarlo significa que el día que Viajes baje el intervalo a 60 s, el umbral se ajusta solo. Un número fijo se quedaría mintiendo |
| **D2** | ¿Se audita quién consulta la ubicación de quién? | **Sí para el recorrido de una persona; no para el mapa general** | El mapa es una vista de trabajo, auditarla sería ruido. Abrir el recorrido de un afiliado concreto es mirar dónde estuvo una persona un día: eso sí merece rastro, igual que lo tienen los pagos |
| **D3** | ¿Se registra quién exporta un recorrido a CSV? | **Sí** | Es sacar datos personales del sistema. Si D2 se aprueba, esto va con ello |
| **D4** | El afiliado que se queda activo toda la noche | **Dejarlo como está**: el mapa lo hace visible, no lo corrige | Ya era la asunción vigente. El mapa no cambia el problema, solo lo enseña — y verlo unas semanas es la mejor forma de decidir si hace falta apagado automático |
| **D5** | ¿Direcciones de calle en la v1? | **No.** Coordenadas, zona y hora; la dirección llega después (§7, fase 4d) | Ver §4.3: convertir coordenadas en direcciones tiene un límite legal de **1 petición por segundo** en el servicio público. Con 100 afiliados refrescando serían siete veces ese límite. **Esto contradice las maquetas**, que sí muestran direcciones |

---

## 3. La elección técnica

### 3.1 Flowbite Pro sirve para todo menos para el mapa

Los crudos están en `C:\Project\edv\flowbite-admin-dashboard-v2.2.0` (Pro 2.2.0, licencia comprada).
De ahí sale el chasis: `content/homepages/logistics.html` tiene exactamente la maqueta que
necesitamos —tarjeta con selector de rango de fechas arriba, y debajo un `lg:flex lg:space-x-6` con
el mapa a un lado y la tabla al otro—, y `content/pages/datatables.html` la tabla del historial.

**⚠️ El «mapa» que trae Flowbite Pro no es un mapa geográfico.** `src/map.js` usa `svgmap`, que pinta
un coropleta de países para métricas de visitantes. No hay Leaflet, MapLibre ni Google Maps en los
fuentes de Pro. **El mapa lo tiene que poner una librería aparte**; Flowbite pone lo que lo rodea.

### 3.2 La librería: MapLibre GL JS

Lo caro de un mapa no es la librería —todas las serias son gratis— sino **las imágenes del mapa**
(los *tiles*). Ahí es donde está la trampa:

| Proveedor de tiles | Capa gratuita | ¿Uso comercial? |
|---|---|---|
| **CARTO** | 5.000.000 peticiones/mes | ✅ **Sí, explícitamente** — su FAQ dice que ni hace falta avisar |
| Stadia Maps | 200.000/mes | ❌ Prohibido en el plan gratuito ($20/mes el de entrada) |
| MapTiler | 5.000 sesiones/mes | ❌ «personal o no comercial» ($30/mes para comercial) |
| OpenStreetMap oficial | Sin límite publicado | ⚠️ No lo prohíbe, pero su política **advierte expresamente a los servicios comerciales** de que pueden cortar el acceso sin aviso, y no hay ningún compromiso de servicio |
| Google Maps | 10.000 cargas de mapa/mes | ✅ Sí, y con nuestro uso saldría gratis — pero exige tarjeta y ya cambió de precios de golpe en marzo de 2025 |

**CARTO es el único proveedor alojado cuya capa gratuita permite uso comercial de forma
documentada.** Y CARTO está retirando sus tiles de imagen (dice que «está considerando dejar de
actualizarlos», sin fecha) y recomienda los vectoriales. Los vectoriales, además, gastan **una cuarta
parte** de peticiones para cubrir la misma superficie.

Ir a CARTO vectorial obliga a MapLibre, no a Leaflet. Y eso encaja:

| | MapLibre GL JS | Leaflet |
|---|---|---|
| Licencia | BSD-3 | BSD-2 |
| Peso (comprimido) | 257 KB | **42,7 KB** |
| Última versión estable | 6.6.0, activa | **1.9.4, de mayo de 2023** |
| Envoltorio para Angular 22 | `@maplibre/ngx-maplibre-gl` 22.1.0, **oficial de MapLibre**, julio 2026 | `@bluehalo/ngx-leaflet` 22.0.0, junio 2026 |
| Agrupar marcadores | `supercluster` (Mapbox, mantenido) | `leaflet.markercluster`, **sin publicar desde hace ~5 años** |

**Recomiendo MapLibre + CARTO vectorial.** Las razones, por peso:

1. Es la única combinación gratuita que permite uso comercial sin letra pequeña.
2. **La salida de emergencia no cuesta nada.** MapLibre lee PMTiles: el día que CARTO cambie de
   política, se descarga el extracto de Venezuela (120 MB de OpenStreetMap), se sube a un
   almacenamiento barato y **solo cambia una URL**. La librería, el envoltorio y todo el código de
   marcadores siguen igual. No estamos eligiendo un proveedor, estamos eligiendo poder cambiarlo.
3. Leaflet lleva tres años sin versión estable, su 2.0 rompe compatibilidad sin fecha, y el
   complemento de agrupación que todo el mundo usa está congelado desde hace cinco años.

**La contrapartida, sin adornos: MapLibre pesa seis veces más que Leaflet.** En Venezuela, con
conexiones malas y caras, eso importa. Lo que lo hace asumible es que **la sección es de carga
diferida**: solo descarga esos 257 KB quien entra en Ubicación, no todo el que abre el panel. Y
MapLibre necesita WebGL: en una máquina muy vieja o una sesión remota sin aceleración, degrada.

> Si esa contrapartida pesa más de lo que creo, la alternativa defendible es Leaflet con tiles de
> imagen de CARTO: 42,7 KB y funciona en cualquier cosa. Se acepta a cambio cuatro veces más
> peticiones, una capa que CARTO ya ha dicho que puede dejar de actualizar, y una librería congelada.

### 3.3 Cómo se refresca: sondeo, no WebSocket

El flujo va **en un solo sentido** (servidor → panel), así que no hace falta WebSocket. La elección
real es entre preguntar cada X segundos o dejar una conexión abierta (SSE). **Empezar preguntando**,
cada 15 segundos: sin estado en el servidor, sin reconexiones, sin latidos, fácil de depurar, y
sobrevive a cualquier proxy. Encapsulado en un servicio del panel, cambiar a SSE más adelante no
tocaría ni un componente.

Dato que quita presión: **actualizar los marcadores no descarga ni un tile**. Los tiles solo se
piden al abrir el mapa y al mover o hacer zoom; los marcadores viven en otra capa. Un panel abierto
ocho horas con la cámara quieta pide las imágenes **una sola vez**. Con cinco operadores esto no
llega al 2 % de la capa gratuita de CARTO.

---

## 4. El backend: dos endpoints nuevos

Módulo `src/modules/locations/`, que ya existe. Se le añade un segundo grupo de rutas montado bajo
`/locations` con el guard de administrador (`app.authenticate`), sin tocar la ruta del chofer.

### 4.1 `GET /api/v1/locations/live` — el mapa

Devuelve la última posición conocida de **quien está trabajando ahora**: mismo filtro que ya aplica
el endpoint de escritura (`approved` u `overdue`, con la tarifa arrancada y disponible), leyendo
`drivers.last_location` con el índice GIST, sin tocar el historial.

```
{ items: [ { userId, fullName, nationalId, photoUrl, status,
             lat, lon, accuracyM, lastLocationAt, presence } ], total, intervalSeconds }
```

- `presence` (`online` | `delayed` | `offline`) lo calcula el **servidor**, no el navegador: así el
  umbral de D1 vive en un solo sitio y el panel no tiene que replicar la regla.
- `intervalSeconds` viaja en la respuesta, igual que hace el endpoint del chofer: el panel se
  entera del ritmo sin una segunda llamada.
- **Descarta lo anterior a la ventana de retención** (el problema de los fantasmas, §1).
- Parámetros: `maxAccuracyM` (opcional, para el interruptor de la maqueta) y `since` (opcional,
  para devolver solo lo que cambió — con afiliados parados, casi todas las respuestas irán vacías).

### 4.2 `GET /api/v1/locations/drivers/:userId/history` — el recorrido

Parámetros `from` y `to` en ISO **completo con desfase horario**. El backend **no adivina la zona
horaria**: si el panel manda el día, alguien acabará discutiendo si el día empieza en Caracas o en
UTC. Que lo resuelva quien conoce al usuario.

```
{ points: [ { lat, lon, accuracyM, recordedAt, createdAt, delaySeconds } ],
  summary: { count, firstAt, lastAt, maxDelaySeconds } }
```

- `delaySeconds` es `createdAt - recordedAt`: **cuánto tardó ese punto en llegar**. Es lo que
  permite pintar en otro color el tramo que el teléfono guardó sin señal.
- Tope duro de puntos por respuesta (1000) con aviso de truncado. A 10 minutos un día son 144, pero
  el día que Viajes baje el intervalo a 60 s serán 1440.
- Ordenado por `recorded_at` ascendente: es el orden en que se dibuja.

### 4.3 Lo que NO lleva la v1: las direcciones

Las maquetas muestran «Av. Luis Roche, Altamira». Convertir coordenadas en calles requiere un
servicio de geocodificación, y el público de OpenStreetMap tiene un límite de **una petición por
segundo** y prohíbe expresamente no cachear los resultados. Con cien afiliados refrescando cada 15
segundos serían casi siete peticiones por segundo: bloqueo garantizado.

La forma correcta, cuando toque (§7, fase 4d): **en el servidor, solo cuando alguien pincha un
afiliado**, con una tabla de caché en PostGIS indexada por coordenada redondeada a una rejilla de
unos 30 metros. Un afiliado parado en un semáforo genera decenas de puntos que resuelven a la misma
calle: la caché absorbe casi todo. Y a medio plazo, alojar el servicio con el extracto de Venezuela,
que pesa 120 MB frente a los 80 GB del planeta.

### 4.4 Pruebas

`tests/locations.test.ts` ya existe y es el modelo: crea sus propios afiliados con
`makeWorkingDriver` y los borra al terminar, **porque la base de datos se comparte con producción**.
Los casos nuevos van ahí: filtro por estado, umbral de presencia, descarte por retención, rango de
fechas, tope de puntos y que un token de chofer no pueda leer estos endpoints.

⚠️ Al correr la suite, seguir dejando **`debt-engine` fuera**: emite facturas de verdad.

---

## 5. El panel

Una sección nueva `features/locations/`, con su ruta diferida colgando del layout (hereda el guard
de sesión), y una entrada en el menú **debajo de Afiliados**, que es donde la maqueta la pone.

Se reutilizan seis de los nueve componentes compartidos que ya existen: `app-avatar` en la lista,
`app-select` en los filtros, `app-date-picker` en el historial, `app-skeleton-rows` mientras carga,
`app-pagination` en la tabla de puntos y `app-toggle` para el filtro de precisión. **No hace falta
crear ningún componente compartido nuevo.**

El patrón del panel es el mismo de siempre —componente standalone, señales, `HttpClient` imperativo,
un `*.api.ts` por sección— y ya hay precedente de integrar una librería JS de terceros:
`dashboard.ts` monta ApexCharts a mano. El mapa se monta igual.

**Tres cuidados propios de esta sección:**

- **El temporizador** (§1): `takeUntilDestroyed()` y pausarlo cuando la pestaña no está visible. Un
  panel olvidado abierto toda la noche no debe seguir preguntando.
- **No recrear los marcadores en cada refresco.** Mantener un diccionario `userId → marcador` y
  mover los existentes. Recrear cien marcadores cada quince segundos es lo que hace que un panel
  «se sienta lento», no la cantidad.
- **Los dropdowns de Flowbite dan problemas en rutas que se vuelven a dibujar** — es la razón por la
  que el menú lateral móvil no los usa (ver el comentario en `main-layout.ts`). Si el mapa necesita
  un desplegable, que sea `app-select` o una señal de Angular, no `data-dropdown-toggle`.

El interceptor solo añade el token a las URLs de nuestra API, así que las peticiones de tiles a
CARTO **no llevarán la sesión** — que es exactamente lo correcto, pero conviene saberlo.

---

## 6. Casos contemplados

Lo que el mapa tiene que aguantar sin mentir. Los marcados **D** dependen de una decisión de §2.

### Del dato

| Caso | Tratamiento |
|---|---|
| Afiliado sin ninguna posición | No se pinta pin; sale en la lista bajo «Sin reportes», con el motivo |
| Posición vieja | Pin gris y «hace X»; nunca se oculta en silencio — un afiliado que desaparece del mapa es información, no ruido **(D1)** |
| Punto impreciso | Se guarda siempre, se filtra al leer; círculo punteado con el margen de error, **solo cuando es malo** (un círculo permanente de 5 m es ruido visual) |
| Punto que llegó tarde | El recorrido se dibuja por la hora del teléfono; el retraso se muestra aparte y colorea el tramo |
| `last_location` sin historial (purgado) | Descartado por antigüedad en la propia consulta |
| Suspendido o pausado con posición guardada | Excluido por el filtro de estado operativo |
| Varios en el mismo punto (una sede, un semáforo) | Con 100 no hace falta agrupar; **sí hace falta abrir en abanico** al pinchar, que es problema de legibilidad, no de rendimiento |
| Coordenada (0,0) o reloj desajustado | Ya se descarta al escribir (±5 min futuro, 24 h pasado) |
| Activo toda la noche | Visible, no corregido **(D4)** |

### De la pantalla

| Caso | Tratamiento |
|---|---|
| Nadie trabajando ahora | Estado vacío que explica la regla, no un mapa en blanco |
| Se cae la red al refrescar | Se conserva lo último pintado y se avisa discretamente. **Nunca vaciar el mapa** |
| Caduca la sesión (8 h) con el mapa abierto | El interceptor ya redirige al login; hay que parar el temporizador antes |
| Pestaña en segundo plano | Se pausa el refresco |
| Se navega a otra sección | Se cancela el temporizador |
| Día sin puntos en el historial | Estado vacío que distinga «no trabajó» de «no reportó» |
| Un solo punto en el día | No hay recorrido: se muestra el punto suelto |
| Modo oscuro | El panel lo tiene; CARTO publica estilo oscuro — hay que cambiarlo con el tema o el mapa quedará como un faro |
| Encuadre inicial | Ajustado a quienes se están mostrando; con uno solo, un zoom fijo razonable |

### De escala

| Caso | Nota |
|---|---|
| De 10 a 100 afiliados | La consulta del mapa es una lectura directa; no crece con el historial |
| Varios administradores a la vez | Cada uno pregunta por su cuenta: el coste se multiplica por operador |
| El día que llegue Viajes | El intervalo baja a 30-60 s: **el umbral de presencia y el ritmo de refresco tienen que derivar del ajuste**, nunca ser constantes |
| Rendimiento de dibujo | Con menos de 500 marcadores no es un problema. No optimizar para un cuello de botella que no tenemos |

---

## 7. Orden de trabajo

| Fase | Qué | Dónde | Entregable |
|---|---|---|---|
| **4a** | Los dos endpoints de lectura, con su filtro de presencia y sus pruebas | Backend | ✅ **Hecha**. 11 pruebas nuevas en verde y los endpoints probados por HTTP contra datos reales |
| **4b** | Mapa en vivo: librería, sección, lista lateral, ficha del afiliado, refresco | Panel | ✅ **Hecha**. Compila; falta verla en un navegador |
| **4c** | Recorrido por afiliado y día, con el tramo sin señal | Panel | ✅ **Hecha** salvo la exportación a CSV, que espera a la decisión D3 |
| **4d** | Direcciones de calle, en el servidor y con caché | Backend | ⬅️ **Pendiente**. Las fichas muestran hora y precisión, no calles |

4a es independiente: se puede probar entera antes de que el panel pinte un pin. 4b y 4c comparten la
sección, pero 4c no bloquea nada. 4d es opcional y se monta encima sin rehacer nada.

**Se deja fuera a propósito, y conviene que quede escrito:**

- **Agrupar marcadores.** Con cien no hace falta. Se añade cuando duela.
- **SSE o WebSocket.** El sondeo cada quince segundos sobra para este volumen.
- **Animar el movimiento entre dos posiciones.** Interpolar entre dos puntos separados diez minutos
  **inventa datos**: haría atravesar manzanas en línea recta. En una app para el pasajero eso es
  aceptable porque importa la sensación; en un panel de supervisión, mostrar una posición que nadie
  reportó es un defecto. Una transición corta de 300 ms para que el ojo siga el marcador, y nada más.
- **Geovallas, alertas de zona, informes de kilometraje.** No están pedidos.

---

## 8. Riesgos

| Riesgo | Salida |
|---|---|
| CARTO cambia su política de uso gratuito | Extracto de Venezuela en PMTiles sobre almacenamiento propio: cambia una URL, no el código |
| MapLibre no rinde en las máquinas de los operadores | Se comprueba en la primera semana de 4b, cuando aún no hay nada construido encima |
| El sondeo carga la base de datos con varios administradores | El parámetro `since` reduce casi todas las respuestas a vacío; si no basta, SSE sin tocar los componentes |
| La suite toca datos de producción | Ya resuelto por el patrón de `tests/locations.test.ts`: fixtures propios que se borran |
| Alguien quita el filtro de antigüedad por creerlo redundante | Comentario en el código explicando el caso de los fantasmas |
