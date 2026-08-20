# API REST — Referencia de endpoints

> Actualizado: 2026-08-03 · Base URL: `http://localhost:3000/api/v1`

## Convenciones

- **Auth**: salvo `GET /health`, `POST /auth/login` y `POST /driver-auth/login`, todos los
  endpoints exigen `Authorization: Bearer <token>` (JWT de 8 h emitido en el login). El token
  lleva un claim `type` (`admin`\|`driver`): un token de chofer no accede a rutas de admin y viceversa.
- **Formato**: JSON en camelCase. Los montos viajan como string decimal (`"150.00"`).
- **Errores**: `{ statusCode, error, message }` — `message` viene en español, listo para UI.
  Códigos usados: 400 (validación/regla), 401 (sesión), 403 (cuenta suspendida),
  404 (no existe), 409 (conflicto: duplicados, reglas de estado).
- **Validación**: entrada estricta (`additionalProperties: false`) — campos desconocidos se rechazan.

## Auth

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | `{ username, password }` → `{ token, admin }`. Bloqueo tras 5 intentos fallidos (15 min) |
| GET | `/auth/me` | Perfil del admin autenticado |

## Auth chofer (app móvil)

Autenticación de la app de choferes por **cédula + clave** (decisión 2026-07-16). La clave la
crea el panel al registrar al chofer (`users.password_hash`, argon2id). Emite un JWT con
`type: 'driver'`. Login **abierto** a cualquier chofer con credenciales válidas; la app enruta
por `status` (revisión / bloqueado / home). Lockout por intentos: diferido (no hay columnas aún).

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/driver-auth/login` | `{ nationalId, password }` → `{ token, driver }` (perfil incluye `status`, `registrationStep`, `fullName`, `phone`, `photoUrl`, `email`, `isAvailable`, `avgRating`, `tariffStarted`). 401 si la cédula no existe o el chofer no tiene clave de app |
| GET | `/driver-auth/me` | Perfil del chofer autenticado (guard `authenticateDriver`). **`tariffStarted`** = `tariff_start_set_at IS NOT NULL`: `false` significa **aprobado pero el admin aún no estableció el inicio de la tarifa** → la app muestra una pantalla de espera («falta activación»), no el home |
| GET | `/driver-auth/requirements` | Requisitos activos (driver + vehicle) con `isRequired`, para el wizard (público) |
| GET | `/driver-auth/payment-methods` | Métodos de pago activos, sin `admin_only` (público) |
| GET | `/driver-auth/vehicle-types` | Tipos de vehículo activos `{ id, name }`, para el selector del wizard (público) |
| GET | `/driver-auth/membership` | Membresía vigente `{ name, priceUsd, benefits[] }` (o `null`), para la **pantalla informativa previa** (beneficios + precio) y el resumen de cobro (público) |
| GET | `/driver-auth/subscription-plans` | Tarifas activas `{ id, name, priceUsd, billingPeriod }`, para el resumen de cobro (la app usa la semanal) (público) |
| POST | `/driver-auth/register` | **Auto-registro (público) — SOLO PASO 1** (solicitudes-app): datos personales + credenciales + `acceptedPrivacy` (obligatorio). Crea un **`applicant`** (`source='app'`, sin deuda, sin vehículos/documentos) → `{ token, driver, createdDocumentIds: [], createdVehicles: [] }`. Los documentos y vehículos se agregan después con el token |
| GET | `/driver-auth/me/checklist` | **"Completa tu solicitud"** (guard `authenticateDriver`): por cada requisito (chofer + por vehículo) el estado del documento — falta / en revisión / aprobado / **rechazado + motivo** — y el estado de revisión de cada vehículo. `{ driverDocuments[], vehicles[] }` |
| GET | `/driver-auth/me/vehicles` | Vehículos del chofer con **detalle completo** para el perfil (guard `authenticateDriver`): `[{ id, brand, model, year, color, plate, vehicleType, approvalStatus, rejectionReason, images:[{ id, position, url }] }]`. Las **fotos** son URLs firmadas (60 s) del bucket privado |
| POST | `/driver-auth/me/vehicles` | El solicitante agrega un vehículo a su **propia** solicitud (guard `authenticateDriver`; `driverId` del token). Nace **`pending`** (lo revisa el admin) → `{ id }` |
| POST | `/driver-auth/me/documents` | El solicitante agrega la metadata de un documento a su **propia** solicitud (`{ requirementId, vehicleId?, expiresAt? }`). Nace **`pending`**; un documento de vehículo exige que el vehículo sea suyo → `{ id }` |
| GET | `/driver-auth/me/debt` | **Deuda del alta** para el **pago diferido** de la app (guard `authenticateDriver`): membresía pendiente + cargos de tarifa/penalización adeudados, con desglose por línea y total, y si ya hay un pago en revisión. `{ totalUsd, items: [{ label, amountUsd }], hasPendingPayment, rejected }`. **`rejected`** (2026-08-19) = `{ amountUsd, reason, reviewedAt }` cuando su **último** envío fue rechazado, `null` en cualquier otro caso: es el ÚNICO canal por el que el chofer se entera del rechazo y de su motivo (antes solo lo sabía el panel, y la app le devolvía la pantalla de pago sin decir nada). Mismo criterio que `rejectedSubmission` de `GET /drivers/:id`, así que enviar un pago nuevo lo apaga solo. Declarado en el schema de respuesta o el serializador lo borra |
| POST | `/driver-auth/payment-submissions` | Envío de pago del chofer (guard `authenticateDriver`, multipart). `driverId` del token. **Un `applicant` no puede pagar (409)**; exige `acceptedTerms=true` (sella `accepted_terms_at`). `purpose` = `enroll` (membresía + `periods` semanas) o `debt`. En `debt`, `periods` (≥1) permite **adelantar semanas del alta** (Forma A): paga la deuda base (membresía + 1 semana) + `periods−1` semanas extra; las extra se crean **pagadas al aprobar** el recibo (un rechazo no deja deuda fantasma) y se anclan con la base al «Establecer inicio». `advance`/`change_plan` son solo-admin (400). Nunca auto-aprueba; queda `pending` |
| POST | `/driver-auth/documents/:id/file` | Adjunta archivo a un documento **propio** (guard `authenticateDriver`; 404 si es de otro chofer) |
| GET | `/driver-auth/documents/:id/file` | URL firmada (60 s) para **previsualizar** el archivo de un documento **propio** (guard `authenticateDriver`; 404 si es de otro chofer o no tiene archivo). `{ url, expiresIn }`. El tipo (imagen/PDF) se infiere por la extensión de la `url` |
| GET | `/driver-auth/me/account` | **Estado de cuenta** del chofer para su perfil (guard `authenticateDriver`): `{ driverStatus, reactivatesAt, paidUntil, upcoming:{ amountUsd, periodStart, periodEnd }|null, nextChargeAt, weeksOwed, penaltyCount, capWeeks, planPriceUsd }`. `driverStatus` es la columna real que mantiene el motor de deuda (`approved`/`overdue`/`penalized`/`paused`). `upcoming` (cobro **ya emitido**, adelantable) y `nextChargeAt` (cuándo lo **emitirá** el motor, solo plan semanal activo) son **excluyentes**. `reactivatesAt` = penalizado que ya pagó y espera su reactivación. Reutiliza los fragmentos SQL de `drivers/billing-sql.ts` que consume el panel |
| PATCH | `/driver-auth/me` | **Edición de sus propios datos** (guard `authenticateDriver`). Lista blanca: `phone`, `email`, `address`, `password`. **Nombres y cédula NO se editan aquí** (identidad verificada por un admin contra documentos aprobados). Cambiar la clave exige `currentPassword` (401 si no coincide); email duplicado → 409. Devuelve el perfil actualizado. Audita `driver.self_updated` **sin** copiar los valores nuevos |
| GET | `/driver-auth/me/editable` | Campos del formulario de edición que no viajan en `/me` (hoy `{ address }`) |
| PATCH | `/driver-auth/me/availability` | El chofer se pone **activo o inactivo** (guard `authenticateDriver`). Ponerse **inactivo** siempre se permite; ponerse **activo** da **409** si su estado no le permite operar (`penalized`/`paused`) — `overdue` sí puede, debe semanas pero está bajo el tope. `{ isAvailable }` |
| PATCH | `/driver-auth/me/vehicles/:vehicleId/primary` | **Con qué vehículo trabaja** (guard `authenticateDriver`). Elegir uno libera el anterior solo (una sola columna, `drivers.current_vehicle_id`). Solo se admite un vehículo **aprobado**: en revisión o rechazado → **409** con su motivo; ajeno → 404. `GET /me/vehicles` marca cuál es con `isPrimary`. Con **un solo** aprobado se asigna solo al aprobarlo |
| POST | `/driver-auth/me/photo` | **Foto de perfil** (guard `authenticateDriver`, multipart). Solo JPG/PNG **reales** (magic number; un PDF o un .png de mentira → 400), máx. 10 MB. Sube al bucket **privado** bajo `{userId}/profile/{uuid}.ext`, guarda el **path** en `users.photo_url` y **borra la foto anterior**. Devuelve `{ photoUrl }` ya firmado |
| POST | `/driver-auth/vehicles/:vehicleId/images` | Sube foto a un vehículo **propio** (guard `authenticateDriver`; valida propiedad) |

**Foto de perfil y avatares.** `users.photo_url` guarda el **path del bucket**, nunca un enlace:
el binario jamás toca la BD y el bucket sigue privado. Toda salida la firma la API — `/driver-auth/me`
y el login la firman una a una; el **detalle** y las **listas** del panel (afiliados y solicitudes) la
firman **en lote** (`StorageProvider.getSignedUrls`, un POST para toda la página en vez de uno por
fila). El TTL del avatar es de **1 hora**, no de 60 s como los documentos: sale en cada fila de cada
lista y el cliente la cachea por URL, así que un TTL corto obligaría a redescargar las mismas caras en
cada scroll (una cara es mucho menos sensible que una cédula, y el bucket sigue privado). Una firma
que falla se degrada a `null` y la UI cae a las iniciales: una foto rota no puede tumbar la lista.

**Auto-registro y limpieza.** El registro es abierto (la barrera de calidad es la aprobación del
admin, no la entrada). El alta reutiliza el único camino de dinero (`DriversService.register` con
`source='app'`: `registered_by`/`uploaded_by` = `null`, actor en `audit_logs.actor_user_id`). Las
subidas y el pago del chofer usan su token y validan propiedad (el recurso es suyo). Un job diario
(`applicant-cleanup-scheduler`) purga a los **7 días** los `pending` **sin pago vivo** (sin envío
`pending`/`approved`) y **sin ninguna factura**, borrando filas en cascada + archivos del bucket;
**apagado por defecto** (dry-run) hasta encender `applicant_cleanup_enabled`. Los `rejected` **se
conservan** (política 2026-08-13). La condición de las facturas se añadió el **2026-08-19**: un
registro por panel sin pago, o una deuda de alta re-emitida tras revertir un recibo, dejan a un
`pending` sin pago vivo pero **con facturas emitidas y dinero por cobrar**; purgarlo borraría
documentos de dinero (regla 7). El borrado en cascada además **se niega** a correr si el chofer
tiene facturas, por si el criterio de selección vuelve a quedarse corto.

## Administradores

| Método | Ruta | Descripción |
|---|---|---|
| GET / POST | `/admins` | Listar / crear (`username`, `fullName`, `password` ≥ 10, `email?`) |
| GET / PATCH | `/admins/:id` | Detalle / actualizar (`fullName`, `email`, `status`; sin auto-suspensión) |
| PUT | `/admins/:id/password` | Cambiar contraseña |

## Catálogos

| Método | Ruta | Descripción |
|---|---|---|
| GET / POST | `/vehicle-types` | Tipos de vehículo |
| PATCH / DELETE | `/vehicle-types/:id` | Editar / eliminar (409 si está en uso) |
| GET / POST | `/requirements` | Documentos exigibles (`appliesTo: driver\|vehicle`, `isRequired` solo aplica al registro desde la app) |
| PATCH / DELETE | `/requirements/:id` | Editar / eliminar (409 si tiene documentos) |
| GET / POST | `/benefits` | Beneficios del gremio |
| PATCH / DELETE | `/benefits/:id` | Editar / eliminar (409 si pertenece a una membresía) |
| GET / POST | `/payment-methods` | Cuentas donde los afiliados pagan. **Tipos ofrecidos**: `bank_transfer`\|`pago_movil`\|`zelle`\|`binance` (2026-07-31) + **`cash_usd`** ("Efectivo Divisa", **admin-only** v9: nunca se ofrece a la app —el catálogo expone `adminOnly`, derivado del tipo—; al cobrar captura monto + 1..5 fotos de billetes). El enum de la BD conserva `paypal`/`crypto`/`contact` inertes, pero la API los rechaza. `details` jsonb validado por tipo en el service. Campos por tipo (investigados 2026-07-31): **transferencia** = banco + cuenta 20 díg + tipo + titular + cédula/RIF · **pago_movil** = banco + teléfono + cédula/RIF · **zelle** = email/tel EE.UU. + titular · **binance** = email/tel/Binance ID + titular(opc). Formato validado — `email`/`identifier` de Zelle/Binance si contienen `@`, y la cédula `V/E/J` de Pago Móvil/transferencia (el panel la captura con selector V/E/J + dígitos); `name` etiqueta libre |
| PATCH / DELETE | `/payment-methods/:id` | Editar (tipo+`details` van juntos) / activar-desactivar (`isActive`) / eliminar (409 si está en uso → desactivar) |
| GET | `/settings` | Configuración (las claves nacen por migración, nunca por API) |
| PATCH | `/settings/:key` | Actualizar el valor de una clave existente |

## Membresía y tarifas (versionado condicional)

Editar una versión **sin pagos** la modifica en el sitio; **con pagos** la archiva y crea una
réplica activa automáticamente (quien pagó conserva precio y beneficios de su versión).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/memberships` | Historial de versiones (la activa + archivadas). Cada versión trae `benefitIds` y **`memberCount`** (choferes no rechazados que la pagaron) |
| GET | `/memberships/current` | Versión vigente con sus beneficios |
| POST | `/memberships` | Crear la primera membresía (409 si ya existe una vigente) |
| PUT | `/memberships/current` | Editar la vigente (**versionado condicional**): si la versión tiene pagos de choferes **no rechazados** se archiva y se crea una réplica; si no, edición in-place. Los beneficios se gestionan aquí (no hay catálogo aparte) |
| GET / POST | `/subscription-plans` | Catálogo de tarifas (`billingPeriod: daily\|weekly\|monthly\|annual`; `allowedVehicleTypeIds` vacío/null = todos) |
| PUT | `/subscription-plans/:id` | Editar (versionado condicional) |
| PATCH | `/subscription-plans/:id/active` | Archivar / reactivar |

## Afiliados (registro + ciclo de vida)

> **Registro transaccional (2026-07-21):** el alta ocurre en una sola transacción vía
> `POST /drivers/register` (datos personales + vehículos + documentos + pago, todos
> opcionales salvo los datos). Los **archivos** de los documentos del chofer se suben **después**
> del registro contra `createdDocumentIds`; las **fotos** y los **documentos de vehículo** se
> suben contra `createdVehicles` (el vehículo no tiene id hasta registrar). Flota y documentos
> también se gestionan como datos vivos desde el perfil (`POST /drivers/:id/vehicles`,
> `POST /drivers/:id/documents`). Ver [decisions-log.md](../decisions/decisions-log.md#2026-07-21).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/drivers` | Listado paginado. Query: `status` (incluye `applicant`), **`source`** (`app`\|`admin`, para separar Solicitudes de Afiliados), `search` (nombre/email/cédula), `page`, `limit`. Cada fila incluye `subscription` (estado/cobertura), **`debtUsd`** (deuda total) y **`hasPendingSubmission`** (pago en revisión) — el panel distingue en la columna estado/tarifa: al día / falta pago / pago en revisión |
| POST | `/drivers/register` | **Registro transaccional**: datos personales + `payment`, `vehicles[]` y `documents[]` opcionales, **todo en una transacción** (si algo falla, no queda afiliado/vehículo/factura). `payment` = `{ planId, periods }` (`periods > 1` = adelanto ×N, emite facturas; `null` → `pending`). `vehicles[]` = `{ vehicleTypeId?, brand?, model?, year?, color?, plate?, documents?: [{ requirementId }] }` (nacen aprobados; los `documents[]` anidados son requerimientos de **vehículo**). `documents[]` = `{ requirementId, expiresAt? }` (requerimientos de **chofer**; el archivo se sube luego con `POST /documents/:id/file` usando `createdDocumentIds`, mismo orden). Campos de persona: obligatorios `firstName`, `lastName`; opcionales validados `middleName`, `secondLastName`, `birthDate` (≥18), `address`, `email`, `nationalId` (`V`\|`E`\|`J` + `-` + 5–9 dígitos), `phone` (`+58` + 10 dígitos), `password` (login de la app: usuario = documento; **≥6**, admite solo números; exige `nationalId`). ⚠️ El **panel exige documento + contraseña**. Devuelve el detalle del afiliado + `invoiceNumbers` + `createdDocumentIds` + **`createdVehicles: [{ id, documentIds }]`** (para subir fotos y archivos de documentos de cada vehículo). `hasAppPassword` booleano; el hash **nunca** viaja |
| POST | `/drivers` | Alta **solo-persona** (mismos campos de persona que `/register`, sin `payment`). Se conserva para compatibilidad; el panel registra por `/register` |
| GET | `/drivers/:id` | Perfil completo: vehículos, documentos, membresía, **`benefits`** (los de la versión de membresía que pagó), suscripción (con `priceUsd`/`startedAt` y **`paidUntil`** = fin del último período prepagado, para "pagado hasta"), **`debt`** (deuda **vencida** del motor v8: `totalUsd`, `weeksOwed`, `penaltyCount`, `capWeeks` [tope antes de penalizar], `charges[]`; ceros si no debe) y **`upcoming`** (próximo cobro ya emitido pero **no vencido**: `amountUsd`/`periodStart`/`periodEnd`; `null` si no hay — decisión 2026-07-29), y **v9** `pendingSubmission` (envío de pago en revisión → banda "Pago en revisión", oculta el botón de pago) / `rejectedSubmission` (último envío rechazado → mensaje "su pago fue rechazado"). Todo el dinero como string decimal |
| PATCH | `/drivers/:id` | Editar datos personales (mismo contrato que el POST; `password` vacía = conservar la actual) / cambiar estado (`approved`/`suspended`). Al pasar a `approved` (p. ej. quitar una suspensión) exige membresía `paid` + tarifa **y deuda 0** — 409 si no (mismo candado que `approve`, decisión 2026-07-29) |
| POST | `/drivers/:id/documents` | Registrar (desde el perfil) un documento contra un requerimiento → `{ id }` (para adjuntarle el archivo) |
| POST | `/drivers/:id/vehicles` | Registrar (desde el perfil) un vehículo (por panel nace aprobado) |
| PATCH | `/drivers/:id/vehicles/:vehicleId` | Editar los datos de un vehículo (`vehicleTypeId?`, `brand?`, `model?`, `year?`, `color?`, `plate?`) |
| POST | `/drivers/:id/vehicles/:vehicleId/approve` | **Revisión de vehículo (solicitudes-app)**: aprueba → `approved` |
| POST | `/drivers/:id/vehicles/:vehicleId/reject` | Rechaza el vehículo con `{ reason }` (el solicitante lo ve para corregir) |
| POST | `/drivers/:id/vehicles/:vehicleId/images` | Subir una **foto** del vehículo (multipart, campo único). Solo **JPG/PNG** validado por contenido; máx. 10 MB; **máx 3 por vehículo → 409**. Devuelve la imagen creada (201) |
| GET | `/drivers/:id/vehicles/:vehicleId/images/:imageId/file` | `{ url, expiresIn }` — URL **firmada de 60 s** de la foto (bucket privado) |
| DELETE | `/drivers/:id/vehicles/:vehicleId/images/:imageId` | Borra la foto (fila + archivo del storage). 204 |
| POST | `/drivers/:id/enroll` | Cobra membresía + tarifa a un afiliado existente: `{ planId, periods }`, `periods > 1` = adelanto ×N. Emite **una sola factura por el total** (membresía + todos los períodos; cada período sigue como una fila de cobertura `subscription_payments`) — decisión 2026-07-28. **Metadatos de pago opcionales**: `{ paymentMethodId?, reference?, payerBank?, paidOn?, payerPhone?, payerId? }` se estampan en la factura primaria. `reference` ≤25, **solo alfanumérico + espacio**; `paidOn` fecha ISO (día del pago); `payerPhone` (`+58`+10) y `payerId` (`V/E/J`) son **de Pago Móvil** (2026-07-31). Devuelve `invoiceNumbers` + **`primaryInvoiceId`** (para adjuntar el comprobante). Disponible para cobrar a un `pending` registrado sin pago |
| POST | `/drivers/:id/subscription/renew` | `{ periods, planId?, note?, paymentMethodId?, reference?, payerBank?, paidOn?, payerPhone?, payerId? }` — cobra N períodos (factura c/u). `note` opcional = constancia (p. ej. "parte por transferencia, resto en efectivo"). Si la tarifa está **vencida**, reactiva la operación automáticamente. Con `planId` distinto = **cambio de tarifa**: con cobertura pagada queda `scheduled` y arranca al agotarla (el scheduler la activa); sin cobertura arranca ya. 409 si ya hay un cambio programado. Los datos de pago se estampan en la factura primaria y devuelve `primaryInvoiceId` para adjuntar el comprobante (Pieza 2, 2026-07-24) |
| POST | `/drivers/:id/subscription/cancel-change` | Cancela el cambio programado: reembolsa sus períodos y anula sus facturas (conservan número). La tarifa en curso no se toca |
| POST | `/drivers/:id/approve` | **Aprobar afiliado `pending` → `approved`** (panel). Exige solo que esté **enrolado** (membresía + tarifa, pagadas o como **deuda**) — **ya NO exige deuda 0** (2026-08-11): aprobar y arrancar la tarifa están desacoplados, así que puede aprobarse con un pago en revisión. Queda `approved` **con su deuda** pero **no opera** hasta `/start-tariff` (que sí exige deuda 0). Ya **no** lleva `startMode` |
| POST | `/drivers/:id/start-tariff` | **Establecer inicio de tarifa** ("Establecer inicio", solicitudes-app). Body `{ startMode }` (`now` \| `next_monday`). Exige el afiliado `approved` **sin inicio previo**, pago saldado y deuda 0. Ancla la suscripción y **sella `tariff_start_set_at` atómicamente** → el motor de deuda empieza a cobrarle. `now` → lunes de la semana en curso, activa ya; `next_monday` → próximo lunes, queda `scheduled` hasta ese día |
| POST | `/drivers/:id/approve-application` | **Aprobar solicitud (app)**: `applicant` → `approved` + **deuda base** (membresía + 1 semana). **No** exige deuda 0 (nace con deuda; el pago la salda). Requiere **todos** los documentos y vehículos `approved` y ≥1 vehículo (409 si falta). El arranque queda pendiente de `/start-tariff` |
| POST | `/drivers/:id/reject-application` | **Rechazar solicitud (app)**: `applicant` → `rejected`. **Se conserva en archivo** (policy 2026-08-13: ya NO se purga a los 7 días) y su cédula queda bloqueada para auto-registro; el solicitante debe contactar al admin |
| POST | `/drivers/:id/alta-debt` | **Volver a emitir la deuda del alta** (2026-08-19) a un afiliado `pending`/`approved` que se quedó **sin nada que deber** tras revertir su recibo. Revertir anula las facturas que ese recibo **generó**: correcto si el pago nunca debió registrarse, **incorrecto si el pago rebotó** — ahí el chofer sigue debiendo y, mientras esté `pending`, la app ni siquiera le muestra la pantalla de pago. Emite otra vez las **dos facturas impagadas** (membresía + primera semana, sin fechas) **reutilizando** su suscripción `scheduled` (hay índice único: una sola por chofer). **409** si ya tiene la deuda emitida o ya pagó la membresía. Audita `driver.alta_debt_regenerated`. **No es automático al revertir**: solo el admin sabe si el dinero rebotó o si el recibo fue un error |
| POST | `/drivers/:id/reopen-application` | **Reabrir solicitud (app)**: `rejected` → `applicant` (nueva revisión). Conserva sus documentos/vehículos tal como quedaron. **409** si no está rechazada. Única vía de retorno para un rechazado (no hay re-registro self-service) |
| POST | `/drivers/:id/reject` | Rechazar (afiliado `pending`): reembolsa ambos pagos y anula sus facturas (conservan número) |
| POST | `/drivers/:id/pause` | **Pausar — licencia (2026-07-23)**: `approved` → `paused`. Exige la tarifa **al día** (409 si no); **congela** la tarifa (el scheduler la salta). Devuelve el detalle |
| POST | `/drivers/:id/resume` | **Reanudar**: `paused` → `approved` + disponible; la tarifa corre de nuevo **desplazada** por el tiempo que estuvo pausada. Devuelve el detalle |
| ~~POST~~ | ~~`/drivers/:id/external-payment`~~ | **Retirado (2026-08-13).** Ruta legacy v8 que saldaba la deuda al instante **sin recibo ni rastro reversible** (`submission_id = NULL`), saltándose el guard anti-doble-cobro del flujo v9 y dejando cargos que `reverse` no podía deshacer. Para registrar un pago de deuda usa el flujo de **envíos de pago** (`POST /drivers/:id/payment-submissions` con `purpose='debt'`) |
| POST | `/drivers/:id/reactivate` | **Reactivación manual (v8)**: `penalized` → `approved` + disponible **de inmediato**, en vez de esperar al día de reincorporación automática (`reactivation_mode = auto` → lunes siguiente). **Exige deuda 0** (409 si aún debe): primero el dinero, después el estado |

## Facturación (historiales, solo lectura)

- Numeración **continua global** (`invoice_number` desde una secuencia única, sin reinicio anual).
- Las facturas nunca se borran: los reembolsos las marcan `voided` con fecha y admin responsable.
- Comprobante **interno no fiscal** (la facturación SENIAT es un análisis aparte).
- Facturas y pagos se **crean únicamente** desde los flujos de afiliación/renovación; estos
  endpoints solo consultan. Los pagos salen de la vista `v_driver_payments`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/invoices` | Historial global de facturas, número descendente. Query: `status` (`issued`\|`paid`\|`voided`), `driverId` (historial por afiliado), `search` (afiliado o Nº), `page`, `limit`. Incluye afiliado, admin que anuló y **datos de pago (Pieza 2)**: `paymentMethodName`, `paymentReference`, `payerBank`, `hasProof`.<br>⚠️ **`status` es DERIVADO de los cargos de la factura** (2026-07-30), no la columna física (que solo conoce `issued`/`voided`): `voided` manda siempre; `paid` cuando **todos** sus cargos (`membership_payments` + `subscription_payments`) están pagados; `issued` mientras quede alguno por cobrar (la factura de deuda del alta sin pago). Campo `paidAt` = `max(paid_at)` de sus cargos, **null salvo que esté saldada por completo**. El filtro `status` usa la misma derivación. Incluye además los **datos del pagador (2026-07-31)**: `paidOn` (día del pago), `payerPhone`, `payerId` (Pago Móvil) |
| GET | `/invoices/:id` | Detalle de una factura (mismos campos que la lista) + **`submissionId`**: el envío de pago v9 que la generó, si aplica, para mostrar sus comprobantes. 404 si no existe |
| POST | `/invoices/:id/proof` | **Comprobante (Pieza 2, legado)**: adjunta el archivo (multipart, campo `file`; **PDF/JPG/PNG, 10 MB**, validado por magic-number). La ruta la decide el servidor (`proofs/driverId/invoiceId.ext`). 503 si el storage no está configurado. Con v9 los comprobantes viven en el envío (`payment_submission_files`); esto queda para facturas previas |
| GET | `/invoices/:id/proof` | `{ url, expiresIn }` — URL **firmada de 60 s** del comprobante (bucket privado). 404 si la factura no tiene comprobante |
| GET | `/invoices/monthly-series` | Serie mensual de facturación para el gráfico de barras del panel (2026-07-22). Query: `months` (3–24, default 12). Un punto por **mes calendario en `business_timezone`** (`{ month, totalUsd, count }`), anuladas excluidas; meses sin facturas en cero (eje continuo) |
| GET | `/payments` | Historial unificado de pagos (membresía + tarifas). Query: `kind` (`membership`\|`subscription`), `status` (`pending`\|`paid`\|`refunded`), `driverId`, `search`, `page`, `limit`. Incluye concepto (nombre de la versión pagada), período (solo tarifas) y Nº de factura |

## Verificación de pagos — envíos (v9, 2026-08-03)

> **Flujo de aprobación anti-fraude.** Ningún cobro se liquida en el acto: un **envío de pago**
> (`payment_submissions`) nace **`pending`** y un admin lo **aprueba** (salda la deuda / acredita
> las semanas / crea la membresía, y **emite la factura** con la metadata del pago) o lo
> **rechaza** (deja rastro con motivo; el chofer genera uno nuevo). El **motor de deuda se
> congela** mientras hay un envío pendiente (no marca mora ni penaliza). Todos los cobros del
> panel (alta, enroll, adelanto, pago de deuda) crean un envío; los endpoints directos
> `/enroll` y `/subscription/renew` se conservan (compat / cambio de plan) pero el panel usa
> este flujo (el legacy `/external-payment` fue **retirado** el 2026-08-13). **Multi-pago**
> (2026-08-12): se admiten varios envíos pendientes por chofer siempre que cubran **facturas
> distintas** — cada factura la reserva a lo sumo un envío, y un pago de **deuda total** (sin
> facturas) bloquea cualquier otro. El guard se **serializa por chofer con un `pg_advisory_xact_lock`**
> dentro de la transacción de `create` (backstop tras quitar el índice único). Contrato completo
> para la **app del chofer**: [proposals/pagos-aprobacion](../proposals/pagos-aprobacion/README.md).

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/drivers/:id/payment-submissions` | Crea un **recibo de pago** pendiente (multipart). Campos: `purpose` (`debt`\|`advance`\|`enroll`\|`change_plan`), `periods?` (advance/enroll/change_plan), `planId?` (**change_plan**), `invoiceIds?` (**pago parcial**: ids de facturas de deuda a saldar, separados por coma; cada una se paga completa), datos del pago (`paymentMethodId?`, `reference?`, `payerBank?`, `paidOn?`, `payerPhone?`, `payerId?`, `payerAccount?`), `note?`, y **0..5 imágenes** en `files` (PDF/JPG/PNG, 10 MB; para `cash_usd` la foto es **opcional**). **Rediseño 2026-08-04**: un recibo cubre **N facturas** (1 por concepto). `enroll` genera sus facturas `pending` al crearse (rechazar deja deuda); `debt` salda las facturas seleccionadas (o toda la deuda); `advance`/`change_plan` prepagan N semanas. 409 si ya hay un envío pendiente. **`autoApprove?`** (solo `admin`, 2026-08-06): aprueba el recibo en el acto en vez de dejarlo pendiente. Origen `admin`; la **app** POSTea con su token `driver` (nunca auto-aprueba) |
| GET | `/payment-submissions` | Lista de **recibos**. Query: `status` (`pending`\|`approved`\|`rejected`\|`reverted`), `driverId?`, **`search?`** (nombre del pagador o N° de pago), `page`, `limit`. Cada fila: `submissionNumber` (N° de pago), afiliado, `purpose`, monto, estado, método, fecha, **`invoiceNumbers`** (N° de las facturas que cubre, vía sus cargos; `null` si aún no hay ninguna) |
| GET | `/payment-submissions/:id` | Detalle del recibo: `submissionNumber`, `purpose`, datos del pagador, **`items[]`** (una línea por factura, con **`invoiceNumber`** + período + monto), traza de revisión/**reversión** (`reversalReason`, `revertedByName/revertedAt`), y **`files[]`** con URL **firmada de 60 s** |
| POST | `/payment-submissions/:id/approve` | **Aprueba**: salda/paga las **N facturas** del recibo (una por concepto) y marca `approved`. 409 si no está pendiente, o si es `debt` sin deuda |
| POST | `/payment-submissions/:id/reject` | **Rechaza**: `{ reason }` (≤500). `rejected` con rastro; las facturas quedan en **deuda**. 204 |
| POST | `/payment-submissions/:id/reverse` | **Revierte** un recibo **aprobado**: `{ reason }` (≤500). **Acción única** (refund/correction fusionados 2026-08-06 — hacían lo mismo): **anula** las facturas que el recibo generó y devuelve a **deuda** lo que solo saldó (para re-cobrar). Marca `reverted` con rastro; si pierde la membresía, el chofer vuelve a `pending`. 409 si no está aprobado. 204 |

## Dashboard

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/dashboard/summary` | Resumen operativo: afiliados (aprobados/pendientes/suspendidos/**en pausa**/**en mora**/**penalizados** + `approvedLast7`/`approvedPrev7` desde el log de auditoría, 2026-07-22; `overdue`/`penalized` los deriva el motor de deuda v8, hoy 0 con el motor apagado, B4 2026-07-24), tarifas por vencer (cobertura pagada ≤ `payment_reminder_days`, adelantos incluidos) y vencidas, documentos por vencer (≤ 30 días) y vencidos, facturación de los últimos 7 días (monto + cantidad + `prev7DaysUsd` para la tendencia semana a semana, anuladas excluidas). El feed de actividad del panel reutiliza `GET /audit-logs` |
| GET | `/dashboard/revenue-series` | Serie diaria de facturación para el gráfico del panel (2026-07-22). Query: `days` (7–90, default 30). Devuelve un punto por **día calendario en `business_timezone`** (`{ date, totalUsd, count }`), anuladas excluidas; los días sin facturas vienen en cero (eje continuo) |

## Documentos (vista global, solo lectura)

Los documentos se registran desde el perfil/wizard del afiliado (módulo drivers). Un
scheduler los marca `expired` cuando pasa su fecha (medianoche en `business_timezone`,
auditado con actor sistema). El vencimiento **alerta pero no bloquea** la operación.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/documents` | Listado transversal paginado, próximos a vencer primero. Query: `status` (`valid`\|`expired`\|`rejected`), `requirementId`, `search` (afiliado o placa), `expiringDays` (válidos que vencen en ≤ N días), `page`, `limit`. Cada documento resuelve a su dueño: chofer directo o dueño del vehículo (con placa) |
| POST | `/documents/:id/file` | Adjunta el archivo (multipart, campo `file`). **PDF, JPG o PNG, máx. 10 MB**; el tipo se valida por el contenido real (magic number), no por la extensión ni el `Content-Type` declarado. La ruta la decide el servidor. 503 si el storage no está configurado |
| GET | `/documents/:id/file` | `{ url, expiresIn }` — URL **firmada de 60 s** para abrir el archivo (el bucket es privado; nada es público) |
| POST | `/documents/:id/approve` | **Revisión (solicitudes-app)**: aprueba el documento → `approval_status='approved'` (sella `reviewed_by`/`reviewed_at`) |
| POST | `/documents/:id/reject` | Rechaza con `{ reason }` (obligatorio; el solicitante lo ve para corregir y reenviar) → `approval_status='rejected'` |
| DELETE | `/documents/:id` | Borra el documento (fila + archivo del storage si lo tiene). 204. Requiere `DELETE` habilitado en CORS |

## Capacitaciones

Se **cancelan, nunca se borran** (los asistentes conservan su historial). Solo se
inscriben afiliados **aprobados o en pausa** (licencia; un pausado sigue siendo miembro);
el control de cupo es atómico (dos inscripciones simultáneas no pueden sobrevender). Todo
queda auditado.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/trainings` | Listado paginado con `enrolledCount` (inscritos no cancelados). Query: `status` (`scheduled`\|`cancelled`\|`completed`), `page`, `limit` |
| GET | `/trainings/:id` | Detalle + asistentes (nombre y cédula, orden alfabético) |
| POST | `/trainings` | Crear: `title`, `startsAt` (obligatorios), `description?`, `location?`, `endsAt?` (> inicio), `capacity?` (null = sin límite) |
| PUT | `/trainings/:id` | Editar (solo programadas; el cupo no puede bajar de los inscritos actuales) |
| PATCH | `/trainings/:id/status` | `{ status: cancelled \| completed }` — transición única desde `scheduled` |
| POST | `/trainings/:id/attendees` | Inscribir `{ driverId }` (409: no aprobado ni en pausa, ya inscrito o sin cupo). Reinscribir a un cancelado reutiliza su fila |
| PATCH | `/trainings/:id/attendees/:attendeeId` | `{ status: attended \| absent \| cancelled }` — la asistencia puede marcarse incluso tras completar |

## Auditoría (solo lectura)

Las entradas las escriben los servicios que actúan — **todos los módulos auditan**
(afiliados, catálogos, membresía, tarifas, administradores, settings y scheduler) vía el
helper compartido `writeAudit`. Esta API solo las consulta — nunca se crean, editan ni
borran por HTTP.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/audit-logs` | Listado paginado, más reciente primero. Query: `eventType`, `entity`, `source` (`admin`\|`system`), `adminId`, `from`/`to` (días calendario en `business_timezone`), `page`, `limit`. Cada entrada resuelve el actor (admin o sistema) y el afiliado afectado (`driverId`/`driverName`, listo para enlazar al perfil) |
| GET | `/audit-logs/facets` | Valores presentes en el log para poblar los filtros del panel: `eventTypes`, `entities` y `actors` (solo admins que han actuado). Nada hardcodeado en el frontend |

## Utilidades

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Liveness: hora de la BD + versión de PostGIS (sin auth) |
