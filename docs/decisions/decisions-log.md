# Registro de decisiones

Decisiones de negocio y técnicas en orden cronológico. Las decisiones de modelado de datos
detalladas viven en [database/database-design-v7.md](../database/database-design-v7.md);
aquí queda el resumen ejecutivo y las decisiones posteriores al diseño.

## 2026-07-07 — Fundamentos

| Decisión | Motivo |
|---|---|
| Backend propio (Node.js + Fastify) como único punto de entrada; las apps jamás tocan la BD | Robustez y escalabilidad sobre velocidad de entrega |
| PostgreSQL + PostGIS alojado en Supabase, usado solo como Postgres gestionado | Infraestructura administrada sin acoplarse al BaaS |
| Sin APIs pagas en desarrollo: distancias con PostGIS, mapas OSM, push FCM | Control de costos |
| Moneda dual: precios anclados en USD, viajes congelan tasa en Bs | Contexto Venezuela |

## 2026-07-07/08 — Siete rondas de diseño de BD (v1 → v7)

Resumen: membresía única de pago único vitalicio con beneficios por versión · tarifas prepago
(diaria→anual) con gracia y suspensión automática · **versionado condicional** en membresía y
tarifas ("regla de los 150 USD": editar con pagos = archivar y crear versión nueva) ·
requerimientos de documentos configurables **por origen** (obligatorios solo desde la app) ·
facturación interna uniforme con anulación con rastro · wizard de registro de 4 pasos ·
auditoría. Detalle completo y cronología: [database/README.md](../database/README.md).

## 2026-07-10 — Decisiones de implementación

| Decisión | Motivo |
|---|---|
| Login del admin con **usuario y contraseña** (se añadió `username` único a `admins`; el email queda como contacto) | Pedido del negocio |
| **Numeración de facturas continua** (secuencia global única, sin reinicio anual) | Evitar cualquier ambigüedad de números repetidos entre años |
| **Cédula (`national_id`)**: obligatoria al registrarse desde la app, opcional al registrar por el panel | Coherente con la regla de requerimientos por origen |
| **Integración Supabase Auth pospuesta** (modo prueba): `users.id` propio + columna `auth_user_id` para vincular después | Permite avanzar sin migrar claves primarias más adelante |
| Data API de Supabase deshabilitada | Hardening: solo Fastify accede a los datos |
| Sin ORM: SQL directo (`pg`) + migraciones versionadas (node-pg-migrate) | Control total de SQL, PostGIS, índices parciales y transacciones |
| **Modelos por tabla generados desde la BD** (Kanel → `src/db/models/`, regenerar con `npm run db:types` tras cada migración); los repositorios derivan sus tipos de esas filas | Entidades tipo POJO sin riesgo de desincronización: se generan desde la verdad (la BD), no se mantienen a mano |
| Vehículos registrados por el panel nacen aprobados | El admin es la autoridad de aprobación |
| Storage de archivos pospuesto: los documentos registran metadatos (`file_url` nullable) | Modo prueba |

## Pendientes conocidos

- Integración Supabase Auth (cuenta del chofer) y notificaciones/push — van con las apps.
- Contrato de afiliación (`drivers.contract_url`): la infraestructura de Storage ya existe,
  falta el flujo de subida del contrato firmado.
- ¿Un documento obligatorio vencido debe bloquear la operación del chofer? Hoy solo alerta.
- Facturación fiscal SENIAT: análisis aparte con el contador (el comprobante actual es interno).

## 2026-07-13 — Vencimientos y renovación (bloque 4)

| Decisión | Motivo |
|---|---|
| Los períodos vencen a las **00:00** (zona `business_timezone`, seed America/Caracas) del día correspondiente; ventana móvil, **sin anclaje al calendario** | Anclar solo semanales al domingo obligaría lógicas distintas para mensuales/anuales |
| **Suspensión inmediata** al vencer (`subscription_grace_hours = 0`, la clave sigue configurable) | Decisión de negocio; la clave queda por flexibilidad futura |
| El estado de tarifa es **independiente** del estado administrativo del chofer: la suscripción pasa a `expired` (no opera) y el pago de renovación la **reactiva automáticamente** | No contaminar la suspensión administrativa; reactivación sin intervención manual |
| Alerta `payment_reminder_days` (seed 3) días antes del vencimiento: badge en el panel HOY; badge + push en la app del chofer cuando exista (documentado, no implementado) | La app del usuario aún no se desarrolla |
| El scheduler consume adelantos automáticamente (avanza al siguiente período pagado) y audita cada transición con actor sistema | Los adelantos ×N corren sin intervención |

## 2026-07-13 — Auditoría (UI del módulo admin)

| Decisión | Motivo |
|---|---|
| La API de auditoría es **solo lectura** (`GET /audit-logs`, `GET /audit-logs/facets`): las entradas las escriben los servicios que actúan, nunca el cliente | Integridad del rastro: un log que se puede editar por HTTP no es auditoría |
| Los filtros `from`/`to` interpretan **días calendario en `business_timezone`** (predicados sargables que conservan el índice de `created_at`) | Consistente con los vencimientos a las 00:00 locales; "hoy" significa lo mismo en toda la app |
| `/facets` deriva eventos, entidades y actores **realmente presentes** en el log | Sin catálogos duplicados en el frontend que se desincronicen al añadir eventos |
| Cada entrada resuelve el afiliado afectado (`entity_id` o `data->>'driverId'`) para enlazar al perfil | La auditoría se navega por personas, no por uuids |
| `SettingsRepository.get(key, fallback)` como lectura compartida de configuración | Tercer consumidor de `business_timezone`; se elimina la duplicación futura |

## 2026-07-13 — Cobertura total de auditoría + dashboard real

| Decisión | Motivo |
|---|---|
| **Todos los módulos auditan** (catálogos, membresía, tarifas, administradores, settings) vía el helper compartido `writeAudit` (`modules/audit-logs/audit-writer.ts`); el scheduler y afiliados se refactorizaron al mismo helper | Se decidió ANTES del dashboard para que el feed de actividad nazca completo; una sola ruta de escritura al log |
| El versionado condicional emite eventos distintos: `*.updated` (in place) vs `*.versioned` (réplica con `previousId`) | El log distingue una edición simple de una nueva versión con suscriptores |
| `admin.password_changed` no registra la contraseña ni su hash | El evento en sí es el rastro; jamás material sensible en `data` |
| "Por vencer" (dashboard **y** badge del listado) = **cobertura pagada** (`max(period_end)` de pagos `paid`, adelantos incluidos) ≤ `payment_reminder_days`. Un chofer con adelantos vigentes NO está "por vencer" | Decisión de Luis: el aviso mide quién necesita pagar de verdad; un mismo criterio en toda la app |
| "Facturación de la semana" = **últimos 7 días móviles** (anuladas excluidas), no semana calendario | Sin ambigüedad de "cuándo empieza la semana"; un lunes por la mañana no muestra $0 |
| El feed de actividad del panel **reutiliza `GET /audit-logs`** (no hay endpoint de feed propio) | Una sola fuente para la actividad; el dashboard solo agrega números |

## 2026-07-13 — Documentos (vista global)

| Decisión | Motivo |
|---|---|
| El documento vencido **alerta pero NO bloquea** la operación del chofer | Es lo contemplado por el diseño v7; bloquear sería una regla de negocio nueva (pendiente de decidir si se quiere) |
| Scheduler **propio** (`document-scheduler`, tick 60 s + boot) que marca `expired` al pasar la fecha — medianoche en `business_timezone` — y audita con actor sistema (`document.expired` con `driverId` resuelto, incluso para documentos de vehículo) | SoC: el ciclo de tarifas y el de documentos son responsabilidades distintas; mismo principio de medianoche local que los períodos |
| Ventana de aviso de documentos = **30 días fijos** en el panel (query `expiringDays` la parametriza); no es una clave de `app_settings` | Es una preferencia de UI, no una regla de negocio; evita una migración innecesaria |
| `GET /documents` resuelve el dueño vía `COALESCE(doc.driver_id, vehículo→driver_id)` | El constraint físico garantiza exactamente un dueño; la pantalla siempre enlaza a un afiliado |

## 2026-07-13 — Historiales de facturas y pagos

| Decisión | Motivo |
|---|---|
| **Vista `v_driver_payments`** (migración `1752210000000`): une `membership_payments` y `subscription_payments` con forma común (`kind`, `concept` = nombre de la versión pagada, período solo en tarifas) | Un solo read model para historiales por afiliado y globales; sin duplicar UNION en cada consulta |
| Módulo `billing` **sin capa service** (routes → repository), expone `GET /invoices` y `GET /payments` | Solo lectura sin reglas de negocio ni settings: una capa de paso vacía es ceremonia (mismo precedente que settings) |
| Historial por afiliado = los mismos endpoints con `driverId` (el perfil enlaza a `/billing?driverId=…`) | Sin endpoints paralelos por afiliado que dupliquen filtros y paginación |

## 2026-07-13 — Capacitaciones (cierre del módulo admin)

| Decisión | Motivo |
|---|---|
| Las capacitaciones se **cancelan, nunca se borran** (sin endpoint DELETE); `training_attendees` con FK RESTRICT | El historial de formación del afiliado es un activo del gremio |
| Solo se inscriben afiliados **aprobados** | Un pendiente/rechazado/suspendido no es miembro operativo |
| Control de cupo **atómico** (el INSERT re-verifica el cupo en la misma sentencia) + UNIQUE `(training_id, driver_id)`; reinscribir a un cancelado reutiliza la fila | Dos admins inscribiendo a la vez no pueden sobrevender; sin filas duplicadas por chofer |
| El cupo de una programada no puede editarse por debajo de los inscritos actuales | Evita cupos negativos fantasma |
| La **asistencia** puede marcarse también después de completar la capacitación | El registro de asistencia suele asentarse al final o al día siguiente |
| `registered_by` nullable | NULL = autoinscripción desde la app del chofer (futuro) |

## 2026-07-15 — Storage, configuración y cambio de tarifa

| Decisión | Motivo |
|---|---|
| **Supabase Storage** para los archivos, detrás de una interfaz `StorageProvider` (`src/storage/`) | Con el volumen real (~6 GB en años) el costo es irrelevante en cualquier proveedor; pesa más no sumar una cuenta extra, y el Pro de $25 que se pagará por la BD ya incluye 100 GB. La interfaz deja migrar a R2/S3 escribiendo una clase y cambiando configuración (evaluado 2026-07-15: R2 gana solo si el egreso escala — no es el caso) |
| Los archivos **nunca** se guardan en la BD; Postgres guarda la referencia (`file_url`) | 500 MB de BD en el plan Free, backups inflados y el pooler de 15 sesiones sirviendo binarios |
| Bucket **privado**, subida **siempre vía backend** (multipart) y lectura con **URL firmada de 60 s** | Misma regla de oro que con la BD: ningún cliente toca al proveedor; nada queda público |
| El tipo se valida por **magic number** (contenido real), no por extensión ni `Content-Type`; la ruta la deriva el servidor (`driverId/documentId.ext`) | Un `.exe` renombrado a `.pdf` no entra (verificado); el cliente no elige dónde escribe |
| Doble límite (10 MB y MIME) en **backend y bucket** | Defensa en profundidad: si mañana otro servicio sube, el bucket sigue acotando |
| Sin SDK de Supabase: REST + `fetch` nativo | El cliente oficial arrastra auth/realtime/postgrest para 3 llamadas; mismo criterio que usar `pg` sin ORM |
| Storage **opcional**: sin claves el backend arranca y solo las subidas dan 503 | Un entorno sin storage (tests/CI) no debe impedir levantar la API |
| **Cambio de tarifa al renovar** (opción B del diseño v5): con cobertura pagada la nueva queda `scheduled` y arranca al agotarla (adelantos honrados, nunca reembolsados); sin cobertura arranca ya | Los índices únicos parciales (una activa + una programada) existían para esto |
| Nuevo paso del scheduler: activa la tarifa programada cuando empieza su período pagado (solo choferes **aprobados** — los del wizard también están `scheduled`) | El cambio corre solo, sin intervención del admin |
| Con un cambio programado se **bloquea** renovar o programar otro (409) | Pagar más períodos solaparía la cobertura que ya tiene dueño |
| Salida: `POST /subscription/cancel-change` reembolsa sus períodos y anula sus facturas | Un cambio mal programado necesita reversa con rastro, no un borrado |
| La suscripción "titular" del perfil/listado se elige por **prioridad de estado** (activa > vencida > programada), no por la más reciente | Con un cambio programado la más reciente no es la que rige hoy: el badge diría "Programada" mientras el chofer opera (bug detectado en verificación) |
| Ventana de aviso de documentos y **pantalla de Configuración**: las claves nacen en migraciones, la UI solo edita su valor (con tipo validado) | Ya estaba decidido que las claves no se crean por API |

## 2026-07-16 — Ajustes de UI por feedback del negocio

| Decisión | Motivo |
|---|---|
| **Beneficios deja de ser sección propia**: su catálogo (CRUD completo) se incrusta en la pantalla **Membresía** como componente hijo; ruta `/benefits` y su ítem del menú eliminados. El backend NO cambia (`/benefits` y `/memberships` siguen siendo recursos separados) | Feedback del negocio: un beneficio solo existe para ser otorgado por la membresía. La fusión es de UI (composición), no de módulos — fusionar recursos REST rompería SoC sin ganancia |
| Tarifas: **período fijo en Semanal y tipos de vehículo fijos en "todos"** al crear — campos visibles pero bloqueados ("fijo por ahora"). Solo en la **UI**: la API sigue aceptando el rango completo | Decisión de negocio temporal y reversible sin tocar backend |
| Con los 3 tipos marcados se envía `allowedVehicleTypeIds: null` ("todos"), no `[1,2,3]` | Si mañana se agrega un 4º tipo de vehículo, la tarifa lo cubre; una lista congelada lo excluiría |
| Al **editar** un plan existente los campos bloqueados muestran y conservan sus valores reales (ej. "Tarifa Mensual Motos" sigue mensual/solo motos) | Forzar Semanal/todos al editar reescribiría silenciosamente un plan con suscriptores (con versionado condicional crearía una versión corrupta) |
| `cursor: pointer` global en capa base de `styles.css` para botones, roles button, selects y checkboxes habilitados; `not-allowed` en deshabilitados | Tailwind 4 eliminó el default de v3; regla única en vez de parchear cada componente |

## 2026-07-16 — Datos personales reales + credenciales de la app del chofer

| Decisión | Motivo |
|---|---|
| Nombre **estructurado** en `users`: `first_name`/`last_name` obligatorios, `middle_name`/`second_last_name` opcionales. **`full_name` se conserva** y lo compone el backend en cada escritura | Todos los listados, auditoría, facturas y documentos lo consumen — cero consultas tocadas |
| `birth_date` (backend exige **≥18 años**) y `address` nuevas; opcionales por panel, coherente con "nada bloquea al registrar por panel" | La obligatoriedad dura pertenece al registro desde la app |
| Cédula canónica **`V-12345678`** en la columna `national_id` existente (select V/E + número solo en UI); teléfono canónico **E.164** (`+58…`, select de país 🇻🇪 bloqueado a Venezuela por ahora) en la columna `phone` | Formatos, no esquema: sin migración extra, la búsqueda existente sigue funcionando |
| **Login de la app del chofer = cédula + contraseña**, hash argon2id en `users.password_hash` (NULL = sin acceso aún). Auth propio, como los admins; Supabase Auth sigue pospuesta (`auth_user_id` queda para migrar) | Coherente con la arquitectura "backend propio"; el wizard ya deja al chofer listo para entrar cuando la app exista |
| La contraseña **exige cédula** (es el usuario) y política mínima (≥8, letras y números); vacía al editar = se conserva. El hash jamás viaja: la API expone solo `hasAppPassword` | Sin credenciales huérfanas ni material sensible en respuestas/auditoría |
| Datos de prueba **borrados por completo** (autorizado por Luis, pre-producción) y `invoice_number_seq` reiniciada en 1; afiliado semilla nuevo: Pedro José Pérez González (V-12345678, aprobado, factura #1) | Evitó el backfill de nombres y deja un dataset limpio con el modelo nuevo |
| Documento de identidad: tipos **V** (venezolano), **E** (extranjero) y **J** (jurídico/RIF) | Faltaba J: hay afiliados que operan como persona jurídica |

## 2026-07-16 — Formularios: validación visible y select propio (tras !DEEP-DEBUG)

| Decisión | Motivo |
|---|---|
| **Regla global** en `styles.css`: `.ng-invalid.ng-touched` pinta borde/fondo rojo en `input`/`select`/`textarea` | Diagnóstico: Angular añade `novalidate` a todo `<form>` con `FormsModule`, así que los `required` **nunca** avisan por sí solos y ninguna pantalla del panel leía la validez (0 usos de `ngForm`/`invalid` en todo el frontend). Una regla arregla el feedback de todos los formularios, presentes y futuros |
| `#form="ngForm"` + `markAllAsTouched()` al enviar (wizard y edición del perfil) + mensajes inline bajo cada campo obligatorio | El submit ya validaba (3 capas: `composePerson`, JSON Schema, service) pero el usuario no veía nada |
| El error del paso 1 se muestra **junto al botón**, no en el banner superior | Causa real del "no valida": el formulario es más alto que la pantalla y el banner quedaba fuera de vista |
| **Componente propio `shared/components/select`** (botón + panel Tailwind, `ControlValueAccessor`, teclado ↑↓/Home/End/Enter/Esc, ARIA listbox, cierre por click fuera) sustituye a los `<select>` nativos de documento y país | Un `<select>` nativo solo deja estilizar su estado cerrado: la flecha y el panel los dibuja el SO y no siguen la marca EDV (de ahí el "V⌄" encimado). Primer componente real de `shared/components/`, que estaba vacío |
| **Datepicker custom pospuesto** al rediseño; por ahora solo se armoniza el trigger (alto/tipografía) manteniendo el calendario nativo | Es el control más caro de hacer bien (calendario, teclado, a11y) y su lugar natural es el rediseño visual completo |
| **Componente `shared/components/password-input`** (ojo mostrar/ocultar, `ControlValueAccessor`) usado en el wizard, el perfil y el login | El toggle iba a repetirse en 5+ campos; escribir una contraseña a ciegas es la fuente típica de errores de tipeo |
| Altura única de campo (`h-[42px]`, `text-sm`) y `gap-x-6 gap-y-5` en el formulario; labels de **una sola línea** | Los inputs se desalineaban porque un label largo ("Documento de identidad (opcional por panel)") saltaba a dos líneas y empujaba su campo |

## 2026-07-16 — Wizard de afiliado: navegación libre y guardado incremental

| Decisión | Motivo |
|---|---|
| El paso 1 **crea la primera vez y actualiza después** (`POST` o `PATCH` según exista `driverId`) | 🐛 **Bug corregido**: con la navegación libre, volver al paso 1 y guardar habría creado un **afiliado duplicado** (antes siempre llamaba a `create`) |
| **Navegación libre** por el stepper (botones), habilitada solo cuando el afiliado ya existe; pasos 2–4 opcionales | Petición del negocio: el registro no siempre se completa de una sentada. El paso 1 es el mínimo para generar el registro |
| Botones **"Guardar"** y "Guardar y continuar" en el paso 1; el paso 4 ofrece "Registrar y facturar" o **"Finalizar sin pagos"** | Nada se pierde al moverse; el afiliado sin pagos queda `pending` (la aprobación ya exige los pagos) |
| Tras guardar, los campos de contraseña se **vacían** (vacío = conservar la actual) | Evita reenviar y re-hashear la contraseña en cada guardado posterior |
| **Directiva validadora `appPasswordPolicy`** (≥8, letra, número) + checklist de requisitos en vivo bajo el campo | Diagnóstico: la política **sí** bloqueaba (verificado en BD: ningún afiliado se creó con "123456"), pero el campo no avisaba al escribir y el mensaje quedaba lejos. Ahora el control se marca inválido solo y el submit se bloquea sin depender de `composePerson` |
| La regla CSS global se extiende a los controles propios (`app-password-input`/`app-select`), que llevan `ng-*` en su host | Sin esto, un componente inválido no se pintaría de rojo |

## 2026-07-16 — ⚠️ Cambio de regla: documento y contraseña obligatorios por panel

| Decisión | Motivo |
|---|---|
| **La contraseña de la app es obligatoria** al registrar por panel, y **por consecuencia el documento también** — esto **sustituye** la decisión del 2026-07-10 ("cédula opcional por panel") | Pedido del negocio: todo afiliado registrado debe quedar listo para entrar a la app. El documento **es** el usuario: sin él la contraseña no abre nada y el backend ya devolvía 400 — dejarlo opcional garantizaba el error en cada registro sin documento |
| Política de la contraseña del chofer: **mínimo 6 caracteres, solo números permitido** (antes 8 + letra + número) | Decisión del negocio (tipo PIN). Protege la app del chofer, no el panel: la contraseña de los **admins** conserva su mínimo de 10 |
| Al **editar** el perfil la contraseña sigue siendo opcional (vacía = conservar la actual) | Nadie debe reescribir la contraseña del chofer para corregirle el teléfono |
| La API mantiene `password` y `nationalId` opcionales; la obligatoriedad la impone el cliente del panel | El registro desde la app (futuro) definirá su propio flujo sin reabrir el contrato |
| Wizard: **"Guardar" se deshabilita cuando no hay cambios** y "Continuar" solo navega (se habilita al guardar) | Los botones alternan según el estado: siempre hay una sola acción obvia |
| Paso 3: fuera el botón "Saltar" (el stepper ya permite moverse), el principal pasa a **"Registrar"** y se añade "Continuar →" | El vehículo es opcional: continuar nunca debe exigirlo |

## 2026-07-16 — 📋 Propuesta en discusión: tarifas con deuda y penalización

> No es una decisión cerrada: es un modelo pedido por la dueña que **cambia el patrón de
> tarifas en producción**. Documento completo (con imágenes para el cliente) en
> [../proposals/tarifa-penalizacion/README.md](../proposals/tarifa-penalizacion/README.md).

| Punto | Estado |
|---|---|
| Cobro por adelantado, día único para todos; tope de **2 semanas de deuda** trabajando | Definido en la propuesta |
| Suspensión al superar el tope; deuda **congelada** en 2 semanas; pierde beneficios | Definido |
| Reactivación: pagar **4 semanas** (2 deuda + 1 penalización + 1 adelantada); auto al lunes o manual inmediata | Definido |
| Reincidencia → suspensión definitiva **a criterio del admin** (externo a la app) | Definido |
| **Pausa voluntaria** (cobro, límite, beneficios) · **membresía del expulsado** · hora exacta de cobro | ⏳ **Preguntas abiertas** |
| Estado de implementación | ❌ **No implementado**. El sistema actual usa suspensión inmediata sin deuda. Requiere diseño v8 + análisis de impacto |

## 2026-07-21 — Registro de afiliado transaccional (wizard) + gestión de flota/documentos también desde el perfil

> Ejecución de la tarea aprobada en [../proposals/registro-2-pasos/README.md](../proposals/registro-2-pasos/README.md).

| Decisión | Motivo |
|---|---|
| **Nuevo `POST /drivers/register`**: crea `users` + `drivers` + (opcional) vehículos + metadatos de documentos + (si viene `payment`) membresía + tarifa (adelanto ×N y facturas), **todo en una sola transacción**. Sin `payment` el afiliado queda `pending` | El registro deja de persistir de forma incremental: el afiliado nace de un único envío al botón final. Si algo falla, no queda afiliado, vehículo ni factura huérfanos (verificado E2E) |
| **Transacción compartida** vía helper `withTransaction(pool, fn)` (`src/db/tx.ts`): `insertUserAndDriver`, `insertVehicle`, `insertDocument` y `EnrollmentRepository.enrollOnClient` operan sobre el **mismo `client`**; `createWithUser`/`enroll` quedan como envolturas de un solo paso | La atomicidad real exige un único unit-of-work; antes cada repo abría su propia transacción. El SQL sigue viviendo en los repositorios |
| El afiliado registrado por `/register` nace con `registration_step = NULL` | El wizard es transaccional: no hay paso intermedio que retomar |
| **`POST /drivers` (person-only) y `PATCH /drivers/:id` se conservan** para edición desde el perfil; el panel ya no usa `POST /drivers` como puerta del wizard | Compatibilidad sin romper contratos; evita reescrituras |
| **Documentos y vehículo permanecen como pasos del wizard** (petición de negocio, no reversible por el equipo): se **acumulan en el cliente** y se persisten en la misma transacción del alta. Los **archivos** de documentos se suben **después** del registro contra los ids devueltos (`createdDocumentIds`), best-effort — un documento puede existir sin archivo, igual que en el perfil | Al no llevar archivos en el cuerpo JSON, el multipart deja de bloquear el "registrar solo al final": los metadatos entran en la transacción y el binario se adjunta en una segunda fase tolerante a fallos (los que fallen se adjuntan luego desde el perfil) |
| Documentos del alta = **solo requerimientos de chofer** (`applies_to='driver'`), validados antes de la transacción; los documentos de vehículo se gestionan desde el perfil | Igual que el wizard original; la obligatoriedad de requerimientos solo aplica al registro desde la app, así que no se rompe ninguna regla |
| **Gestión de flota y documentos también desde el perfil** (`driver-detail`): botones "+ Agregar" que reutilizan `POST /drivers/:id/vehicles` y `POST /drivers/:id/documents` + subida de archivo | Son **datos vivos** (vencen, se renuevan, se reemplazan): la gestión continua vive en el perfil, y el alta captura los que ya se tengan a mano |
| Wizard de **4 pasos** (`Datos → Documentos → Vehículo → Pago`) + resumen; eliminado el interruptor temporal `devUnlockSteps` | La navegación entre pasos es libre tras validar los datos; nada se persiste antes del submit final |
| Pendiente (fuera de alcance, **gap preexistente**): no hay acción en el perfil para cobrar membresía + tarifa a un afiliado `pending` **registrado sin pago**. El endpoint `POST /drivers/:id/enroll` sigue disponible para exponerlo cuando el negocio lo decida | Un afiliado sin pagos no puede aprobarse (la aprobación exige pagos); hoy el cobro solo ocurre en el alta. Decisión de UI pendiente |

## 2026-07-23 — 📋 Rediseño del estado del chofer (modelo cerrado, dividido en fases)

> Pedido de Luis, **cerrado el mismo día** tras discusión de diseño. Espec autoritativa en
> [../proposals/estados-del-chofer/README.md](../proposals/estados-del-chofer/README.md).
> **No implementado**: Fase A ejecutable ya; Fase B ligada al motor de deuda/penalización.
> ⚠️ **Reemplaza la versión preliminar de esta misma fecha** (en la que `paused` era voluntario
> del chofer y `approved` un transitorio interno que saltaba a `active`).

| Decisión | Motivo |
|---|---|
| **Un enum `driver_status` + el boolean `is_available` existente** (no tres columnas ni un enum "todo en uno"). El enum lleva la *situación* (administrativa + deuda, mutuamente excluyentes); `is_available` lleva la *disponibilidad* voluntaria (ortogonal, coexiste con la situación) | Cierra la pregunta "¿enum unificado o derivado?": los estados de deuda **reemplazan** temporalmente a `approved`; `active`/`inactive` **coexiste** (un chofer puede ser `overdue` **e** `inactive`) |
| **Clasificación por origen de escritura**: administrativo (admin/sistema: `pending`, `approved`, `rejected`, `paused`, `suspended`), deuda (motor automático, nunca a mano: `overdue`, `penalized`), disponibilidad (el chofer desde su app: `active`/`inactive`) | Define quién puede transicionar cada estado (base de la matriz de permisos y la máquina de estados) |
| **`approved` NO es interno ni transitorio**: es el estado sano en reposo, badge visible propio (igual trato que Pendiente/Rechazado/Suspendido). `approved` ≠ `inactive` (ejes distintos, no se mezclan) | "Aprobado" = el admin certificó requisitos de ingreso + pagos; es un hecho administrativo, no la disponibilidad voluntaria del chofer |
| **`paused` es administrativo** (lo pone el admin, no el chofer): exige **deuda 0**, es **infinito** (el admin lo levanta por acuerdo), **congela la tarifa**, y al levantarlo el reloj **se reancla al lunes 00:00** y vuelve a `approved` + `active` | Cubre la licencia real (vacaciones / médica); es el único camino para dejar de acumular deuda |
| **`active`/`inactive`** es el toggle voluntario del chofer (boolean `is_available`, ya existe), **default `active`**, y **NO congela la tarifa**: un chofer inactivo sigue acumulando deuda y puede caer en `overdue`/`penalized` | La cuota es por ser miembro, no por viaje; `inactive` solo evita recibir viajes |
| **`overdue`/`penalized` nunca se escriben a mano**: los deriva el **motor de deuda** (`subscription-scheduler`). El override por acuerdo externo se modela como **pago externo** (reutiliza `enroll`/`renew`, emite recibo) → la deuda queda en 0 y el motor deja de marcar | Una sola fuente de verdad (la deuda); sin overrides que el scheduler pise en el siguiente tick; el dinero se registra con rastro (regla de oro #7) |
| **División en fases**: Fase A (enum + `paused`, endpoints de pausa, badges, indicador de disponibilidad) **ejecutable ya**; Fase B (`overdue`/`penalized` + motor + pago externo) **depende** de [tarifa-penalizacion](../proposals/tarifa-penalizacion/README.md) | El plano de deuda nace de esa propuesta; el plano administrativo y el `is_available` existente no |
| Migración **sin backfill**: `approved` sigue siendo `approved`; solo se **añaden** valores al enum (`ALTER TYPE ... ADD VALUE` incremental) | Añadir valores no toca las filas existentes; requiere regenerar modelos + `npm run typecheck` |

## 2026-07-23 — ✅ Estado del chofer: Fase A implementada (pausa administrativa)

> Ejecución de la Fase A de la espec
> [../proposals/estados-del-chofer/README.md](../proposals/estados-del-chofer/README.md).
> Migración `1752250000000_driver-paused-state` (typecheck backend + build frontend limpios).
> **Fase B** (`overdue`/`penalized` + motor de deuda + pago externo) sigue **pendiente**,
> ligada a la propuesta de [tarifa-penalización](../proposals/tarifa-penalizacion/README.md).

| Decisión | Motivo |
|---|---|
| La migración **añade `paused`** al enum `driver_status` (`ADD VALUE IF NOT EXISTS`, atómica en PG15), cambia el default de `is_available` a `true` (+ backfill de los `approved` existentes) y añade la columna **`paused_at`** | Fase A no arrastra `overdue`/`penalized` (Fase B); `approved` intacto; `paused_at` es el ancla para descongelar la tarifa al reanudar |
| **`paused` lo escriben endpoints dedicados** `POST /drivers/:id/pause` y `/resume`, **no** el PATCH genérico de estado | Pausar lleva reglas (exige `approved` + tarifa `active` al día) y congelamiento de tarifa: no es un `UPDATE status` a pelo como suspender/reactivar |
| El **congelamiento** lo aplica el `subscription-scheduler`: salta a los `paused` en los pasos de avanzar/expirar (un `NOT EXISTS` sobre `drivers.status = 'paused'`). Al reanudar, `EnrollmentRepository.resume` desplaza las ventanas de período no consumidas por el lapso `now() - paused_at` | Un chofer en licencia no debe vencer ni consumir adelantos; al volver conserva la cobertura restante |
| **Reanudación simple (ventana móvil)**: el reanclaje exacto "al lunes 00:00" se **difiere a Fase B** (depende del modelo semanal de tarifa-penalización) | Retrabajo acotado a la función `resume`; evita implementar dos veces la mecánica de tarifa |
| Aprobar deja `is_available = true`; el frontend muestra el badge **`Pausado`** (azul) en lista/perfil/filtro y un **indicador de disponibilidad** `Activo`/`Inactivo` desde `is_available` en la tarjeta de estado del perfil | El plano de disponibilidad queda listo aunque sea inerte hasta que exista la app del chofer (nadie apaga el toggle todavía) |

**Cabos cerrados tras revisión de completitud** (verificados E2E):

| Decisión | Motivo |
|---|---|
| **Capacitaciones admiten `paused`**: un chofer en licencia puede inscribirse (antes el check era `status === 'approved'`) | Un pausado sigue siendo miembro; la licencia es temporal y una capacitación suele ser a futuro (criterio de Luis) |
| **Dashboard cuenta los `paused`** con indicador propio "En pausa" (no agrupado con suspendidos) | Un pausado no es ni aprobado ni suspendido: sin esto desaparecía de todos los conteos |
| Salir de `paused` por el `PATCH` genérico (`paused → suspended`) **limpia `paused_at`** | El PATCH solo fija `approved`/`suspended`; dejar `paused_at` con valor era un ancla huérfana (dato sucio, sin efecto funcional pero incorrecto) |
| **No se borran datos de prueba** (facturas del E2E en el afiliado semilla) hasta terminar el desarrollo, salvo que estén dañados | Decisión de Luis: evitar borrados innecesarios; las facturas de prueba son válidas, solo sobran |

## 2026-07-23 — 🔧 Motor de deuda (v8) — B1: infraestructura (aditiva, sin cambiar el cobro)

> Primer paso de la **Fase B**. Análisis:
> [../proposals/tarifa-penalizacion/analisis-impacto-v8.md](../proposals/tarifa-penalizacion/analisis-impacto-v8.md).
> Migración `1752260000000`. El motor real (B2) que cambia el cobro en producción está **pendiente**.

| Decisión | Motivo |
|---|---|
| Migración **aditiva y reversible**: añade `overdue`/`penalized` al enum `driver_status` y 6 claves de `app_settings` del motor con valores seed, **sin tocar la lógica de cobro** | Avanzar la Fase B sin comprometer producción ni "cerrar" el modelo (Luis pidió no cerrarlo: puede cambiar). Los enum values ya eran del modelo de estados cerrado; las claves son reversibles |
| Las claves nacen marcadas **"en preparación — sin efecto hasta B2"** en su descripción | `settings.list` las devuelve todas (aparecen en Configuración); la nota evita que un admin espere efecto antes de que exista el motor |
| Valores seed = inclinaciones de Luis: `debt_cap_weeks=2`, `penalty_weeks=1`, `billing_day_of_week=5` (viernes), `billing_hour=18`, `week_anchor_day=1` (lunes), `reactivation_mode="auto"` | Solo semanal, Mensual Motos en prepago, membresía del expulsado congelada; todo editable, **nada cerrado formalmente** |

## 2026-07-23 — ⚙️ Motor de deuda (v8) — B2: emisión semanal, mora y derivación del estado

> `src/plugins/debt-scheduler.ts` + migración `1752270000000`. **Apagado por defecto**
> (`debt_engine_enabled = false`): el cobro en producción no cambia. Verificado E2E.

| Decisión | Motivo |
|---|---|
| **Interruptor maestro `debt_engine_enabled` (false)**: el motor lee la clave en cada tick y no hace nada mientras esté apagada | Permite escribir, desplegar y probar lógica de **dinero** sin alterar el cobro; encenderlo es una decisión de negocio, no un despliegue |
| El cargo semanal se emite como `subscription_payments` **`pending` SIN factura**; la factura se emite **al cobrar** (flujo existente) | Una factura es el comprobante de **dinero recibido** (facturación uniforme, v7). Un cargo por cobrar no es una factura: emitirla al cargar rompería ese invariante |
| La **deuda se deriva** de las filas `overdue` (nunca un contador): 0 = `approved`, 1..`debt_cap_weeks` = `overdue`, > tope = `penalized` | Una sola fuente de verdad (las filas de pago, que son la verdad contable); evita el antipatrón de estado duplicado que ya rechazamos en el rediseño de estados |
| El **penalizado no recibe cargos nuevos** (la emisión filtra `approved`/`overdue`) | Implementa "la deuda queda congelada en el tope" del modelo de negocio, sin lógica extra |
| **Alcance: solo planes `weekly`**; mientras el motor esté activo el `subscription-scheduler` **deja de expirar** las semanales | Las demás periodicidades siguen en prepago (Mensual Motos); sin esto, los dos modelos competirían por la misma suscripción |
| Se exporta **`runDebtEngineTick`** (la pasada del motor) además del plugin | Testabilidad: permite ejercitar el ciclo completo sin esperar el timer de 60 s (así se verificó E2E) |
| El frontend ya mapea `overdue`/`penalized` (badges ámbar/rojo, filtros, tarjeta de estado; el indicador de disponibilidad también aplica a `overdue`, que sí opera) | Encender el flag no debe dejar el panel mostrando estados en blanco |

## 2026-07-23 — 💸 Motor de deuda (v8) — B3: multa, reactivación y pago externo

> Migración `1752280000000` + endpoints `POST /drivers/:id/external-payment` y `/reactivate`.
> Sigue **apagado** (`debt_engine_enabled = false`). Verificado E2E (ciclo completo).

| Decisión | Motivo |
|---|---|
| **`subscription_payments.charge_kind`** (`period` \| `penalty`) y la vista `v_driver_payments` muestra la multa como **"Penalización"** en vez del nombre del plan | Sin distinguirla, una multa sería indistinguible de una semana de servicio en el rastro del dinero |
| La **multa se emite en la transición** a `penalized` (una por episodio), no a todo penalizado sin multa pendiente | 🐛 **Bug detectado por el E2E**: la versión inicial re-multaba a quien ya había pagado y solo esperaba su reincorporación, devolviéndolo a `overdue` en bucle |
| La multa **cuenta como deuda** (se marca `overdue` como cualquier cargo) | Obliga a pagarla para reactivarse, que es justo lo que pide el modelo (4 semanas = 2 deuda + 1 multa + 1 adelantada) |
| **`drivers.reactivates_at`** + reactivación diferida: al saldar, un `penalized` en modo `auto` **sigue penalizado** hasta el lunes siguiente | Implementa "se reincorpora el lunes aunque pague un miércoles" sin inventar un estado nuevo; la derivación respeta esa fecha |
| **Pago externo** (`/external-payment`): salda **todos** los cargos pendientes en una transacción y emite **una factura** que los agrupa, con `note` de constancia | Es el override acordado: el admin **no fuerza el estado**, registra el dinero (regla de oro #7) y el motor deriva solo. Sin overrides que el scheduler pise |
| **Reactivación manual** (`/reactivate`) exige **deuda 0** (409 si aún debe) | Primero el dinero, después el estado: evita devolver a la calle a alguien que no ha pagado |

## 2026-07-23 — 🐛 Enums vs. pooler: los literales de `driver_status` se comparan como TEXTO

> Incidencia real: tras la migración que añadió `paused`, el `subscription-scheduler` falló en
> bucle con `invalid input value for enum driver_status: "paused"` (code 22P02, routine
> `enum_in`) **aunque la base tenía el valor**. Se reproduce de forma **intermitente**.

| Decisión | Motivo |
|---|---|
| Las comparaciones de `drivers.status` con literales usan **`status::text = '…'`** en schedulers, dashboard y el filtro del listado | **Causa raíz**: conectamos por el **pooler de Supabase**; una conexión de servidor abierta *antes* de un `ALTER TYPE … ADD VALUE` conserva un **catálogo cacheado sin el valor nuevo**, y al parsear el literal falla (`enum_in`) hasta que esa conexión se recicla. Comparar la columna como texto **nunca invoca `enum_in`**, así que es inmune |
| No se toca la parte de **escritura** (`UPDATE … SET status = 'paused'`) | Ahí el enum es obligatorio; son acciones puntuales del admin (no bucles) y un reintento basta. El daño real era el job que fallaba cada 60 s |
| Coste asumido: el cast impide usar un índice sobre `status` | No existe tal índice y las tablas son pequeñas; la robustez pesa más que un plan marginalmente mejor |

## 2026-07-23 — 💳 Métodos de pago (Pieza 1) — catálogo de cuentas donde paga el afiliado

> Pedido de Luis, inspirado en la sección de vnsow (`C:\Project\vnsow`). Migración
> `1752290000000` + módulo `payment-methods` + sección nueva en el panel. **Pieza 2**
> (comprobante + método + referencia en el flujo de cobro, adjunto a la factura) queda pendiente.

| Decisión | Motivo |
|---|---|
| Tabla `payment_methods { name, type (enum), details **jsonb**, is_active }` — un catálogo como los demás (tipos de vehículo, requerimientos) | vnsow usa Mongo (details libre); en Postgres el **jsonb** conserva "campos por tipo" sin columnas rígidas. La forma se valida **por tipo en el service** (`REQUIRED_DETAILS`), no en JSON Schema (que no hace condicional-por-tipo con limpieza) |
| 7 tipos: `bank_transfer`, `pago_movil`, `zelle`, `paypal`, `binance`, `crypto`, `contact` | Todos los de vnsow + **transferencia nacional** y **Pago Móvil** (métodos #1 en Venezuela) por decisión de Luis |
| **Etiqueta libre** (`name`), no autogenerada del tipo como vnsow | Permite **varias cuentas del mismo tipo** (ej. dos bancos) |
| Es un **catálogo informativo, NO una pasarela**: registra las cuentas donde el chofer paga; el cobro y su verificación son manuales | Igual que vnsow (verificación manual); no hay integración con bancos/gateways |
| Storage propio (**Supabase**), no Cloudinary (vnsow) | Ya existe la infra (bucket privado + magic-number + URL firmada); no se suma un proveedor. La imagen del QR de cripto se difiere a la Pieza 2 (que establece la subida genérica) |
| El frontend usa `shared/components/select` para los desplegables (tipo, tipo de cuenta) | Regla del proyecto: nada de `<select>` nativo |
| Validación E2E vía **`app.inject()`** (sin abrir puerto) en `tests/payment-methods.test.ts` | Parte de la red de tests permanente; no colisiona con el dev server (raíz del `EADDRINUSE` anterior) |

## 2026-07-23 — 🧾 Comprobante + método + referencia al cobrar (Pieza 2)

> Migración `1752300000000` (columnas en `invoices`) + endpoints de comprobante en billing +
> captura en los modales de cobro. Verificado E2E (`tests/invoice-payment.test.ts`).

| Decisión | Motivo |
|---|---|
| Los datos de pago (`payment_method_id`, `payment_reference`, `payer_bank`, `proof_url`) van en **`invoices`**, no en una tabla nueva | La factura **es** el documento de dinero del cobro; el monto y la fecha ya viven ahí. Todo aditivo y opcional |
| El cobro (enroll/register/pago externo) **estampa los metadatos en la factura primaria** (la #1) y devuelve **`primaryInvoiceId`**; el comprobante se sube **después** contra ese id (multipart) | Mismo patrón que documentos: los metadatos entran en la transacción, el binario en una segunda fase. Un adelanto ×N tiene varias facturas pero **un** comprobante (en la #1) |
| El comprobante reutiliza **Supabase Storage** (bucket privado + magic-number + URL firmada 60 s), **no Cloudinary** (vnsow) | Ya existe la infraestructura de documentos; `sniffMimeType` se **extrajo a `storage-provider`** para compartirlo entre documentos y comprobantes |
| **Comprobante ≠ factura**: el comprobante es la prueba del **pagador** (captura de la transferencia); se adjunta como evidencia, no reemplaza la factura interna | Son dos documentos distintos; evita confundir el recibo de la empresa con la prueba del chofer |
| Lo sube el **admin** (no el chofer): el chofer manda la captura por WhatsApp y el admin la adjunta al registrar el pago | La app del chofer no existe aún; cuando exista, se le pasa sin rehacer el modelo |
| Frontend: los modales de **enroll** y **pago externo** capturan método (select de activos) + referencia + banco emisor (select de bancos) + archivo; **Facturación** muestra método/referencia y **"Ver comprobante"** (URL firmada) | Cierra el ciclo capturar→ver. El bloque de captura es un `ng-template` reutilizado en ambos modales |
| **Pendiente**: la **imagen QR** de cripto en Métodos de pago (Pieza 1) sigue diferida (la renovación ya captura el pago — ver 2026-07-24) | Acotar el alcance; es una extensión trivial sobre lo ya construido |

## 2026-07-23 — 🧾 Tarifa única, cobro post-registro y detalle del afiliado enriquecido

> Pedido de Luis: una sola tarifa (la semanal); poder cobrar a un afiliado registrado sin pago;
> ver membresía/beneficios/suscripción/deuda en el perfil. Verificado E2E (crear sin pago →
> enroll → aprobar → limpieza total).

| Decisión | Motivo |
|---|---|
| **Tarifa Mensual Motos eliminada** (borrado directo de la fila; tenía 0 suscriptores y 0 pagos) con guarda de seguridad | El modelo pasa a **una sola tarifa (semanal)**; archivada seguía apareciendo en la lista y confundía. Un plan con dinero jamás se borra — este no tenía |
| **Cobro post-registro expuesto en la UI**: botón "Registrar pago" en el perfil cuando el afiliado no tiene membresía → reutiliza el endpoint `POST /drivers/:id/enroll` (membresía + tarifa, adelanto ×N) | 🐛 **Flujo roto de raíz**: un afiliado registrado sin pago no se podía aprobar (la aprobación exige pagos) y **no había ninguna acción para cobrarle**. El endpoint existía desde el registro transaccional pero nunca se expuso |
| El detalle (`GET /drivers/:id`) ahora devuelve **`benefits`** (de la versión de membresía pagada), **`debt`** (cargos `pending`/`overdue` del motor v8: total, semanas, penalización, lista) y `priceUsd`/`startedAt` de la suscripción | La sección de datos del afiliado estaba pobre respecto a dinero: no mostraba beneficios ni deuda. La deuda es **solo lectura** (se salda por renovación o pago externo, nunca se registra a mano — decisión de Luis) |
| **Sección "Deuda pendiente"** en el perfil (cargos + total + acción de pago externo), visible solo si hay cargos | Unifica ver+cobrar la deuda que genera el motor; absorbe parte del B4 |
| Los campos de dinero nuevos se castean a **`::text`** en el SQL (string decimal) | 🐛 Cazado por el E2E: `json_build_object` serializa `numeric` como número JSON, rompiendo la convención "dinero como string". El cast lo alinea con el resto de la API y con los tipos del frontend |

## 2026-07-24 — 🧾 Refinamiento del modal de cobro (Pieza 2, solo frontend)

> Ajuste de UI sobre el bloque `paymentCapture` reutilizado por los modales de registro de pago
> y pago externo. **Sin cambios de API ni de BD.**

| Decisión | Motivo |
|---|---|
| Al elegir un método, el modal muestra debajo los **datos de la cuenta** (banco, cédula/RIF, teléfono, titular… según el tipo, con etiquetas legibles y los `select` resueltos a texto) | El admin debe **verificar** contra qué cuenta pagó el chofer; antes solo veía el nombre del método. Se derivan de `PAYMENT_METHOD_FIELDS`, sin llamadas extra |
| El input de archivo nativo se sustituye por un **dropzone** (área punteada "clic para subir" + tarjeta con nombre y acciones Cambiar/Quitar) | Coherencia con el design system; el input nativo se veía tosco. Es *click-to-upload*, no drag&drop (el input queda oculto) |
| El botón del modal de registro de pago pasa de **"Cobrar" → "Guardar"** | El admin **registra un pago ya recibido**, no ejecuta un cobro: coherente con "verificación manual, no pasarela". El modal de pago externo ya decía "Registrar pago" |

## 2026-07-24 — 📊 Motor de deuda (v8) — B4 (parte dashboard): conteos y alertas de mora

> `GET /dashboard/summary` gana `drivers.overdue` y `drivers.penalized`; el panel los muestra como
> **alertas** condicionales. Solo lectura, aditivo. El motor sigue apagado (hoy ambos 0).

| Decisión | Motivo |
|---|---|
| `overdue`/`penalized` se exponen como **conteos** en el summary (dos subqueries `count` por `status::text`, igual que el resto de estados) | Cierra la parte de dashboard de B4 sin tocar el motor; el cast a `text` evita el rechazo del enum por catálogo cacheado del pooler (mismo patrón ya usado) |
| En el panel se muestran como **alertas** (punto rojo penalizado / ámbar mora), no como stat card | Coherencia con `suspended`/`paused`, que ya son alertas: son estados de "no opera / opera con deuda", no KPIs permanentes. Evita una tarjeta fija en `0/0` con el motor apagado |
| Los avisos aparecen **solo si hay > 0** (patrón `hasAlerts`) | Con el motor apagado no hay morosos, así que no ensucian el panel; al encenderlo aparecen solos |

## 2026-07-24 — 🔒 Motor de deuda (v8) — modelo de negocio CERRADO

> Cierre formal de las decisiones abiertas del análisis de impacto
> ([analisis-impacto-v8 §3](../proposals/tarifa-penalizacion/analisis-impacto-v8.md)). Confirmado
> con Luis. Los valores seed de `app_settings` (B1) ya coincidían; el único cambio frente a la
> recomendación es la membresía del expulsado.

| Decisión | Cierre |
|---|---|
| Alcance | **Solo tarifa semanal** (Mensual Motos ya eliminada) |
| Ventana / cobro | Semana **anclada al lunes 00:00**; emisión **viernes 18:00** (`business_timezone`) |
| Tope de deuda | **2 semanas** operando; a la 3.ª impaga → `penalized` (`debt_cap_weeks = 2`) |
| Penalización | **1 semana** de multa al superar el tope (`penalty_weeks = 1`) |
| Chofer inactivo (voluntario) | **Sigue debiendo**: `is_available = inactive` NO congela la tarifa (coherente con Fase A) |
| Reactivación por defecto | **Lunes siguiente** (`reactivation_mode = auto`); el admin puede forzar inmediata |
| Reincidencia | Expulsión definitiva a **criterio manual** del admin (estado `suspended`), no contador automático |
| Beneficios en suspensión | Se **pierden** durante la suspensión, se **recuperan** al reactivar |
| **Membresía del expulsado definitivo** | **Se pierde**: revoca el estatus de miembro (si regresa, paga de nuevo) y **no se reembolsa**. ⚠️ "Perder" = revocar el beneficio; el pago histórico **no se borra ni se anula** (regla de oro #7 intacta) |

Con esto el modelo v8 queda **cerrado formalmente**. Falta, antes de encender el motor
(`debt_engine_enabled`), el **plan de migración** de las suscripciones `active` vivas al anclaje
semanal y validar el ciclo con reloj real.

## 2026-07-24 — 🧩 Anclaje al lunes en los flujos de cobro (detrás del flag)

> `approve` (enroll)/`renew`/`changePlan`/`resume` anclan los períodos **weekly** a la semana
> lunes-a-lunes **cuando el motor está encendido**; con el flag apagado, comportamiento prepago
> intacto. Es la dependencia de código del
> [plan de migración](../proposals/tarifa-penalizacion/plan-migracion-anclaje.md). Verificado:
> typecheck + 5/5 tests (incluye una prueba de anclaje dedicada).

| Decisión | Motivo |
|---|---|
| El anclaje se activa solo si `debt_engine_enabled` **y** el plan es `weekly` (`anchorWeekly`, calculado en el service) | Cero efecto en producción hoy (motor apagado): código inerte tras el flag, igual que B1–B3. La regla de negocio vive en el service, no en el SQL |
| Convención: semanas **lunes-a-lunes desde el lunes de la semana en curso**, redondeo **a favor del chofer** | Coincide con el guard de idempotencia del motor (`period_start = lunes`) y con el re-anclaje del plan de migración, así el motor reconoce la cobertura y no recobra |
| `resume` con el motor on **re-ancla** al lunes (no hace *shift* por duración de pausa) | El modelo weekly realinea las ventanas a la rejilla semanal, no las desplaza |
| `enroll` no cambia: sus períodos nacen `scheduled` y se anclan en `approve` | El anclaje real ocurre al aprobar; evita duplicar la lógica |

## 2026-07-24 — 🧾 Comprobante también en la renovación / cambio de tarifa (cierre de la Pieza 2)

> `POST /drivers/:id/subscription/renew` gana los datos de pago opcionales (método + referencia +
> banco + comprobante), estampados en la factura primaria como en `enroll` y el pago externo. Cierra
> el único cobro que faltaba. Typecheck + build limpios.

| Decisión | Motivo |
|---|---|
| `renewSubscription` (service) estampa el `paymentMeta` en la **factura primaria** (`invoiceNumbers[0]`) y devuelve `primaryInvoiceId`; aplica también al **cambio de tarifa** | Renovar y cambiar de tarifa son cobros que emiten factura; deben registrar cómo se pagó, igual que el resto. Reutiliza `setInvoicePaymentMeta` (ya genérico) |
| El modal *Renovar tarifa* reutiliza el `ng-template #paymentCapture` y sube el comprobante con `afterCobro` | Mismo patrón que enroll/pago externo; sin código nuevo de captura/subida |

## 2026-07-24 — 🧩 Componente `payment-capture` compartido + captura de pago en el registro

> El bloque de pago (método + datos de cuenta + referencia + banco + comprobante) se extrae a
> `features/drivers/payment-capture` y se reutiliza en el wizard de registro y en los 3 modales de
> cobro del detalle. El registro ahora también captura el pago (el backend ya lo aceptaba). Build limpio.

| Decisión | Motivo |
|---|---|
| El componente vive en **`features/drivers/`**, no en `shared/` | La regla es *"shared sin estado"* y este tiene estado (carga los métodos de pago, valida el archivo). Sus dos consumidores viven en la feature `drivers` |
| Expone el valor por **`[(value)]`** (`PaymentCaptureValue`) y los rechazos de archivo por **`fileError`**; los `ngModel` internos son **standalone** | Un consumidor está dentro de un `<form>` (wizard) y otro no (modales); standalone lo desacopla del form del padre |
| El **registro** (wizard, paso 4) captura método+referencia+banco+comprobante y lo sube best-effort tras el alta | El alta es un cobro que emite facturas, igual que enroll/renovación/pago externo. Cierra los **4 cobros** con el mismo bloque |
| Layout de **2 columnas en web** dentro del componente (método y comprobante a lo ancho; referencia+banco lado a lado) | Reduce la altura del modal/paso; una sola fuente de verdad para el layout |

## 2026-07-24 — 🧾 Historial de pagos por chofer (vista reducida de Facturación)

> Botón *"Historial de pagos"* en la cabecera del detalle → página nueva `/drivers/:id/payments`
> con los pagos del chofer (membresía + tarifa) y el detalle de cada uno (método/referencia/banco/
> comprobante de su factura). Reutiliza los endpoints de Facturación. Build limpio.

| Decisión | Motivo |
|---|---|
| Página propia (`drivers/:id/payments`) enlazada por un **botón** en la cabecera, no una pestaña embebida | Pedido de Luis: un botón que lleva a una sección enfocada al chofer, sin recargar el detalle |
| **Reutiliza** `GET /payments?driverId` + `GET /invoices?driverId` + `invoiceProofUrl` (`BillingApi`), sin endpoints nuevos | Es una vista **reducida** de `/billing`; no se duplica lógica de backend |
| El detalle del pago toma método/referencia/banco/comprobante de la **factura asociada** (`invoiceId`) | Esos datos viven en `invoices` (Pieza 2); el pago solo referencia su factura |
| `/billing` (Facturación global) **se mantiene**; su gráfica mensual podría llevarse al dashboard | Vista global útil; idea futura anotada por Luis |

## 2026-07-24 — 🛡️ Confirmación + loading en acciones importantes de un clic

> Suspender/reactivar, pausar (licencia), reanudar, reactivar (penalizado) y **cerrar sesión** pasan
> por un modal de confirmación (patrón Flowbite Pro) que describe la acción; el botón Confirmar de las
> acciones con backend muestra un **spinner** mientras corre. Build limpio.

| Decisión | Motivo |
|---|---|
| Modal de confirmación **genérico** (`ConfirmDialog` + `runConfirm()` dispatcher) en el detalle del chofer | DRY: una sola pieza para las 4 acciones importantes en vez de un modal por acción |
| El logout (main-layout) usa su propio modal **sin spinner** | El logout es síncrono (limpia la sesión y navega); un loading sería falso |
| Aprobar/rechazar y cancelar cambio de tarifa ya tenían su modal (se dejan igual) | Solo faltaba confirmar las acciones que se ejecutaban de un clic |

## 2026-07-27 — 🎨 Ajustes de UI (visor en modal, selects de marca, wizard) — solo frontend

> Pulido de UI sobre documentos, perfil, facturación y el wizard de registro. Sin cambios de API ni
> de BD. Build de producción limpio.

| Decisión | Motivo |
|---|---|
| **Visor de archivos en modal** compartido (`shared/components/file-viewer`, presentación pura: recibe la URL firmada + título, muestra PDF en `<iframe>` o imagen en `<img>`) reemplaza los "Ver" que abrían **pestaña nueva** en Documentos (global), perfil del chofer y Facturación; el historial de pagos también lo reutiliza | Un solo visor para los 4 sitios (DRY); ver un documento sin salir del panel. "Descargar" se mantiene como descarga real |
| **Fuera los `<select>` nativos**: los 6 desplegables del wizard y el perfil (requerimiento, tipo de vehículo, tarifa, renovación) pasan a `shared/components/select` | Regla del proyecto: el `<select>` nativo no se puede estilizar abierto. La renovación usa un **centinela** (`value` = plan actual → mapeado a `null`) para conservar la opción "Renovar la actual" sin tocar el contrato de `renewPlanId` |
| Wizard paso Documentos: grid de 2 columnas, **archivo a ancho completo** en su fila, y un **requerimiento solo se puede documentar una vez** (se excluye del desplegable) — mismo criterio en el perfil (botón "+ Agregar" deshabilitado si no queda ninguno) | Layout menos amontonado y evita documentos duplicados por requerimiento (guarda de UI; la BD aún no lo fuerza) |
| **Operadora de teléfono preseleccionada** (primer valor) en `emptyPersonForm()`; regla CSS global que oculta las flechas de los `input[type=number]` | Detalles de pulido: el selector no nace en blanco y los campos numéricos no muestran los spinners nativos |

## 2026-07-27 — 🚀 Despliegue en producción (Railway)

> Backend y frontend en producción como dos servicios de Railway. Runbook completo en
> [../guides/deploy-railway.md](../guides/deploy-railway.md).

| Decisión | Motivo |
|---|---|
| **Ambos en Railway**, mismo proyecto; **mismo Supabase que desarrollo** (sin proyecto de prod separado por ahora) | Pedido de Luis: salir a producción ya. Aislar prod en un Supabase propio queda como mejora pendiente (riesgo asumido: prod comparte datos/credenciales con dev) |
| **Backend con Nixpacks** (builder automático); el `Dockerfile`/`railway.json` preparados quedan **sin subir** | El backend levantó bien con Nixpacks y no se quiso tocar un servicio ya operativo. Los archivos Docker quedan como punto de partida si se migra |
| **Frontend con Builder = Dockerfile** (multi-stage → Caddy) — **obligatorio** | Railpack (default de Railway) compila el Angular pero **no sirve** un SPA estático (sin fallback a `index.html`). El Dockerfile + `Caddyfile` montan el servidor con las rutas del router |
| `CORS_ORIGIN` como **lista de orígenes exactos separados por coma sin espacios** | El backend hace `split(',')` sin `trim`: un espacio deja el origin como `" https://…"` y rompe el CORS. Mejora futura anotada: `trim()` |
| Los **valores** de las variables (`DATABASE_URL`, `JWT_SECRET`, claves de Supabase) viven solo en Railway y en el `.env` local | Regla de oro #3: credenciales nunca versionadas. `.env.example` documenta los nombres |
| **Gotcha de plataforma** documentado: la cola de build de Railway (región **US West**) se atascó en `Queued` >20 min sin ser culpa del proyecto (incidencia transitoria de GitHub + región degradada); se resolvió **recreando el servicio** | Que un despliegue lento no se confunda con un error de configuración; salidas: cambiar región, recrear servicio, o soporte |

## 2026-07-28 — 🎨 Rediseño del perfil del afiliado (pestañas + documentos/fotos por vehículo)

> Rediseño grande de `driver-detail` (frontend) + soporte backend. Todo compila; typecheck +
> 7/7 tests OK. **No pusheado ni desplegado aún.** Estado completo en la memoria de sesión.

| Decisión | Motivo |
|---|---|
| Perfil en **3 pestañas** (Datos personales / Vehículos / Documentos) a ancho completo | Las 3 tarjetas lado a lado quedaban apretadas; cada sección necesita espacio |
| **Documentos separados por dueño**: la pestaña Documentos es solo del chofer; los de vehículo viven en la **pantalla de detalle del vehículo** (ruta nueva `/drivers/:id/vehicles/:vehicleId`) | El modelo ya soportaba `documents.driver_id` XOR `vehicle_id`; solo faltaba la UI (era "future") |
| Tabla **`vehicle_images`** (1-3 por vehículo, `position` CHECK 1-3 + UNIQUE) para las fotos; binario en el bucket privado, solo la referencia en Postgres | Fila por imagen (orden, borrado individual, URL firmada propia); mismo patrón que documentos |
| **`insertDocument` parametrizado** (dueño chofer XOR vehículo); el `register` transaccional acepta `vehicles[].documents[]` anidados y responde `createdVehicles:[{id,documentIds}]` | Crear vehículos con sus documentos en la misma transacción del alta; los archivos se suben después contra los ids devueltos |
| **Borrar documentos** (`DELETE /documents/:id`: fila + archivo) y **editar vehículo** (`PATCH /drivers/:id/vehicles/:vehicleId`) | Faltaban; no se podían quitar documentos requeridos ni corregir datos de un vehículo |
| CORS del backend ahora declara `methods` incluyendo **DELETE** | El default no lo permitía en el preflight; el primer endpoint DELETE del proyecto lo destapó |
| **`pool.on('error')`** en `db.ts` | El pooler de Supabase recicla conexiones idle; sin el listener el proceso crasheaba y colgaba las peticiones |
| Modal de agregar vehículo (perfil) extraído a **`features/drivers/vehicle-form`** (2 columnas: datos+fotos · documentos) | Límite de 1000 líneas + reutilización; diseño estilo Flowbite Pro |
| **Wizard (paso Vehículo) → MODAL** `features/drivers/vehicle-draft-modal` (captura pura, sin HTTP; emite `VehicleDraft`; edita vía `initial`). Paso 3 = lista + tile "+ Agregar vehículo" + modal | Decisión de Luis: ocupa menos espacio y permite varios vehículos. **No persiste nada** — todo va en la transacción de `register()`, imposible un vehículo sin chofer. Object URLs de fotos con dueño claro (modal crea/revoca; al confirmar se ceden al wizard) |
| **Wizard (paso Documentos del chofer) → MODAL** `features/drivers/document-draft-modal` (captura pura; emite `DocDraft`; edita vía `initial` + `takenIds`; solo requerimientos `appliesTo='driver'`). Paso 2 = lista + tile "+ Agregar documento" + modal | Mismo patrón que vehículos por consistencia; ocupa menos espacio. El perfil ya tenía su modal (persiste directo con `driverId`, como `vehicle-form`) |
| **Fecha de vencimiento fuera de la UI** de documentos (wizard + modal del perfil + card): sin campo "Vence", sin "Sin vencimiento" ni badge "Vencido". El `register`/`addDocument` mandan `expiresAt: null` | Decisión de negocio: se elimina el vencimiento (queda solo fecha de registro). **No destructivo aún**: la columna `expires_at`, el `document-scheduler`, las alertas del dashboard y la vista global siguen intactos → **Fase 5** (migración `dropColumn`) pendiente. [Estado del esfuerzo](../proposals/rediseno-perfil-afiliado/README.md) |
| Flag **`environment.unlockSteps`** (dev `true` / prod `false` vía `environment.prod.ts` + fileReplacements): salta el gate del paso 1 del wizard | Solo para visualizar pasos en desarrollo; imposible que llegue a producción |

## 2026-07-28 — 🧾 Paso de pago del alta: 1 factura por el total + validación condicional

> Rediseño del paso 4 del wizard y del cobro del alta. Backend: typecheck + **7/7 tests** OK
> (incluye enroll/anclaje). Frontend: build de producción limpio. Cierra los puntos 1–4 de la
> fase "ahora"; el resto (motor de deuda, emitida≠pagada) es v8.

| Decisión | Motivo |
|---|---|
| **Una sola factura por el cobro adelantado** (`enrollOnClient`): membresía + **todos** los períodos = 1 factura por el total, en vez de "la #1 + una por cada período extra" | Pedido de Luis: pagar N semanas por adelantado = **un solo pago del total**, no N facturas. La cobertura sigue en N filas `subscription_payments` (una por semana) → el ciclo de tarifas las consume igual. **`reject` y `resume` no se afectan** (anulan por `driver_id` / operan por fila de pago) |
| ⚠️ **Alcance:** el cambio es **solo `enrollOnClient`** (alta/enroll). `renew`/`changePlan` (cobros del perfil) **siguen emitiendo una factura por período** — pendiente unificarlos para consistencia | Luis acotó a la pantalla de registro; no tocar más flujos de dinero sin confirmar |
| **Tarifa preseleccionada y bloqueada** si es la única activa; **card "Resumen de cobro"** (membresía + tarifa) con **total prominente** (`$membresía + $tarifa × N`) | Menos fricción y el total del cobro visible de un vistazo |
| **Botón "Registrar y facturar" con validación condicional por método** (en `payment-capture.complete`): método + comprobante siempre; **referencia** salvo `Contactar al administrador`; **banco emisor** solo en Transferencia/Pago Móvil | No facturar sin los datos del pago, sin exigir campos que no aplican a cada método. El wizard lo consume por template-ref (`#pc`); reutilizable por los 4 cobros |
| **`paidUntil`** nuevo en `GET /drivers/:id` (subscription) = `MAX(period_end)` de períodos pagados; la card Tarifa muestra **"Pagado hasta {fecha}" + "Próxima factura en X días"** y quita "N períodos pagados" | `current_period_end` es el fin del período **en curso**, no de la cobertura prepagada; para "pagado hasta" real hace falta el último período |
| **Historial de pagos agrupado por factura**: 1 línea = el cobro real (membresía + semanas = un total) con su fecha; el detalle muestra el desglose + factura/comprobante | El chofer hizo **un** pago; verlo como N líneas confunde. Es agrupación de presentación (no toca datos) |

## 2026-07-29 — 🛡️ Normalización de estados del perfil + candado de deuda en la aprobación

> Estados visibles del perfil reordenados y la regla "sin aprobar con deuda" hecha cumplir en el
> backend. Backend: typecheck + **7/7 tests** OK. Frontend: build de producción limpio. Solo local,
> sin pushear.

| Decisión | Motivo |
|---|---|
| **Badge junto al nombre = solo disponibilidad** (`Activo`/`Inactivo`), nunca el ciclo de vida. `Activo` solo si `is_available` **y** el chofer opera (`approved`/`overdue`); el resto (pendiente/pausado/penalizado/suspendido/rechazado) = `Inactivo` | Los estados salían duplicados y contradictorios (p. ej. "Activo" verde junto a "Vencida" rojo). El ciclo de vida vive **solo** en la card Estado |
| **Card Estado = hogar único del ciclo de vida**, con descripción que explica qué es y **de dónde viene** (acción del admin vs. automático del motor de deuda). `pending` condicional: "faltan pagos" vs. "pagos completos, listo para aprobar" | Que el admin entienda el estado sin ambigüedad; el copy anterior mentía ("aún faltan sus pagos" a un chofer que ya había pagado) |
| **Candado de deuda en la aprobación** (`assertApprovable`): membresía `paid` + tarifa + **deuda 0**. Aplica a `POST /approve` **y** a `PATCH /:id` con `status:'approved'`; `reactivate` unifica el criterio de deuda a `pending`+`overdue` (antes solo `overdue`) | Antes `approve()` no miraba deuda (seguro solo por efecto colateral de que el scheduler no cobra a `pending`) y `PATCH` **no validaba nada** → se podía forzar `approved` con deuda o sin pagos. Regla cerrada: primero el dinero, después el estado |
| **Quitar una suspensión a un chofer con deuda queda BLOQUEADO** (409), no lo pasa a mora | Decisión de Luis (opción A): plata primero. Solo afecta ese caso puntual; el resto de aprobaciones no cambia |
| **Modal de cobro renombrado**: "Renovar tarifa" → **"Generar pago"** (y "Pagar y reactivar" si la tarifa está vencida); botón "Cobrar y facturar" → **"Pagar"** | "Renovar" no describía pagar semanas por adelantado ni cambiar de plan; nombre general y claro |
| **Bloque de pago del modal de cobro = requerido** (`[optional]="false"` en `payment-capture`): botón "Pagar" **bloqueado hasta `complete`** (mismo criterio del wizard). Enroll y pago de deuda **no se tocan** | Evitar pagos incompletos. El input solo cambia el rótulo y el gate en este modal, sin afectar los otros cobros |
| **Tarifa preseleccionada y bloqueada cuando es la única activa** en el modal de cobro (además del wizard, decisión 2026-07-28) | Nada que elegir = candado; menos fricción |

## 2026-07-29 — 🐛 Motor de deuda: cargos fantasma por desajuste de anclaje (fix de raíz, !DEEP-DEBUG)

> Bug en producción: a un chofer con semanas pagadas por adelantado le aparecía "Deuda pendiente"
> por una semana ya cubierta (y el lunes siguiente lo habría puesto "En mora" en falso). Investigado
> con !DEEP-DEBUG. Backend: typecheck + **7/7 tests** OK. Falta correr `db:purge-phantom --apply`.

| Decisión | Motivo |
|---|---|
| **La deuda se define por COBERTURA, no por coincidencia de fecha.** Un cargo de tarifa (`period`) cuenta como deuda solo si su semana **no** está cubierta por la cobertura pagada (`paidUntil`); las penalizaciones siempre cuentan. Aplicado en la subconsulta `debt` (`drivers.repository.ts`) **y** en la derivación de estado del motor (`debt-scheduler.ts`, paso 4) | Causa raíz: el motor emite cargos anclados a **lunes**, pero las coberturas aprobadas con el motor apagado quedan ancladas a la **fecha de registro**. La guardia comparaba `period_start` exacto → no reconocía el adelanto → cobraba semanas ya pagadas. Ahora el sistema tolera cualquier anclaje |
| **El motor no emite cargos para semanas ya cubiertas** (`debt-scheduler.ts`, paso 1): guardia de cobertura (`next_start >= paidUntil`) sumada a la idempotencia por `period_start` | Corta la generación de fantasmas de raíz, sin depender de que todo esté anclado a lunes |
| **Script `db:purge-phantom`** (dry-run + `--apply`, transaccional y auditado): elimina los cargos fantasma ya emitidos (`period`, `pending`/`overdue`, **sin factura**, cubiertos por adelantos) | Limpia los datos ya afectados. No toca filas con factura ni pagadas → no borra dinero (regla 7) |
| **`db:reanchor` deja de ser prerequisito** para tener el motor encendido | El motor ya razona por cobertura; el re-anclaje pasa a ser opcional (consistencia), no un bloqueante |

## 2026-07-29 — 💳 Ciclo de deuda/cobro en el perfil: próximo cobro vs. deuda + adelanto

> Presentación del ciclo semanal tal como lo modela el motor: `pending` = aviso de cobro (viernes
> 18:00 → domingo), `overdue` = deuda vencida (lunes 00:00+). Backend: typecheck + **10/10 tests**
> (3 nuevos: guardia de cobertura del motor + división deuda/próximo cobro en `findDetail` + caso
> Ruth). Frontend: build limpio. El pago sigue siendo **todo-o-nada** (sin abono parcial, decisión de Luis).

| Decisión | Motivo |
|---|---|
| **Dos letreros EXCLUYENTES**: banda **roja "Deuda pendiente"** solo si hay cargos **vencidos** (`overdue`); banda **ámbar "Próximo cobro"** solo si está solvente y el cobro del próximo lunes ya se emitió (`pending`, viernes 18:00). Si debe, manda el rojo (nunca los dos) | El mismo cargo se veía como "deuda" antes de vencer. `pending`=aviso / `overdue`=deuda ya lo distingue el motor; faltaba separarlo en pantalla |
| **`GET /drivers/:id` divide `debt` (vencido: `overdue` + penalización, con `capWeeks`) y `upcoming` (el `pending` no vencido)** | Cada banda muestra lo suyo sin mezclar; `capWeeks` alimenta la advertencia de suspensión |
| **Advertencia de suspensión** en la banda roja cuando `weeksOwed >= capWeeks` y hay un `upcoming`: *"Paga antes del lunes 00:00 o la cuenta será suspendida"* | El próximo lunes cruzaría el tope → penalización; hay que avisar en la ventana viernes→domingo |
| **"Adelantar pago"** (solvente) y **"Registrar pago"** (deuda) usan el **mismo** flujo (external-payment): saldan el/los cargos que el motor ya preparó, **sin crear filas nuevas** | Evita cobros dobles; coherente con el motor. El modal adapta el título (Adelantar/Registrar) |
| **Modal de cobro con desglose**: *X semanas × $Y = $Z* + lista de cada semana con fechas + penalización | Que el admin vea qué semanas se saldan y el equivalente en semanas |
| **Campo "Motivo / constancia (opcional)" también en "Generar pago"** (renovación); `note` opcional nuevo en `POST /subscription/renew` (guardado en auditoría) | Pagos mixtos ("parte por transferencia, resto en efectivo") necesitan dejar constancia también al renovar/adelantar |

## 2026-07-30 — 💳 Registro con deuda (opción A) + cobro unificado + UI (EN CURSO, sin pushear)

> Bloque grande **aún sin pushear**. Backend Fases 1-2 (typecheck + **10/10 tests**) y frontend
> Fase 4 hechos; falta la **Fase 3** (factura Emitida/Pagada + fechas en Facturación). Handoff
> detallado en la memoria del proyecto (`registro-deuda-cobro-unificado`).

| Decisión | Motivo |
|---|---|
| **Registro sin pago = factura de DEUDA (opción A)**: emite 1 factura "Emitida" por membresía + 1 semana (`membership_payments` + 1 `subscription_payments` en `pending`, con `invoice_id`); el chofer queda pendiente y no se activa hasta saldar (`enrollDebtOnClient`) | El admin ve el total que debe (no solo la tarifa) y queda registrado como deuda formal con rastro |
| **Estado "Emitida/Pagada" y fechas DERIVADOS, sin migración**: `issued_at` = emisión; fecha de pago = `max(paid_at)` de los cargos; "Pagada" cuando todos sus cargos están `paid` | El esquema ya lo soporta (membresía default `pending`, cargos con `paid_at`); menos riesgo que tocar la tabla de facturas (regla del dinero) |
| **La deuda del perfil incluye la MEMBRESÍA** (`debt.totalUsd` += membresía pendiente; expone `membershipDue`); el saldo (`registerExternalPayment`) salda membresía + tarifa; cargos con factura (alta) se marcan paid sin factura nueva, la mora sin factura recibe una nueva | Antes la deuda y el saldo ignoraban la membresía; el candado de aprobación (lee `debt.totalUsd`) ahora exige saldarla toda |
| **El motor no marca en mora la semana de un chofer `pending`** (`debt-scheduler.ts` paso 2 filtra `approved/overdue/penalized`) | La deuda del alta se salda al aprobar; el motor no la toca mientras el chofer no opera |
| **Un solo botón de cobro adaptativo** en el perfil: "Registrar pago" (formato deuda, con membresía) si debe / "Generar pago" (adelanto) si al día; se quitan los botones de las bandas y los redundantes del header | Había 3-4 botones de pago que confundían; el adelanto va por "Generar pago", las bandas quedan como info |
| **Wizard paso 4 de pago → modal** (`payment-draft-modal`, patrón vehículo/documento); tarifa+semanas se bloquean tras agregar el pago; campo "Semanas" 1-999 saneado (nunca vacío/0) | Consistencia con los otros pasos; evitar cambiar el monto tras registrar el pago y valores inválidos |
| **Estilos globales de campos** (`styles.css`, reglas sin capa): editables en **blanco** (vs gris deshabilitado), borde **1.5px** un poco más oscuro; línea **punteada solo en dropzones de archivo** (los tiles que abren modal quedan rectos) | Los campos parecían deshabilitados; la punteada debe señalar "sube un archivo aquí", no "abre un modal" |

## 2026-07-30 — 🧾 Fase 3: estado Emitida/Pagada y fechas de cobro en Facturación (cierra el bloque)

> Última pieza pendiente del bloque de registro con deuda. Backend: typecheck + **16/16 tests**
> (6 nuevos en `tests/invoice-state.test.ts`). Frontend: build de producción limpio. Sin migración.

| Decisión | Motivo |
|---|---|
| **`GET /invoices` expone `status` DERIVADO de los cargos** (`voided` manda > `paid` si **todos** los cargos de la factura están pagados > `issued`), no la columna física; el **filtro** usa la misma expresión | La opción A emite facturas que nacen impagas: el listado decía "Emitida" en verde para una factura pagada y para una de pura deuda, sin distinguirlas. El esquema ya tiene la verdad en los cargos (regla del dinero: no se toca la tabla de facturas) |
| Se **reemplaza** el campo `status` en vez de añadir uno paralelo (`paymentState`) | Dos campos de estado en la misma respuesta son una invitación a que la UI pinte uno y filtre por el otro. Una sola fuente de verdad de presentación; el estado físico sigue íntegro en la BD |
| Nuevo **`paidAt`** = `max(paid_at)` de sus cargos, **null salvo que esté saldada por completo** | Una factura a medio pagar no tiene "fecha de pago": exponer el `paid_at` del primer cargo fecharía como cobrado algo que no lo está |
| Una factura **sin cargos** se reporta `issued`, nunca `paid` (`ch.total > 0` en la condición) | `count(*) FILTER (...) = count(*)` es cierto con cero filas: sin la guarda, una factura huérfana se leería como pagada (cazado por test) |
| Un **LATERAL compartido** por el count y el select (agrega `membership_payments` + `subscription_payments`); enums comparados como **texto** | Un solo lugar donde vive la derivación (listado y filtro no pueden divergir); el cast a texto sigue la regla del pooler (2026-07-23) |
| UI: badge tri-estado (ámbar **Emitida** + "Por cobrar" · verde **Pagada** · rojo **Anulada**), columna **Pagada** con la fecha y filtro **Por cobrar / Pagadas / Anuladas** | El verde debe significar "el dinero entró"; el ámbar es el mismo código de color que la banda "Próximo cobro" del perfil |

## 2026-07-30 — 🛡️ Tests: el motor de dinero jamás debe quedar encendido (incidente real)

> Detectado corriendo la suite: un test murió en su limpieza **antes** de restaurar el flag y
> dejó `debt_engine_enabled = true` en la BD — que es la **misma que usa producción**.

| Decisión | Motivo |
|---|---|
| **`--test-concurrency=1`** en `npm test` | Cada archivo levanta su propia app (`max: 10` conexiones) y el pooler de Supabase admite **15 sesiones**: en paralelo la suite reventaba con `EMAXCONNSESSION`. En serie también desaparece la interferencia cruzada entre archivos que ya sufría el motor (global por diseño) |
| **`restoreDebtEngineDefaults` en un hook `after()`**, además de en cada `finally`, y el flag se apaga **antes** de borrar los datos del test | Red de seguridad: ningún fallo puede dejar el motor de deuda operando sobre choferes reales. Apagarlo primero cierra además la ventana de carrera durante la limpieza |
| **`removeDriver` transaccional con `SELECT … FOR UPDATE`** sobre las suscripciones (`tests/helpers/db-fixtures.ts`, compartido por los 3 archivos) | Un scheduler de **otro proceso** (backend desplegado contra la misma BD) insertaba un cargo entre el borrado de pagos y el de suscripciones → violación de FK. El lock de la fila referenciada bloquea ese INSERT mientras dura la limpieza |
| ⚠️ Pendiente de infraestructura: **la suite corre contra la BD de producción** (mismo Supabase, decisión del 2026-07-27) | Mitigado, no resuelto: los tests escriben `app_settings` globales. La solución real es una BD/proyecto Supabase separado para dev+tests |

## 2026-07-30 — 📅 La semana del alta arranca el PRÓXIMO lunes (corrección de la regla de anclaje)

> Corrección pedida por Luis al revisar el perfil: un alta pagada un jueves mostraba cobertura
> jueves→jueves. **Rectifica la convención del 2026-07-24** ("desde el lunes de la semana en
> curso"). Verificado: typecheck + **17/17 tests** (uno nuevo, dedicado al alta anclada).

| Decisión | Motivo |
|---|---|
| **El alta compra la semana que empieza el PRÓXIMO lunes**; pagar **en lunes** compra la semana que ya está corriendo (`approve`, rama `anchorWeekly`) | Es prepago: se paga por adelantado la semana siguiente, no por la que está terminando. La regla anterior cobraba una semana completa por los días que quedaban (pagar un jueves dejaba 4 días de cobertura) |
| Entre el pago y ese lunes el chofer **no opera**: la tarifa nace **`scheduled`** y el `subscription-scheduler` la activa al empezar su semana | Decisión de negocio de Luis: no hay días gratis. Reutiliza el paso que ya existía desde el 2026-07-15 (activar una tarifa programada cuando empieza su período pagado); no hace falta estado nuevo |
| El perfil muestra **"Inicia el dd/MM · no puede recibir viajes hasta esa fecha"** en vez de "Próxima factura en X días" mientras la tarifa esté programada | Sin esto la card decía "Programada · Pagado hasta …" sin la única fecha que importa: cuándo empieza a trabajar |
| **Solo cambia el alta.** `renew` (adelanto) sigue encadenando tras `max(period_end)`; el pago de deuda sigue saldando los cargos que el motor ya emitió; `resume` sigue re-anclando a la semana en curso | Verificado uno por uno: un chofer que ya pagó su semana de inicio no está comprando "la próxima semana", está pagando deuda o adelantando. Y quien vuelve de una licencia no puede tener deuda, así que su semana ya está pagada y opera de inmediato (criterio de Luis) |
| El **seed de demo** genera semanas ancladas (alta → próximo lunes; chofer al día → semana en curso) | El dato sembrado con `now()` fue lo que disparó la falsa alarma: una demo que miente sobre la regla es peor que no tenerla |

## 2026-07-30 — 🔴 Motor de deuda ENCENDIDO (`debt_engine_enabled = true`)

> Autorizado por Luis. Antes de encender se purgó el único cargo fantasma pendiente
> (`db:purge-phantom --apply`, el de Ruth: semana 03/08 ya cubierta hasta el 26/08).

| Decisión | Motivo |
|---|---|
| Se enciende el interruptor maestro: desde ahora el cobro semanal es **automático** (emisión viernes 18:00, mora el lunes 00:00, penalización al superar 2 semanas, reactivación el lunes siguiente) | El modelo v8 quedó cerrado el 2026-07-24 y la última dependencia de código (anclaje del alta) ya está resuelta. `db:reanchor` dejó de ser prerequisito el 2026-07-29 (el motor razona por cobertura) |
| Se acepta que **producción corre código anterior** hasta el próximo despliegue | Decisión de Luis: dev y producción comparten la misma base y el proyecto sigue en desarrollo. El efecto acotado es que un alta registrada en producción antes del deploy anclaría con la regla vieja |
| El mismo interruptor gobierna anclaje y cobranza (no se separó en dos) | Se evaluó desacoplarlos; Luis optó por encender el modelo completo. Menos superficie de configuración que mantener |

## 2026-07-31 — ✅ Validación integral de formularios (frontend + backend alineados)

> Barrido de todos los formularios de captura del panel tras detectar que aceptaban basura
> (`f5454/-+#$%` en nombres, fechas escritas a mano, etc.). Backend: typecheck + **23/23 tests**
> (6 nuevos en `tests/validation.test.ts`). Frontend: build de producción limpio.

| Decisión | Motivo |
|---|---|
| **3 directivas compartidas** (`shared/directives/input-filter.directive.ts`): `appLetters` (letras+acentos+ñ+espacio/guion/apóstrofo), `appDigits` (solo números), `appAlnum` (alfanumérico), `appAlnumDash` (alfanumérico+guion). Cada una **filtra al teclear** (re-despacha `input`, sin inyectar `NgControl` para evitar el DI circular) **y** es `NG_VALIDATOR` (pinta rojo + bloquea submit) | Dos capas: el filtro es UX (el campo no puede *contener* basura), el validador es la garantía (pegar/autocompletar). Una directiva sirve a todos los formularios presentes y futuros |
| **`date-picker` editable con validación de formato** (rectifica el "readonly" del mismo día): se puede teclear la fecha, pero **enmascarada a dd/mm/aaaa** y validada — un valor incompleto/imposible (31/02) o posterior al `max` marca el control inválido (`NG_VALIDATOR` + rojo global + bloquea submit). `updateOnBlur:false` conserva el texto para que el error se vea. Arregla **todos** los campos de fecha (nacimiento, fecha de pago, filtros de auditoría) | Petición de Luis: el campo debe ser editable, no solo elegible en el calendario, pero solo en el formato establecido. El componente es compartido, así que la regla vale para todos de una vez |
| **Nombres: solo letras (+acentos/ñ), espacio, guion y apóstrofo, máx 80**; el backend sube de 60→80 y añade el pattern | Cubre nombres compuestos reales ("De La Cruz", "Ángel-María", "O'Brien") sin números ni símbolos. Frontend y backend comparten el mismo criterio (`composePerson` + JSON Schema) |
| **Vehículo: marca/modelo alfanumérico+guion, color solo letras, año → SELECTOR** (últimos ~101 años) | Modelos reales llevan números ("Mazda 3", "F-150"); el color no. El año como desplegable no se puede escribir mal (el backend amplía `year` a 1900–2100 para que cualquier opción valide) |
| **Cédula y teléfono: solo dígitos** (`appDigits`); email valida formato aunque sea opcional (validador `email` de Angular + regex en `composePerson`) | El pattern canónico ya existía en el backend (`^[VEJ]-\d{5,9}$`, `^\+58\d{10}$`); faltaba que el campo no dejara teclear letras y que el email no pasara "rosa" |
| **Referencia de pago: ≤25, solo alfanumérico + espacio** (`appAlnum` + pattern backend). Se ajustó un dato de test viejo (`REF-12345`→`REF12345`) | Decisión de Luis: "sin caracteres especiales". El guion cuenta como especial; una referencia es un código, no puntuación |
| **3 columnas nuevas en `invoices`** (migración `1752320000000`, aditiva, nullable): `paid_on` (día del pago, default hoy en la UI), `payer_phone`, `payer_id` (**solo Pago Móvil**) | La factura es el documento de dinero; los datos del pagador viven con ella (mismo criterio que método/referencia/banco de la Pieza 2). Nullable → no rompe facturas existentes |
| **`payment-capture` extendido**: fecha del pago (hoy por defecto, tope hoy) + teléfono/cédula del pagador condicionados a Pago Móvil, compuestos a formato canónico; `complete()` los exige. Reutilizado por los **4 cobros** (alta, enroll, renovación, pago externo) vía `PaymentMeta` | Un solo bloque de captura; al ser todos los cobros el mismo componente, los campos nuevos aparecen en los cuatro sin código extra |
| **Métodos de pago: validación de formato por campo** (`FIELD_FORMATS` en el service + `paymentFieldError` en el modelo del front): email estricto en PayPal, "email si tiene @" en Zelle/Binance (aceptan email **o** teléfono/id), cédula V/E/J en los `idDocument` | Pedido de Luis: los campos de correo se validan sí o sí. Zelle/Binance admiten alternativa, así que el email solo se exige cuando el valor parece uno |

## 2026-07-31 — 🧹 Auditoría fuera del panel del admin + reset de datos de prueba

| Decisión | Motivo |
|---|---|
| Se **quita del frontend** la "Actividad reciente" del dashboard, el ítem de menú "Auditoría" y su ruta `/audit`; se borran `features/audit/*` y `core/models/audit-log.model.ts` | El feed mostraba el log crudo (`payment_method.deleted · payment_methods`): lenguaje de desarrollador, no de admin. Si se necesita un panel de actividad, se hará aparte con info legible |
| El **backend NO cambia**: `writeAudit` sigue registrando todo y `GET /audit-logs` sigue existiendo (queda sin consumidor en la UI) | El rastro es un activo; solo deja de exponerse. Los endpoints quedan para un futuro panel |
| **Reset de datos de prueba**: borrados todos los choferes y su info relacionada (users, drivers, vehículos, documentos, suscripciones, pagos, facturas, 730 audit-logs de choferes) en una transacción; `invoice_number_seq` reiniciada en 1; catálogo/config intactos | Pre-producción: arrancar limpio para probar todo lo nuevo. Archivos del bucket quedaron huérfanos (inofensivos) |

## 2026-08-03 — 🔒 Verificación de pagos (v9): flujo de aprobación pendiente → aprobado/rechazado

> Pedido por Luis: hoy un cobro se **liquida al instante** sin validación alguna. Se introduce un
> flujo donde **todo pago queda pendiente** hasta que un admin lo apruebe (medida anti-fraude /
> anti-duplicados). **Fase 1 (BD) aplicada**: migración `1752340000000_payment-approval-flow`,
> modelos regenerados, typecheck limpio. Backend/UI en construcción. Contrato para la app del
> chofer: [proposals/pagos-aprobacion](../proposals/pagos-aprobacion/README.md).

| Decisión | Motivo |
|---|---|
| **Nueva entidad `payment_submissions`** (+ `payment_submission_files` 1..5 imágenes, enum `payment_submission_status`): un "envío de pago" agrupa 1..N cargos con **un** comprobante y **un** estado `pending`/`approved`/`rejected` | No existía un concepto de "pago en revisión": el cobro nacía `paid`. Una entidad de primera clase permite aprobar/rechazar el pago completo y deja el rastro (revisor, fecha, motivo) |
| **La factura se materializa AL APROBAR**, no al enviar; mientras el envío está pendiente no hay factura (cargos debidos + envío) | Coherente con "la factura es el recibo de dinero recibido". De paso corrige el bug por el que un adelanto de N semanas emitía N facturas y el comprobante/referencia caían solo en la primera: ahora un envío aprobado = **una** factura con sus datos |
| **Todos los pagos quedan pendientes**, incluidos los que registra el admin (alta, enroll, renovación, pago externo/efectivo). **El alta pasa a 2 pasos** (registrar pago → aprobar → aprobar chofer) | Decisión de Luis: doble control, nada se da por pagado sin una aprobación explícita |
| **El motor de deuda se congela** mientras haya un envío pendiente que cubre la deuda (no acumula mora ni penaliza; se reanuda si se rechaza) | No penalizar/suspender a quien ya pagó y espera la revisión |
| **A lo sumo un envío pendiente por chofer** (índice único parcial `payment_submissions_one_pending_per_driver`) | Control anti-duplicados: un nuevo envío espera a que se resuelva el anterior |
| **Rechazo con rastro**: el envío rechazado **nunca se borra** (se guarda `rejection_reason`); el chofer genera uno nuevo. Mensaje en su perfil: *"Su pago fue rechazado, genere uno nuevo o póngase en contacto con el administrador."* | Regla de dinero (documentos de dinero no se borran) + guía clara al chofer |
| **Nuevo método `cash_usd` (Efectivo Divisa), `admin_only`**: exclusivo del panel (columna `payment_methods.admin_only`, **nunca se expone a la app**); al cobrar captura **fecha + monto + 1..5 fotos de billetes**, sin referencia/banco/pagador | Pedido de Luis: cobro en efectivo divisa con evidencia visual (los billetes), operado solo por el admin |
| Detalle de factura en **ruta dedicada `/billing/:id`**; bandeja de revisión como **pestaña "Por aprobar"** dentro de Facturación; comprobante **obligatorio salvo efectivo/contacto** | Preguntas menores resueltas con Luis el 2026-08-03 |

## 2026-08-03 — ✅ Verificación de pagos v9: implementación completa (backend + panel)

> Backend **29/29 tests**, frontend build limpio. El flujo funciona de punta a punta desde el
> panel: registrar pago → **pendiente** → aprobar/rechazar → mensajes en el perfil del chofer.

| Decisión / hecho | Detalle |
|---|---|
| **Módulo nuevo `payment-submissions`** (routes → service → repository) | `POST /drivers/:id/payment-submissions` (multipart, 1..5 imágenes), `GET /payment-submissions` (bandeja), `GET /payment-submissions/:id` (detalle + desglose `items[]` + URLs firmadas), `.../approve`, `.../reject`. Migración `1752350000000` añadió `purpose`/`context` |
| **Liquidación AL APROBAR, despachada por `purpose`** | `debt` → `settleDebtOnClient` (extraído por DRY de `registerExternalPayment`); `advance` → `settleAdvanceOnClient` (**una** factura por las N semanas, corrige el bug de N facturas); `enroll` → `enrollOnClient` (acepta `submissionId`, retorna `invoiceId`). Todos vinculan los cargos al envío y estampan la metadata en la factura |
| **Motor de deuda congelado** | `debt-scheduler.ts` pasos 2/4/5: `NOT EXISTS` envío pendiente → no marca mora, no deriva estado ni penaliza mientras se revisa |
| **Efectivo Divisa (`cash_usd`)** | Tipo admin-only: `payment_methods.admin_only` derivado del tipo; el catálogo expone `adminOnly` para que la app lo filtre. (La captura de monto + 5 fotos en `payment-capture` queda pendiente) |
| **Todos los cobros del panel reconducidos a envío** | Deuda, adelanto/renovación, enroll y **alta (wizard)**. El alta = `register(payment:null)` [emite la deuda del alta] + envío `debt` con el comprobante. Solo el **cambio de plan** sigue liquidando directo (caso menor) |
| **Panel de revisión** | Facturación: nombre del afiliado **no clickeable**, N° → detalle `/billing/:id` (comprobantes **inline** siempre visibles); pestaña **"Por aprobar"** (fila clickeable) → sección `/billing/submissions/:id` con desglose "qué está pagando", comprobantes inline y **Aprobar/Rechazar con modal de confirmación**. Perfil: bandas "Pago en revisión" y "Pago rechazado" |
| **Integración con la app del chofer** (`edv-route-mobile`, otro agente) | La app POSTea a `/drivers/:id/payment-submissions` con su token `driver` (`/driver-auth/login`), filtra el catálogo de métodos por `adminOnly=false` (nunca ve `cash_usd`) y muestra pendiente/aprobado/rechazado en el perfil del chofer. Contrato: [proposals/pagos-aprobacion](../proposals/pagos-aprobacion/README.md) |
| **Fix colateral** | `driver-vehicle-detail` cargaba en el constructor (leía un `input.required` antes de que el router lo enlazara → `NG0950`, pantalla en blanco); movido a `ngOnInit` |

## 2026-08-03 — ✅ v9: pendientes cerrados (Efectivo Divisa + cambio de plan)

| Decisión / hecho | Detalle |
|---|---|
| **Efectivo Divisa en la captura** (`payment-capture`) | El value pasó de `file` a `files[]` (1 comprobante estándar; hasta **5 fotos de billetes** en `cash_usd`, JPG/PNG) + `amountUsd`. Al elegir `cash_usd` se pide **monto + fotos** y se ocultan referencia/banco/pagador. El tipo `cash_usd` se añadió al catálogo de métodos del panel (admin-only, `PAYMENT_METHOD_FIELDS['cash_usd']=[]`). Los cobros de `driver-detail` y el wizard iteran `files[]` |
| **Cambio de plan por envío** (`purpose='change_plan'`) | `settleChangePlanOnClient` (nueva suscripción + N semanas en **una** factura, modo `immediate`/`scheduled`); `approve` lo despacha; `create` valida con `prepareChangePlanContext`. El frontend reconduce el cambio de plan a envío; se eliminó `afterCobro` (ya sin uso). Ahora **todos** los cobros del panel van por el flujo de envío |
| Pruebas | Test nuevo `approve of an ENROLL emits ONE invoice`; suite **30/30**, typecheck limpio |

## 2026-08-03 — 🔐 Login de chofer en la app (módulo `driver-auth`)

> Autenticación de la app móvil de choferes (realiza la decisión 2026-07-16: **cédula + clave**).
> Aditivo, **sin migración** (`users.password_hash` ya existía). La app móvil es un proyecto
> Flutter aparte (`edv-route-mobile`), apunta por defecto al backend de producción (Railway).

| Decisión | Motivo |
|---|---|
| **Módulo `driver-auth` separado** del `auth` de admins (`POST /driver-auth/login`, `GET /driver-auth/me`); mismo argon2id + verificación timing-safe contra enumeración | Aislar el flujo de la app del panel; menos acoplamiento aunque duplique algo de forma (decisión de Luis) |
| **Claim `type` en el JWT** (`admin`\|`driver`) + guards por audiencia (`authenticate` exige `admin`, `authenticateDriver` exige `driver`) | Cerrar un hueco de seguridad: ambos tokens se firman con el mismo secreto; sin el claim un token de chofer accedería a rutas de admin (p. ej. `GET /drivers`). Los admins re-loguean una vez |
| **Login abierto**: cualquier chofer con credenciales válidas entra; se devuelve `status` y la app enruta (revisión / bloqueado / home) | Coincide con las pantallas del Figma; el backend autentica, no decide el destino |
| **Lockout por intentos diferido** para choferes (los admins sí lo tienen) | Requiere columnas nuevas (migración); no bloqueante para esta fase |

## 2026-08-04 — 📱 Registro de chofer desde la app (`driver-auth`) + limpieza de solicitantes

> Backend del auto-registro del chofer y de las operaciones para completar el alta desde la app.
> **Sin migración** (columnas ya existían: `drivers.source`, `registered_by`/`uploaded_by`
> nullables, `audit_logs.actor_user_id`). El backend es el **dueño** de estas rutas y la app solo
> las consume (evita que dos sesiones toquen lo mismo). Verificado por `typecheck` en cada fase.

| Decisión | Motivo |
|---|---|
| **Reutilizar `DriversService.register` con `source`** (no un segundo camino de alta); `source='app'` → `registered_by`/`uploaded_by` = `null`, actor del alta en `audit_logs.actor_user_id` (se extendió `writeAudit` con `actorUserId`) | Un solo camino de dinero (DRY); el schema ya preveía `registered_by` null = app. El actor real (el chofer) queda con rastro sin inventar columnas |
| **`POST /driver-auth/register` público**; los 4 pasos son **obligatorios en la app** (credenciales, ≥1 vehículo, todos los requisitos `isRequired`), validado **en el endpoint**, no en `register` | La obligatoriedad es una regla del **canal** app; `register` queda agnóstico (SoC). El panel sigue con solo el paso 1 obligatorio |
| **Registro abierto sin límite**; la barrera de calidad es la **aprobación del admin**, no la entrada | Reclutamiento: no poner fricción al que se postula; el `pending` no opera hasta que un admin lo apruebe (decisión de Luis) |
| **Rutas del chofer bajo el prefijo `/driver-auth`** (pago, documento, foto), no un prefijo `/driver` aparte | Todas las rutas de la app ya viven en `/driver-auth`; mantenerlas juntas es más coherente que un segundo plugin para tres rutas |
| **Propiedad del recurso**: el pago toma el `driverId` del **token** (no de la URL); el documento valida `document.driverId === token` (404 si es de otro); la foto reutiliza `vehicleBelongsToDriver` | Un chofer solo puede tocar lo suyo; el 404 no revela la existencia de recursos ajenos |
| **Compartir los JSON Schema** de registro en `drivers/drivers.schemas.ts` (admin + app) | Una sola fuente de verdad del contrato del formulario; de paso aligera `drivers.routes.ts` |
| **Limpieza de solicitantes** (`applicant-cleanup-scheduler`, diario + boot): purga a los **7 días** los `pending` **sin pago vivo** (sin envío `pending`/`approved`) y los `rejected`; conserva `pending` con envío pendiente y `approved`. Borra filas en cascada + archivos del bucket. **Dry-run por defecto** (`applicant_cleanup_enabled`, apagado). ⚠️ **Corregido el 2026-08-19**: además exige **no tener ninguna factura** (ni emitida ni anulada) — ver la entrada de esa fecha | Limpia la basura sin frenar el registro. `registration_step` NO sirve (el register transaccional lo deja null aunque falten archivos/pago), por eso el criterio es "tiene un pago vivo". El flag apagado evita borrados en producción hasta verificar |

## 2026-08-04 — 🧾 Rediseño de facturación: 1 recibo de pago cubre N facturas (revierte "1 factura por cobro")

> Cambio de modelo pedido por Luis: separar **factura** (deuda de UN concepto) de **recibo de
> pago** (documento que cancela deudas). Un pago genera/cubre **N facturas** (membresía + una por
> semana), no una agrupada. **Revierte** la decisión del 2026-07-28 ("1 factura por el total").
> Migración `1752360000000_billing-receipts` + reset de datos de prueba (`npm run db:reset`).
> Verificado por `typecheck` (backend) y `build` (admin) en cada fase.

| Decisión | Motivo |
|---|---|
| **Factura = una deuda de un concepto** (membresía · semana · penalización), número propio, se paga **completa**; estados pendiente → mora → pagada/anulada | Facturación granular; cada línea es un documento trazable |
| **Recibo de pago = documento con número propio** (`payment_submissions.submission_number`) que cubre 1..N facturas; estados pendiente → aprobado/rechazado/**revertido** | El "N° de pago" del negocio; un pago agrupa varias facturas |
| **El recibo GENERA sus facturas al crearse**, `pending` (deuda), ligadas por `invoices.submission_id`; aprobar → pagadas, rechazar → quedan en deuda. Única excepción: registro **sin** pago → 2 facturas de deuda sin recibo | Que un recibo pendiente ya muestre los N° y que un rechazo deje al afiliado debiendo |
| **Vínculos**: `invoices.submission_id` = recibo que la **generó** (null = deuda sin recibo); `charge.submission_id` = recibo que la **pagó** | Distinguir en la reversión lo generado (→ anular) de la deuda solo saldada (→ vuelve a deber) |
| **El pago (método/referencia/comprobante) vive en el RECIBO**, no en cada factura | Una sola fuente del dato del pago; N facturas comparten un recibo |
| **Pago parcial**: el cobro selecciona **qué facturas** cancela (cada una completa); el recibo lleva `invoiceIds` y `settleDebt` salda solo esas | Pagar una factura y quedar debiendo otra |
| **Reversión** de un recibo aprobado con **motivo**: *reembolso* (anula sus facturas) o *corrección* (la deuda saldada vuelve a deber); estado `reverted` con rastro; si pierde la membresía, el chofer vuelve a `pending` | Corregir un pago aprobado por error o devolver dinero, sin borrar documentos (regla #7) |
| **Motor de cobro semanal**: cada semana y penalización nace con **su propia factura de deuda** (antes se emitía sin factura) | Toda deuda es una factura desde que se debe |
| **UI de Facturación** intercambia dos vistas: **Pagos** (recibos) y **Facturas** (por concepto, con el recibo que la pagó); historial del afiliado: una línea por recibo; flechas "Volver" con `location.back()` | Reflejar el modelo factura/recibo en el panel |

## 2026-08-05 — 🧭 Wizard de alta: gate del paso 1 y menú de acciones del vehículo

> Ajustes de UX del panel (`edv-route-admin`); sin backend ni BD. Verificado por `build` (admin).

| Decisión | Motivo |
|---|---|
| **El paso 1 (Datos) es el único requerido y actúa de gate**: no se avanza a los pasos 2-4 sin completarlo; una vez válido, la navegación entre pasos es libre (y volver al 1, siempre) | La lógica ya vivía en `goToStep`/`validateStep1`; lo que la anulaba en local era el flag de desarrollo `environment.unlockSteps`, ahora **apagado** para que dev refleje producción (prod ya lo tenía en `false`) |
| **Componente compartido `shared/components/action-menu`** (kebab ⋮): las acciones de contenedor del vehículo (Editar/Quitar) pasan a un menú; los documentos conservan sus acciones inline | Antes los cuatro pares "Editar/Quitar" (vehículo + documentos) se veían idénticos y en la misma columna: no se distinguía qué acción afectaba a qué. Dos affordances distintos (menú vs inline) separan los niveles. Cierra al clic-afuera/Escape como `app-select`; reutilizable (DRY/SoC) |

## 2026-08-06 — 👥 Aprobación dual del chofer (automática los lunes + manual cualquier día)

> Backend (`enrollment.repository.ts` + nuevo `plugins/auto-approval-scheduler.ts`) y panel
> (`driver-detail`). **Revierte el anclaje "próximo lunes / `scheduled`" del 2026-07-30**
> (que a su vez había rectificado el 2026-07-24). Verificado por `typecheck` (backend) + `build` (admin).

| Decisión | Motivo |
|---|---|
| **Doble vía de aprobación del chofer**, ambas solo si tiene **deuda cero** (membresía pagada + tarifa + sin cargos por pagar; si pagó solo la membresía y debe la tarifa, **no** califica) | El negocio quiere que un chofer en regla arranque los lunes sin gestión, pero pueda empezar antes hablando con el admin |
| **Vía automática**: un nuevo scheduler aprueba **los lunes 00:00** a los `pending` en regla y su tarifa arranca ese lunes (semana completa) | Es el camino por defecto, sin intervención; espeja la reactivación automática del penalizado ("vuelve el lunes siguiente") |
| **Vía manual**: el admin lo aprueba cualquier día; la tarifa se ancla al **lunes de la semana en curso** y queda `active` de inmediato, así que **opera ese día perdiendo los días ya transcurridos** de la semana (su próximo cobro cae el viernes normal) | Permite el "quiero empezar ya"; el costo (perder lun–mar si lo aprueban un miércoles) es del chofer, no del negocio (no se regalan días) |
| **Anclaje unificado**: en ambas vías `enrollment.approve` ancla a `date_trunc('week', now())` + `active`. La única diferencia es *cuándo* corre (auto = un lunes → semana completa; manual = cualquier día → pierde lo transcurrido) | Un solo punto de anclaje; la asimetría la da el día de ejecución, no el código |
| **Solo el chofer se auto-aprueba; el pago sigue exigiendo aprobación manual** del admin (anti-fraude v9). Si el pago se aprueba tarde (tras un lunes), el chofer espera al **siguiente** lunes y su tarifa arranca ahí, **sin re-pagar** | Mientras está `pending` la tarifa está `scheduled` y el motor de deuda la ignora (no consume cobertura); las fechas se re-anclan al aprobar, así que el descuido del admin nunca le cuesta una semana al chofer |
| El chofer en espera **sigue `pending`** con el aviso *"En regla · se aprueba automáticamente el lunes DD/MM"* (sin estado nuevo en el enum) | Menos superficie de cambio (BD/modelos/UI); el estado ya existe |
| El scheduler solo opera con el **motor de deuda encendido** (grilla semanal). El paso 3 del `subscription-scheduler` deja de activar altas (nacen `active`), pero sigue sirviendo a los cambios de plan programados | Coherencia con el anclaje semanal; sin conflicto entre schedulers |

## 2026-08-06 — 💳 Ajustes de UX del flujo de pagos + cards/columnas descriptivas + reversión unificada

> Panel (`edv-route-admin`) y backend (`payment-submissions`, `drivers.repository`). **Sin migraciones**.
> Verificado por `typecheck` (backend) + `build` (admin).

| Decisión | Motivo |
|---|---|
| **Modal "Registrar pago"**: total abajo ("Total a pagar"), **membresía siempre primera y bloqueada**, se elimina el campo "Monto recibido", botón habilitado solo con datos válidos **y** ≥1 factura seleccionada | El monto manual era decorativo (el backend ya lo derivaba de las facturas); la membresía es requisito; el botón permitía enviar $0 |
| **Comprobante opcional en todos los métodos** (antes solo Efectivo Divisa) + **toggle "Aprobar de inmediato"** en los cobros del panel (crea + aprueba en una request; solo `admin`, la app nunca) | Pedido del negocio; la verificación se mueve al momento de aprobar |
| **`buildItems` filtra por `context.invoiceIds`**: la pantalla de aprobación muestra **solo las facturas que cubre el pago** (antes listaba toda la deuda) y el monto cuadra | Bug: el detalle no coincidía con lo cobrado |
| Perfil: banda azul "Pago en revisión" + banda roja "Deuda pendiente" **coexisten** en un pago parcial (antes la roja desaparecía); el list item gana **`debtUsd`** + **`hasPendingSubmission`** | El pago parcial dejaba la deuda restante invisible |
| **Columnas descriptivas** en Afiliados (Tarifa y Estado): etiqueta + subtexto por escenario (Por activar / Al día / Vencida / Falta pago / Pago en revisión / …) en vez de un badge cripto | El estado no se entendía; se busca que sea autoexplicativo |
| **Cards del perfil extraídas a componentes** (`driver-status-card`, `driver-tariff-card`), enriquecidas (acciones de estado en la card; cobertura/precio/próximo cobro dinámicos) y con **mismo alto** (`display:contents`) | Cap de 1000 líneas de `driver-detail.html` + SoC |
| **Skeleton de carga** (`shared/components/skeleton-rows`) en las tablas de lista, en vez de texto "Cargando…"; **resumen de cobro** en el modal "Generar pago" | UX básica y consistente; no se veía el total antes de pagar |
| **Reversión unificada**: se eliminan las opciones "Corrección"/"Reembolso" (hacían lo mismo); **una sola acción** con un texto que dice el efecto real (facturas generadas → anuladas; deuda saldada → vuelve a por pagar). `/reverse` ya no recibe `reversalType`; la columna `reversal_type` queda **sin uso** (limpiar con migración futura) | La distinción prometía comportamientos inexistentes y confundía |

**Documentado aparte para una tarea futura:** `docs/HANDOFF-beneficios-membresia-2026-08-06.md` — los beneficios nuevos del catálogo no llegan a los choferes porque hay que **incluirlos en la versión de la membresía** (editar), no basta crearlos en el catálogo. No es bug; es UX. Sin corregir aún.

## 2026-08-07 — 📄 Paginación numerada global + N° de factura en el historial + separación Facturación / Recibos de pagos

> Panel (`edv-route-admin`) + backend (`payment-submissions`, `billing`). **Sin migraciones.**
> Verificado por `build` (admin) + `typecheck` (backend).

| Decisión | Motivo |
|---|---|
| **Paginación numerada reutilizable** (`shared/components/pagination`, estilo Flowbite Pro, centrada, **10/página**) que reemplaza el pager casero de 2 botones. Solo en listas grandes (Afiliados, Facturación, Documentos, Capacitaciones, Historial de pagos); los catálogos pequeños se dejan sin paginar | Listas con cientos de filas necesitan control; los catálogos acotados no justifican server-side. Un solo componente, sin duplicar markup |
| **Historial de pagos del chofer** pagina server-side de verdad (antes `limit:100` fijo) y muestra **"Cubre factura(s) #N"** por recibo | El endpoint ya devolvía `{items,total}`; un recibo acumula muchas facturas con el cobro semanal |
| **Listado de recibos (`payment-submissions`) agrega `invoiceNumbers`** (N° de las facturas que cubre, vía sus cargos; `null` si aún no hay ninguna), en un subquery — **sin N+1** | Mostrar en el historial a qué facturas corresponde cada pago sin pedir el detalle fila por fila |
| Detalle de pago: el chip de factura pasa a **texto en negrita rojo** al tamaño de la fila; el concepto **"Semana de tarifa" → "Tarifa de la semana"** (renombrado en todos los desgloses: `payment-submissions`, `billing`, perfil) | Ajuste estético + wording del negocio |
| **Separación Facturación / Recibos de pagos**: nueva pantalla `/receipts` (pestañas **Pagos** + **Por aprobar**) y `/billing` queda **solo facturas**. El detalle de recibo sigue en `/billing/submissions/:id` (compartido; vuelve con `location.back()`) | Facturas y recibos son entidades distintas; mezclarlas en una pantalla confundía. Menos superficie por pantalla (SoC) |

## 2026-08-09 — 🗓️ Aprobar el alta = elegir cuándo inicia (2 opciones); se elimina la auto-aprobación

> Panel (`driver-detail`, `driver-status-card`, wizard) + backend (`enrollment.approve`,
> `drivers.service/routes`, scheduler). **Revisa** la doble vía de 2026-08-05 y la
> auto-aprobación de 2026-08-06. Migración `1752370000000` (aditiva). Verificado por
> `migrate` + `typecheck` (backend) + `build` (admin) + validación de la aritmética de lunes.

| Decisión | Motivo |
|---|---|
| **El botón «Aprobar» abre un modal con dos opciones** y `POST /drivers/:id/approve` exige `{ startMode }` (`now` \| `next_monday`, **sin default** — es una elección). No hay un tercer camino silencioso: el `PATCH /:id` con `status:'approved'` solo se permite desde `suspended` (levantar suspensión), nunca desde `pending` | El negocio quiere que el admin decida explícitamente cuándo arranca la tarifa; un default o una vía paralela saltarían esa decisión |
| **Opción «Empezar ya» (`now`)**: ancla al **lunes de la semana en curso**, tarifa `active` de inmediato, chofer `approved`. Es el comportamiento previo (2026-08-06): pierde los días ya transcurridos de la semana | Sin cambios de semántica; solo deja de ser el único modo |
| **Opción «Empezar el próximo lunes» (`next_monday`)**: ancla al **próximo lunes** (hoy si hoy es lunes → semana completa ya). Cuando ese lunes es futuro, la suscripción queda `scheduled` y el chofer entra en el **nuevo estado `driver_status = 'scheduled'`** (programado, `is_available=false`, no opera) | Faltaba la vía "semana completa sin esperar a que el sistema decida"; el estado propio lo hace visible ("Programado · inicia DD/MM") sin ambigüedad |
| **Se elimina la auto-aprobación de los lunes** (`auto-approval-scheduler` borrado). En su lugar, **`scheduled-driver-activation`**: cuando llega el lunes de un chofer `scheduled`, lo pasa a `approved` + disponible y su suscripción a `active`. Sigue siendo automático, pero es una **activación** de algo ya aprobado por el admin, no una aprobación | "Aprobar" vuelve a ser 100% decisión humana; el único automatismo restante es encender al programado en su fecha |
| El motor de deuda **ignora `scheduled`** sin cambios (`debt-scheduler` ya filtra `approved/overdue/penalized`); su suscripción `scheduled` no emite cargos ni consume cobertura hasta activarse | Un programado no debe generar deuda en el intervalo hasta el lunes |

## 2026-08-10 — 📱 Auto-registro (app): alta por flujo `enroll` con semanas + resumen de cobro

> Canal `driver-auth` (backend) para la app `edv-route-mobile`. **Sin migraciones** — reutiliza
> `DriversService.register`, `PaymentSubmissionsService.prepareEnrollContext` y `EnrollmentRepository`
> del panel (pagos v9). Verificado por `typecheck` + endpoints en prod (commit `7c2b1b8` en `main`).
> Detalle para retomar: `edv-route-mobile/docs/HANDOFF-2026-08-10.md`.

| Decisión | Motivo |
|---|---|
| El auto-registro deja la ruta `debt` (simplificada, 1 semana) y usa el **flujo `enroll`** del panel: `driver-auth/payment-submissions` acepta `purpose:'enroll'` + `periods` (semanas). `advance`/`change_plan` **siguen admin-only** (400 desde la app) | El diseño de la app se había inventado un modelo que no existía en el admin; el negocio quiere **semanas adelantadas** y el mismo cálculo que el panel. No salirse del diseño del admin |
| `POST /driver-auth/register` **difiere** el alta (`deferredEnrollment:true`): no emite deuda base; el pago `enroll` la materializa al aprobar (membresía + N semanas) | Un solo camino de dinero, idéntico al `register(true)` del admin; sin deuda huérfana si el pago no llega. La app siempre paga, así que siempre difiere |
| Nuevos catálogos **públicos** `GET /driver-auth/membership` y `GET /driver-auth/subscription-plans`; el **monto lo calcula el servidor** (mismo `WHERE active` + primer plan **semanal**), la app solo lo espeja | La app necesitaba mostrar el total (membresía + tarifa × semanas) **antes** de pagar; calcularlo en el server garantiza **preview == cobro real** sin exponer los endpoints admin (`/memberships`, `/subscription-plans` siguen tras `authenticate`) |
| Tarifa **solo semanal** por ahora: la app **no** ofrece selector de tarifa (fija la semanal), solo de **semanas** | Decisión del usuario; simplifica. Nota: el `enroll` cobra siempre el primer plan semanal → si a futuro hay varios planes, revisar el wizard admin (total mostrado vs cobrado) |
| El **auto-aprobar** de los modales de pago es solo del admin; la app **nunca** auto-aprueba (el chofer no aprueba su propio pago) | Anti-fraude; la aprobación la hace un admin en Facturación → «Por aprobar» |

## 2026-08-10 — 🗓️ «Próximo lunes» = el lunes SIGUIENTE (aun aprobando en lunes)

> Backend (`enrollment.approve`) + panel (`driver-detail`). Refina la doble vía de
> 2026-08-09. **Sin migraciones.** Verificado por `typecheck` (backend) + `build` (admin).

| Decisión | Motivo |
|---|---|
| El modo `next_monday` de la aprobación ahora ancla **siempre al lunes siguiente** (`date_trunc('week', now) + 7 días`), incluso cuando hoy ES lunes (antes anclaba a hoy) | Antes, aprobar en lunes con «próximo lunes» arrancaba HOY (idéntico a «empezar ya»), así que la opción no aportaba nada. Ahora «empezar ya» = este lunes y «próximo lunes» = la semana que viene (queda `scheduled`) |
| En lunes el modal vuelve a mostrar **ambas** opciones; «empezar ya» omite el texto de "pierde días" (hoy es lunes → semana completa, no pierde nada) | UX: en lunes no se pierden días; y el admin puede programar el arranque para la semana siguiente |

## 2026-08-10 — 🔎 Consistencia de listas del admin: filtro de estado + buscador en vivo

> Panel (`receipts`, `billing`, `drivers`) + backend (`payment-submissions`). **Sin
> migraciones.** Verificado por `build` (admin) + `typecheck` (backend).

| Decisión | Motivo |
|---|---|
| **Recibos de pagos**: se reemplazan las 2 pestañas (`Pagos`/`Por aprobar`) por un **filtro de estado** (Todos · Pendiente · Aprobado · Revertido · Rechazado) en **una sola tabla**, con columna **Origen** (Chofer/Admin). «Por aprobar» = filtro Pendiente | Un solo mecanismo de filtro; los 4 estados visibles; el origen importa ahora que los choferes se auto-registran |
| **Backend `GET /payment-submissions`**: se añade `reverted` al enum de `status` (faltaba) y un parámetro **`search`** (nombre del pagador o N° de pago, ILIKE) | El filtro «Revertido» y el buscador lo exigían; el amount/estado ya existían |
| **Buscador en vivo** (debounce 300 ms, Enter también) unificado en **Afiliados, Facturación y Recibos**, siempre **a la derecha** de los chips, mismo estilo/ícono | Consistencia entre las 3 listas; búsqueda al escribir es más intuitiva que solo-Enter |
| **Facturación**: se quita la gráfica «Facturación mensual» (ApexCharts) — queda solo el panel de lista, como Recibos | Pedido del negocio; se limpió el código muerto (`monthlySeries`/`MonthlyInvoicingPoint` en el admin; el endpoint `/invoices/monthly-series` queda sin uso, reutilizable) |

## 2026-08-10 — 🪪 Membresía: beneficios gestionados en la versión (sin catálogo aparte) + regla de versionado

> Panel (`membership` como resumen + nuevo `membership-editor` a **pantalla completa** en
> `/membership/edit`, reemplaza el modal; se elimina `benefits-catalog`) + backend
> (`memberships.repository`). **Sin migraciones.** Verificado por `build` (admin) + `typecheck`
> (backend). Resuelve el HANDOFF `docs/HANDOFF-beneficios-membresia-2026-08-06.md`.

| Decisión | Motivo |
|---|---|
| **Se elimina el catálogo de beneficios como sección aparte.** Los beneficios se crean y se marcan DENTRO del editor de la membresía (crear = queda incluido al instante). Las tablas `benefits`/`membership_benefits` no cambian (sin migración) | La causa del lío eran dos conceptos (catálogo vs. beneficios de la versión): crear un beneficio no lo otorgaba. Ahora hay **un solo lugar** para gestionarlos |
| **El versionado (`hasPayments`) ignora a los choferes `rejected`**: una versión se congela solo si un chofer **no rechazado** la pagó (cualquier estado de pago: pendiente, aprobado, reembolsado). Un rechazado debe re-registrarse y tomará la versión vigente | Antes contaba cualquier fila (incluidos reembolsos de rechazados), congelando la versión para siempre e impidiendo editar in-place |
| La respuesta de `/memberships` incluye **`memberCount`** (choferes no rechazados por versión); el editor **avisa la consecuencia antes de guardar** ("creará versión nueva · N miembros siguen en la actual") | El versionado era un efecto colateral invisible; ahora es explícito. La inmutabilidad por versión (doc v7 #22) queda intacta |
| La edición pasa de un **modal** a una **pantalla completa** (`/membership/edit`, `membership-editor`) | El modal quedaba apretado con la gestión de beneficios |
| **Fix CORS (`app.ts`)**: se agrega `PUT` a `methods`. Sin él, el preflight bloqueaba **cualquier `PUT`** desde el navegador (editar membresía y tarifas, resetear clave de admin) — por eso nunca se había podido editar la membresía | Bug de configuración; el método no estaba en el allowlist. Aplica a todos los `PUT`, no solo membresía |
| El input de **precio** usa `(wheel)` → `blur` para que el scroll del mouse no cambie el valor (los `type=number` suman/restan `step` al hacer scroll: 180 → 179.99) | Footgun de HTML; el mismo guard conviene en los demás campos numéricos de dinero (tarifas, semanas) |

## 2026-08-11 — 📱 Solicitudes desde la app (Fase 1 backend): solicitante ↔ afiliado + arranque desacoplado

> Cambio de negocio: separar las solicitudes de la app del padrón de afiliados y partir el
> registro de la app. Propuesta completa (diseño congelado + máquina de estados + contrato):
> [../proposals/solicitudes-app/README.md](../proposals/solicitudes-app/README.md). Migraciones
> `1752380000000` (estado `applicant` + aprobación de documentos + T&C) y `1752390000000`
> (marcador de inicio de tarifa). **Aplicadas a la BD; el código nuevo aún SIN desplegar** (las
> migraciones son aditivas, el backend en prod sigue operando). Verificado por `typecheck`.
> Fase 1 = backend; el admin (Fase 2) y la app (Fase 3) siguen.

| Decisión | Motivo |
|---|---|
| **Plan B — mismo `drivers`, no tabla aparte**: un registro de la app nace `applicant` (nuevo valor del enum `driver_status`), separado de los afiliados por **vista** (`GET /drivers?source=app&status=applicant`), no por almacenamiento | `documents`/`vehicles` ya cuelgan de `drivers` (FK + CHECK); "solicitante → afiliado" es un `UPDATE status` en vez de migrar filas + archivos del Storage. Reutiliza `source`, la maquinaria de dinero y la auditoría. SoC/DRY/KISS |
| **Registro de la app = solo paso 1** (datos + credenciales + `acceptedPrivacy`): crea el `applicant` sin documentos, vehículos ni dinero; se agregan después con el token (`POST /driver-auth/me/{documents,vehicles}`, nacen `pending`) + un **checklist** (`GET /driver-auth/me/checklist`) | El negocio revisa la solicitud antes de convertirla en afiliado; el registro deja de ser transaccional-todo-al-final y la validación de completitud se muda a la aprobación |
| **Aprobación por documento y por vehículo**: nuevo eje `documents.approval_status` (separado de la vigencia `document_status`, ahora **inerte**; `vehicles.approval_status` ya existía) + `rejection_reason` visible al solicitante. Default `pending` (fail-safe) + backfill de los existentes a `approved` | El admin aprueba cada documento; la solicitud no se aprueba hasta que **todo** esté aprobado y haya ≥1 vehículo. Mezclar revisión con vigencia en un solo enum era el error que ya evitamos en los estados del chofer. `addDocument`/`insertDocument` del **panel** se ajustaron para nacer `approved` (el admin es autoridad) |
| **Aprobar solicitud = aprobar afiliado**: `applicant` → `approved` **con deuda base** (membresía + 1 semana, reusa `enrollDebtOnClient`). Este canal **NO** exige deuda 0 (a diferencia del panel) | El solicitante aprobado ya es afiliado pendiente de pago; la deuda la salda el pago. Colapsa el flujo de 3 a 2 aprobaciones efectivas (documentación + pago) |
| **Arranque de tarifa DESACOPLADO** (ambos canales): la aprobación deja de anclar la tarifa; se establece con `POST /drivers/:id/start-tariff` (`now`/`next_monday`). Marcador **`drivers.tariff_start_set_at`** (NULL = sin establecer); `enrollment.approve` lo sella **atómicamente** al anclar | Un `approved` puede quedar "aprobado pero sin operar" hasta que el admin establezca el inicio; el panel conserva su gate `assertApprovable` (deuda 0), solo se le separa el arranque |
| **El motor de deuda IGNORA a los `approved` sin inicio** (`tariff_start_set_at IS NOT NULL` en emisión, mora y derivación de estado) | Sin ese freno, un afiliado que tarda en pagar el alta acumularía mora de semanas que **aún no ha empezado a usar**. La deuda base se genera al aprobar la solicitud, pero el ciclo semanal automático no corre hasta el arranque |
| 🐛 **El `subscription-scheduler` tampoco auto-arranca a los `approved` sin inicio** (mismo `tariff_start_set_at IS NOT NULL` en el paso 3 que activa suscripciones `scheduled`; fix 2026-08-11) | Bug detectado en prueba: al aprobar la solicitud el afiliado queda `approved` con su suscripción `scheduled`; el scheduler la activaba apenas empezaba su semana (la de la semana en curso), y al establecer «próximo lunes» el re-anclaje de `enrollment.approve` **ya no encontraba una `scheduled` que mover** → las fechas quedaban ancladas a la semana en curso en vez del próximo lunes. El freno lo posterga hasta `startTariff` |
| ✅ **Fechas de período DIFERIDAS al inicio** (raíz del bug anterior): `subscription_payments.period_start/period_end` pasan a **nullable** (mig. `1752400000000`); `enrollOnClient`/`enrollDebtOnClient` crean las semanas **sin fechas** (NULL) y solo `enrollment.approve` (startTariff) las ancla. El re-anclaje ordena por `created_at` (antes por `period_start`, ahora NULL) | Elimina de raíz la clase de bug: hasta establecer el inicio **no existe ninguna fecha de tarifa** que un scheduler o la UI pueda leer mal — solo registro y pago. Antes se anclaban provisionales y se re-anclaban, dejando ventanas donde un consumidor tomaba la fecha equivocada |
| **Gating del pago**: un `applicant` no puede pagar (409); pagar exige `acceptedTerms` (sella `accepted_terms_at`). **Consentimiento**: privacidad al registrar, T&C al pagar (timestamps con rastro) | Un solicitante no aprobado no tiene deuda que pagar; el consentimiento legal se captura con marca temporal |
| **Catálogo público con beneficios** (`GET /driver-auth/membership` ahora trae `benefits[]`) para la pantalla informativa previa | La app muestra beneficios + precio antes de registrar; el monto lo calcula el servidor (preview == cobro) |

## 2026-08-13 — 🔒 Auditoría registro + pagos (previa a la app): correcciones de dinero y anti-fraude (Tanda 1)

> Barrido de auditoría READ-ONLY de todo el proceso de **registro + pagos** (4 frentes: backend
> registro/solicitudes, backend pagos/facturación, frontend wizard, frontend perfil/pagos) antes
> de abrir la app (Fase 3). Se corrigió la **Tanda 1 = críticos de dinero/fraude**. **Sin
> migración** (todo código). Verificado: backend `typecheck` + frontend `build` verdes. Quedan
> pendientes las tandas 2 (robustez de alta) y 3 (limpieza) — ver hallazgos en la sesión.

| Decisión | Motivo |
|---|---|
| **C1 · Resubir un documento reabre la revisión** (`documents.setFileUrl(resetApproval)`): en el canal app/driver, adjuntar un archivo devuelve el documento a `approval_status='pending'` y limpia motivo/revisor. El canal admin **no** resetea (sus docs nacen `approved`) | Cerraba el hueco anti-fraude central de solicitudes-app: un `approved` + resubida dejaba intercambiar el archivo verificado por otro sin re-revisión; y un `rejected` + resubida no volvía a la cola |
| **C2 · Un pago de "deuda total" (`debt` sin `invoiceIds`) bloquea cualquier otro pago pendiente** (`hasWholeDebtPending` + guard en `create`) | Un whole-debt no enumera facturas, así que `reservedInvoiceIds` no lo veía: se podía crear un targeted que cubría una factura ya cubierta por el whole-debt → **doble cobro**. Ahora un whole-debt reserva implícitamente **toda** la deuda |
| **M6 · Guard multi-pending serializado por chofer** (`pg_advisory_xact_lock` + re-chequeo dentro de la transacción de `create`, con `PendingGuardError` de backstop) | Tras quitar el índice único (2026-08-12) el guard corría fuera de transacción (TOCTOU): dos `create` concurrentes podían insertar dos pendientes solapados. El lock los serializa y re-verifica bajo candado |
| **C3 · `pendingCoversAll` (perfil) solo para `debt` sin facturas** (frontend) | `advance`/`enroll`/`change_plan` llevan `invoiceIds=null` pero **no** saldan deuda existente; el corte anterior ocultaba la banda de deuda y el botón "Registrar pago" cuando el motor emitía una semana nueva estando un adelanto en revisión |
| **C4 · Retirada la ruta legacy `POST /drivers/:id/external-payment`** (+ su método de servicio, el wrapper de `enrollment` y el método huérfano del frontend; `settleDebtOnClient` se conserva) | Saldaba deuda al instante con `submission_id = NULL`: sin recibo, sin reserva anti-doble-cobro y **sin rastro reversible** (`reverse` opera por `submission_id`). El frontend ya no la usaba; quedaba expuesta a cualquier token admin |
| **C5 · El motor de deuda congela también la EMISIÓN ante un envío pendiente** (`NOT EXISTS pending submission` en el paso 1 de `debt-scheduler`, igual que los pasos 2/4/5) | Faltaba solo en la emisión: emitir la semana siguiente mientras un recibo espera revisión causaba subcobro (semana saldada por el barrido del approve) o doble cargo (adelanto + emisión de la misma semana) |

## 2026-08-13 — 🧱 Tanda 2: robustez del alta/registro (previa a la app)

> Segunda tanda de la auditoría: los ítems que la **app (Fase 3)** va a estirar. **Sin migración**.
> Verificado: backend `typecheck` + frontend `build` verdes.

| Decisión | Motivo |
|---|---|
| **M1 · `approve-application` idempotente**: guard `AND status='applicant'` en el `UPDATE` **dentro** de la transacción (antes solo se leía el estado fuera de ella) + `23505`→409 | Un doble-click o reintento tiraba **500**; peor: una carrera `approve` + `reject` podía **revertir un rechazo** (dejaba `approved` con deuda pese al rechazo). Ahora solo gana una vez |
| **M2 · El alta factura la tarifa ELEGIDA**: el wizard solo ofrece tarifas **semanales** y envía `planId`; `prepareEnrollContext` lo respeta (validando activo+weekly), con fallback a la única semanal | Con >1 tarifa activa, el wizard mostraba un total con la tarifa elegida pero el backend facturaba "la primera semanal por id" → **monto y plan divergentes** (regla del dinero). Enmascarado con una sola tarifa activa |
| **M3/M4 · Solicitudes rechazadas: política de retención** (decisión de negocio de Luis): un `rejected` **se conserva** (el `applicant-cleanup` deja de purgarlo a los 7 días) y su cédula queda **bloqueada** para auto-registro; el solicitante debe **contactar al admin**, que puede **reabrirla** (`POST /reopen-application`, `rejected`→`applicant`) | El reintento self-service prometido antes chocaba con `national_id` UNIQUE. La nueva política da control humano: nada se re-registra solo; el admin decide. El cleanup ahora solo purga `pending` sin pago y `applicant` **vacíos** (sin docs ni vehículos) vencidos |
| **UI de reapertura**: la lista de **Solicitudes** gana un filtro **En revisión / Rechazadas**; el detalle de una rechazada ofrece **"Reabrir solicitud"** (modal de confirmación) | Sin visibilidad de las rechazadas el admin no podía actuar sobre ellas; el filtro + el botón cierran el flujo de reapertura de punta a punta |

## 2026-08-13 — 🚀 App del chofer (Fase 3) desplegada + gotcha de conexiones

> El backend de **solicitudes-app + auditoría (Tanda 1/2) + `GET /me/debt`** se **desplegó a
> prod** (commit `8ac8530`) para habilitar la **app del chofer** (Flutter, `edv-route-mobile`),
> cuya Fase 3 quedó completa (informativa → registro paso 1 → checklist → pago diferido `debt`).
> APK entregado a Luis. `typecheck` verde; servidor nuevo verificado activo.

| Decisión | Motivo |
|---|---|
| **App re-arquitecturada al modelo `applicant`** (no `enroll`): registro paso 1 (`/register`) → checklist (`/me/checklist`) → `/me/{documents,vehicles}` → pago diferido `purpose='debt'` + T&C; nuevo **`GET /driver-auth/me/debt`** (total + desglose + `hasPendingPayment`) | El backend evolucionó a solicitudes-app; el wizard monolítico de la app enviaba docs/vehículos en `/register` (rechazado por `additionalProperties:false`). El pago se difiere a tras la aprobación |
| **⚠️ No correr dos backends contra la BD compartida**: prod y dev usan el mismo Supabase (**15 conexiones**). Railway + `npm run dev` local agotan el pool → `EMAXCONNSESSION` y **pantallas en blanco**. Mitigación: uno solo; el panel local se apuntó a Railway temporalmente | Riesgo asumido de prod=dev; fix de fondo pendiente: Supabase separado para prod |
| 🐛 **`request-detail` del panel: `load()` movido del constructor a `ngOnInit`** | Leer el input requerido `id` en el constructor lanza `NG0950` → el detalle de la solicitud quedaba **en blanco** |

## 2026-08-14 — 💳 Adelanto de semanas en el pago del alta (Forma A) + candado de veredicto + preview de documentos

> Iteración sobre la app del chofer y el panel a partir del smoke en vivo. Backend `typecheck` verde;
> app `flutter analyze` + 16 tests verdes. Backend y panel desplegados a prod; APKs entregados.

| Decisión | Motivo |
|---|---|
| **Adelanto de semanas en el pago del alta (Forma A)**: el pago `debt` de la app acepta `periods` (total de semanas ≥1). Cubre la deuda base (membresía + 1 semana) + `periods−1` semanas extra. Las extra se **crean pagadas AL APROBAR** el recibo (`enrollment.addPaidAltaWeeksOnClient`), no al registrarlo, con `period NULL` para anclarse junto a la base al «Establecer inicio» | Permite prepagar sin **doble cobro de membresía** (nunca crea una segunda `membership_payments`) ni **deuda fantasma** si se rechaza (las extra no existen hasta aprobar). Reversión limpia: van ligadas al recibo, `reverseReceipt` las anula. Se descartó la «Forma B» (borrar/recrear la deuda) por frágil |
| **Veredicto de documento/vehículo firme en el panel**: `Aprobar`/`Rechazar` solo se muestran en «En revisión»; un documento/vehículo aprobado o rechazado deja solo `Ver`. Se reabre a `pending` cuando el chofer resube el archivo | Evita cambiar por accidente un veredicto ya dado; coherente con la puerta anti-fraude (resubir reabre la revisión) |
| **Preview del documento propio en la app**: nuevo `GET /driver-auth/documents/:id/file` (URL firmada 60 s + validación de propiedad, reutiliza `getFileUrl` con `ownerUserId`). La app muestra imágenes inline y abre PDF con el visor del sistema (`url_launcher`) | El chofer no tenía forma de ver lo que subió; el GET equivalente estaba bajo guard de admin |
| **App: checklist re-arquitecturado a hub** (Documentos / Vehículos → lista → detalle por documento con motivo de rechazo + reemplazo hasta que se apruebe), recarga automática de estado al reanudar/refrescar, y **correo confirmado opcional** en todo el stack | Feedback de Luis: navegación clara, ver/reemplazar documentos sin reiniciar sesión, y llegar solo a la pantalla de pago tras la aprobación |

## 2026-08-18 — 👤 Estado de cuenta del chofer + edición de datos + foto de perfil

> Perfil del afiliado completado en la app: el estado de cuenta real (hasta cuándo está cubierto,
> próximo cobro, penalización), la edición de sus propios datos y la foto de perfil, que sale también
> en todos los avatares del panel. Backend `typecheck` verde y verificado **contra la BD real**
> (`getAccount` y el `findDetail` refactorizado devuelven lo mismo que antes); panel `ng build` verde;
> app `flutter analyze` limpio y **22 tests verdes**. Sin desplegar todavía.

| Decisión | Motivo |
|---|---|
| **Los fragmentos SQL del dinero se comparten** (`drivers/billing-sql.ts`: `DEBT_CHARGE_PREDICATE`, `upcomingChargeSql`, `paidUntilSql`, `SUBSCRIPTION_PRIORITY`), parametrizados por el alias del que cuelgan, y los consumen **el panel** (`findDetail`) y **la app** (`getAccount`) | La alternativa era llamar a `findDetail` desde el móvil (187 líneas de SQL que materializan vehículos, documentos, imágenes y facturas **en cada apertura del perfil**) o copiar el SQL a mano (dos definiciones de «al día» que divergen al primer fix). El texto SQL de `findDetail` no cambió: mismo comportamiento en prod, solo movido a constantes |
| **`GET /me/account` distingue `upcoming` de `nextChargeAt`** y son excluyentes | Son cosas distintas: un cargo **ya emitido** es pagable por adelantado; uno no emitido solo se anuncia. El candado de `weeklyNextChargeAt` (plan semanal **activo**) se replica del panel; sin él la app le pintaría fecha de cobro semanal a quien no tiene plan semanal |
| **`reactivates_at` se expone por primera vez** (lo escribe el motor desde siempre y no lo mostraba nadie) | Un penalizado que **ya pagó** sigue bloqueado hasta ese momento: sin el dato veía «al día» sin entender por qué no podía operar |
| **El estado del chofer sale de `drivers.status`, no del total adeudado** | Ya viajaba en `/me`; el hueco estaba en la app, que colapsaba `overdue`/`penalized`/`paused`/`scheduled` a `unknown` y pintaba igual a un deudor que a uno al día |
| **`PATCH /driver-auth/me` con lista blanca corta** (teléfono, correo, dirección, clave) — **nunca** nombres ni cédula | Reutilizar el `PATCH /drivers/:id` del admin habría dejado al chofer **cambiar su propia cédula y su status**: reescribiría la identidad que un admin verificó contra documentos aprobados. Cambiar la clave exige la clave actual (OWASP): una sesión robada no debe bastar para dejar fuera al dueño |
| **Foto de perfil en el bucket privado, firmada 1 h y en lote** (`getSignedUrls`: un POST por página en vez de uno por fila) | Se descartó el bucket público (expone la cara de cualquier chofer a quien adivine la URL, sin caducidad) y el proxy por el backend (todo el ancho de banda de cada lista pasando por Railway). El TTL largo es deliberado: el avatar sale en cada fila y el cliente cachea por URL; una cara no es una cédula |
| **Componente `app-avatar` compartido en el panel** (foto + caída a iniciales, incluida la firma vencida) | Las iniciales estaban escritas a mano en cuatro sitios (lista de afiliados, detalle, lista de solicitudes, detalle de solicitud) |
| **Un chofer con deuda —incluido el `penalized`— ENTRA a la app; lo que pierde es el trabajo** (nada de viajes ni beneficios; se irán limitando más funciones). El candado es `DriverStatus.canOperate` en cada función, nunca en la entrada | Decisión de Luis (2026-08-18). Cerrarle la app sería cerrarle la única pantalla donde puede **ver y pagar** lo que debe: quedaría penalizado sin manera de salir |
| **Una sola definición de deuda en todo el sistema** (`debtChargePredicate`): había **seis copias**, y las de la lista de afiliados y el `/me/debt` de la app **no comprobaban la cobertura pagada** | Tras un adelanto de semanas (Forma A) la cobertura se corre hacia adelante; una semana marcada como adeudada que cae **dentro** de lo ya pagado hacía que la lista y la app cobraran **$10 de una deuda inexistente** mientras el detalle decía $0. El motor de deuda siempre aplicó la regla correcta; ahora todos usan la suya. Verificado: los importes no cambian con los datos actuales |

## 2026-08-18 (tarde) — 🔒 La reserva de facturas pasa a ser una relación + incidente del motor

> Decisión de Luis tras plantear la disyuntiva **varios pagos pendientes vs. uno solo**: se
> **mantienen varios**. El argumento que decide no es la flexibilidad, es que con un solo pago
> pendiente el chofer queda bloqueado hasta que un admin revise, y si la revisión tarda entra en mora
> —y luego en penalización, que le quita el trabajo— **por la latencia de la oficina, no por la suya**.
> Además el pago ya ocurrió en el banco: negarse a registrarlo no lo deshace, solo desactualiza el
> sistema.

| Decisión | Motivo |
|---|---|
| **Se mantienen varios pagos en revisión** por chofer | Ver arriba. Y no es una puerta abierta: como cada pago reserva las facturas que cubre, el techo natural es el número de facturas que debe |
| **Qué facturas cubre un pago deja de ser un JSON y pasa a ser una tabla** (`payment_submission_invoices`, mig. `1752420000000`) con FK a `invoices` (RESTRICT) e índice único parcial: **una factura, un solo pago pendiente** | La lista vivía en `context->'invoiceIds'`: una clave foránea escondida en un blob, sin integridad referencial y —lo grave— **sin ninguna restricción que pudiera vigilar la invariante**. Al permitir varios pendientes (2026-08-12) la garantía quedó solo en código (lock consultivo + re-chequeo, correcto hoy), así que cualquier camino de inserción futuro cobraría dos veces la misma factura sin que nada chillara. El dinero no puede depender de que todos los llamadores futuros se acuerden |
| **El estado del recibo se copia a la tabla por trigger** | Un índice parcial no puede mirar otra tabla. Con trigger la garantía se queda en la base: probado que rechaza el duplicado **incluso si el llamador miente** sobre el estado, y que aprobar/rechazar **libera la reserva sola** |
| **Expandir/contraer**: la migración solo añade; el código escribe la tabla (fuente de verdad) y mantiene el JSON como espejo | Prod y dev comparten base y prod corre todavía la versión anterior, que lee el JSON. Borrarlo ahora rompería los pagos parciales en vivo. La migración de contracción va después de desplegar |

### ⚠️ Incidente: la suite de tests apagó el motor de deuda de producción

`tests/helpers/db-fixtures.ts` restauraba los ajustes del motor a valores **fijos** con el
interruptor en **false**. Como `app_settings` es global y la suite corre contra la **misma base que
producción**, bastaba con correr `npm test` para dejar el motor de cobro **apagado**: sin emisión
semanal, sin mora, y en silencio. Ocurrió hoy a las 14:35 UTC y estuvo apagado ~45 minutos; se
restauró a `true` (había emitido cargos reales el 14 y el 17). **Arreglo**: el helper ahora
**fotografía** los ajustes antes de tocarlos y restaura *eso*, no una constante — restaurar un valor
fijo no es restaurar, es sobrescribir.

**Estado de la suite**: 22/30 en verde (venía de 19/30 **en `main`**, o sea rota en lo que está
desplegado). Se arreglaron: el fixture creaba un chofer **sin fecha de inicio de tarifa**, al que el
motor —correctamente, desde 2026-08-11— se niega a mover; y el test que exigía «un solo pago
pendiente», que afirmaba la regla revocada, ahora verifica la vigente (varios sí, dos sobre la misma
factura no). **Quedan 8 rojos** sobre el enlace factura↔recibo, anteriores a este cambio y sin
diagnosticar.

## 2026-08-18 (noche) — 🐞 Dos bugs de producción que la suite roja tapaba

> Al poner al día los 8 tests que quedaban rojos aparecieron **dos fallos reales
> en código desplegado**. Ninguno era un problema de las pruebas: las pruebas
> tenían razón y llevaban días gritando sin que nadie las oyera. Suite: de 19/30
> a **29/30**.

| Bug | Qué pasaba |
|---|---|
| **La multa por penalización NUNCA se pudo emitir.** `debt-scheduler` línea 268: `make_interval(weeks => $1)` fallaba con *«function make_interval(weeks => numeric) does not exist»* y **abortaba el tick completo** | El mismo parámetro `$1` (`penalty_weeks`) se usa antes en `p.price_usd * $1`, y esa multiplicación tipa el parámetro como **numeric** para toda la sentencia; `make_interval` solo acepta enteros. El chofer sí pasaba a `penalized` (paso 4) pero la multa (paso 5) reventaba, y con ella el resto del tick: los registros de auditoría de esa pasada no se escribían. Arreglo: `$1::int`, el mismo casteo explícito que ya usaba `billing.repository` |
| **El método y la referencia de pago de un alta hecha por el admin no se veían en ninguna parte.** El listado y el detalle de facturas leían esos datos **solo desde el recibo** | Hay dos escritores: el flujo v9 (recibo) y `enrollment.setInvoicePaymentMeta`, que los estampa en las **columnas de la factura** cuando el admin inscribe directo, sin recibo. Al mudar la lectura al recibo (rediseño 2026-08-04) el segundo escritor quedó huérfano: el admin escribía la referencia y desaparecía de la vista. Arreglo: `COALESCE(recibo, factura)` en los dos queries, más `hasProof` que vuelve a mirar el `proof_url` heredado |

**Tests puestos al día** (todos describían diseños que se cambiaron a propósito y
nadie volvió a mirar): el adelanto emite una factura **por semana**, no una
agrupada · un alta sin pago emite **una factura por concepto** (2, no 1) · una
factura tiene **un solo cargo**, así que «pago parcial de sus cargos» ya no puede
existir y se reemplazó por la derivación real (pendiente → Emitida, vencido →
Vencida, pagado → Pagada con la fecha de su cargo) · el endpoint
`/external-payment` **ya no existe**: saldar por fuera es un recibo aprobado · el
recibo de un `enroll` debe crearse **por el repositorio**, que es quien genera sus
cargos, no con un INSERT a mano.

### ⚠️ Por qué la suite no puede llegar a 30/30 hoy

El test que queda rojo **rota**: unas veces es «no cobra una semana ya cubierta»,
otras «un cargo pendiente para este chofer», y a veces pasan las dos. Siempre por
lo mismo: encuentra **un cargo de más**. Lo emite el scheduler de **producción**,
que tickea sobre la misma base mientras las pruebas corren.

Además, al arreglar el fixture (darle fecha de inicio de tarifa al chofer de
prueba, sin la cual el motor lo ignora) esos choferes pasaron a ser **visibles
para el motor de producción**. Es correcto para lo que la prueba quiere medir, y
deja el problema a la vista: **las pruebas de integración de un scheduler no
pueden compartir base con una instancia viva de ese mismo scheduler**. No se
arregla aflojando aserciones de dinero; se arregla separando la base de dev. Hoy
eso ya no es deuda estructural: es lo único que impide una suite verde.

## 2026-08-18 — 🚗 Con qué vehículo trabaja el afiliado

> `drivers.current_vehicle_id` existía desde el diseño original de la BD y **nadie
> la escribía nunca**: solo se leía, así que todos los choferes figuraban sin
> vehículo en uso. Ahora la maneja el afiliado desde la app.

| Decisión | Motivo |
|---|---|
| **La elección es del AFILIADO, no del admin** (`PATCH /driver-auth/me/vehicles/:id/primary`) | Decisión de Luis. El admin aprueba vehículos; con cuál de los suyos trabaja lo decide él |
| **Elegir uno libera el anterior solo** | Una sola columna guarda la respuesta: es imposible acabar con dos activos, no porque el código se acuerde sino porque no cabe |
| **Solo se puede elegir un vehículo APROBADO** (única regla) | Uno en revisión o rechazado no pasó el control de documentos; dejarlo trabajar con él haría inútil esa revisión. La app ni ofrece el botón, y el backend lo rechaza con 409 aunque se intente por fuera |
| **Con UN solo vehículo aprobado se asigna solo** (al aprobarlo, y migración `1752440000000` para los 5 que ya estaban así) | No contradice lo anterior: elegir entre una sola opción no es elegir. Desde el segundo vehículo aprobado nunca vuelve a tocarlo — decide él. Sin esto, cinco afiliados con su único vehículo aprobado figuraban sin ninguno en uso, y al llegar Viajes eso sería un «no puedo trabajar y no sé por qué» |

**Gotcha de Postgres encontrado al escribir la migración:** no existe `min(uuid)`.
La primera versión agrupaba por chofer para sacar «su único vehículo» y falló;
node-pg-migrate revirtió limpio. Se reformuló uniendo directo al vehículo, ya que
la subconsulta de conteo garantiza que hay exactamente uno. Es el mismo tipo de
fallo que la multa de penalización (`make_interval(weeks => numeric)`): funciones
de Postgres que no aceptan el tipo que se les pasa, y que solo se ven al ejecutar.

## 2026-08-18 — ✅ Aprobación de documentos y vehículos, por canal

> Regla de Luis: **el admin es la autoridad**. Lo que registra él ya está
> verificado; lo que llega desde la app se revisa a mano.

| Regla | Dónde |
|---|---|
| Vehículo o documento registrado **por el admin** nace `approved` | Ya era así (`drivers.service.addVehicle` / `addDocument`) |
| Vehículo o documento que llega **desde la app** nace `pending` | Ya era así (`applications.service.addApplicant*`) |
| **Reemplazar un archivo**: si lo reemplaza el **chofer** vuelve a `pending` (puerta anti-fraude: no puede cambiar un archivo ya aprobado por otro); si lo reemplaza el **admin** queda `approved` y él consta como revisor | **Nuevo.** `setFileUrl` pasa de un booleano a un modo explícito (`reopen`/`approve`). El admin reemplaza porque cargó el archivo equivocado; obligarlo a aprobar su propia corrección es un paso que no decide nada |
| El veredicto **solo se ofrece mientras está pendiente** y **rechazar exige motivo** | Ya regía en el detalle de solicitud; ahora vale igual en el detalle del afiliado y en la página del vehículo |
| **Un vehículo no se aprueba hasta que TODOS sus documentos estén aprobados** | Un vehículo se aprueba aprobando sus papeles: mientras uno esté pendiente o rechazado no hay nada verificado que aprobar. El botón se deshabilita diciendo cuántos faltan, y el backend lo rechaza con **409** nombrando los documentos — la regla no vive solo en la pantalla |

**Panel:** el veredicto existía solo en el detalle de **solicitud**. Ahora también
en el **detalle del afiliado** (sus documentos) y en la **página del vehículo** (el
vehículo y sus documentos), con el motivo del rechazo visible. Las rutas del
backend ya existían: era interfaz que faltaba.

Al añadirlo, `driver-detail.ts` volvió a pasar de 1000 líneas y la lógica quedó
duplicada en tres pantallas, así que se extrajo a `ReviewPromptService` +
`<app-reject-prompt>`: una sola implementación con las dos reglas dentro, y el
archivo bajó a 978.

## 2026-08-19 — 🧾 Una semana emitida no es deuda hasta que empieza

> Luis vio a un afiliado **solvente** con una tarjeta roja de «Deuda pendiente».
> No era la redacción: estaba mal clasificado.

**El fallo.** El criterio que separaba deuda de próximo cobro era, textualmente,
«una semana pendiente **sin factura** es el próximo cobro, no deuda». Pero el
motor **crea una factura con cada semana que emite** (`debt-scheduler`, paso 1),
así que esa condición no se cumple nunca: **toda semana emitida contaba como
deuda desde el momento de crearse**, días antes de que el chofer la debiera.

Se veía así el 19/08 (miércoles):

| Afiliado | Realidad | Mostraba |
|---|---|---|
| V-26963147 | Semana en curso PAGADA; la del 24→31 emitida | «Deuda $10» estando solvente |
| V-22198958 | 1 semana vencida + la del 24→31 emitida | «Deuda $20» cuando debía $10 |

**La regla nueva** (`debtChargePredicate`), que es lo que el diseño quería decir:

| Cargo pendiente | ¿Deuda? |
|---|---|
| Sin fecha de período (deuda del alta, aún sin anclar) | **Sí** |
| Su semana ya empezó | **Sí** |
| Su semana empieza en el futuro (emitida el viernes para el lunes) | **No** — es el próximo cobro |

**Consecuencia asumida** (decisión de Luis): pagar «toda la deuda» ya **no**
incluye la semana siguiente. Adelantarla es una acción aparte y deliberada, que
ya existe. Quien antes pagaba todo y quedaba cubierto ahora debe adelantar a
propósito o caerá en mora el lunes.

En el panel, la semana emitida se muestra **aparte y sin sumarse** al total, para
que el admin la vea venir sin confundirla con un atraso. Verificado tras el
cambio: V-26963147 $0 (antes $10), V-22198958 $10 (antes $20), los dos del alta
sin cambio ($190), y panel y app diciendo lo mismo en los cuatro.

## 2026-08-19 — El chofer se entera de que le rechazaron el pago

**Hallazgo del smoke E2E en vivo** (el que cerró el pendiente del adelanto de
semanas, Forma A). Al rechazar un pago desde el panel, la app del chofer
**volvía a mostrar la pantalla de pago como si nunca hubiera enviado nada**: sin
aviso, sin monto y sin motivo. El dato estaba bien guardado y el panel lo pintaba
perfecto (`rejectedSubmission` en `GET /drivers/:id`), pero al canal de la app
nunca se le devolvió: `GET /driver-auth/me/debt` respondía solo `totalUsd`,
`items` y `hasPendingPayment`.

Consecuencia real: el chofer no podía saber que lo rechazaron ni por qué, y nada
le impedía reenviar exactamente el mismo comprobante una y otra vez, mientras la
oficina daba por hecho que ya le había respondido.

| Decisión | Motivo |
|---|---|
| `GET /driver-auth/me/debt` devuelve **`rejected`** (`amountUsd`, `reason`, `reviewedAt`) | El chofer tiene que poder corregir; el motivo que escribe el admin es la instrucción |
| Cuenta **solo el último envío** — mismo criterio que el panel | Enviar un pago nuevo apaga el aviso **solo**, sin código ni estado extra que mantener |
| La tarjeta va **encima** del desglose en la pantalla de pago | Es lo primero que necesita leer quien viene a reintentar; debajo del monto pasa desapercibida |
| Se declara en el **schema de respuesta** | Fastify serializa contra el schema: un campo no declarado se borra en silencio |

**Nota de alcance:** esto es la primera pieza del bloque de avisos, y es
deliberadamente **independiente de las notificaciones push**. Un push avisa en el
momento, pero si el chofer lo desliza o su teléfono no los recibe (Huawei sin
Google Play Services, permiso denegado), al abrir la app tiene que encontrar la
información igual. El aviso dentro de la app es el suelo; el push es el aviso.

## 2026-08-19 — Un botón bloqueado tiene que parecer bloqueado

Mismo smoke: el botón de aprobar un vehículo con documentos sin resolver **sí**
estaba deshabilitado (y el backend lo rechaza con 409), pero pintado con el color
de acción al 50% de opacidad **sigue leyéndose como disponible**, y el motivo
vivía en un `title`: un tooltip que exige ratón y un segundo de paciencia, y que
en pantalla táctil no existe.

**Regla:** cuando una acción está bloqueada por una precondición del negocio, el
botón se pinta **gris** (no su color al 50%) y el motivo se muestra **a la vista**
—junto al botón o en una franja bajo él—, nunca solo en un `title`. Aplicado a
los cuatro botones con precondición: aprobar vehículo, aprobar afiliado, aprobar
solicitud y aprobar documento sin archivo.

## 2026-08-19 — Revertir un recibo no debería perdonar la deuda

Al revertir el recibo de alta de un afiliado (V-23654789), el panel dejó de
mostrarle deuda. **No era un fallo**: `reverseReceipt` anula las facturas que ese
recibo **generó** y reembolsa sus cargos, así que no queda deuda — queda vacío, y
el chofer vuelve a `pending`. La pantalla decía la verdad.

El problema es que **revertir tiene dos motivos y el sistema los trataba igual**:

| Motivo | Qué debe pasar |
|---|---|
| El recibo nunca debió registrarse (error de captura, afiliado equivocado) | El chofer no queda debiendo. Es lo que ya hacía |
| **El pago rebotó** (transferencia devuelta, comprobante falso) | **El chofer SIGUE debiendo** — y el negocio se lo estaba perdonando sin querer |

Y el afiliado quedaba en un callejón: `pending` sin deuda no puede pagar desde la
app (un `pending` ni siquiera llega a la pantalla de pago) y en el panel la única
salida era «Registrar pago», que da por hecho que ya te pagó.

| Decisión | Motivo |
|---|---|
| **`POST /drivers/:id/alta-debt`**: vuelve a emitir la deuda del alta | Devuelve al negocio la factura con la que reclamar, y al chofer la pantalla donde pagar |
| **No es automático al revertir** — el admin lo decide | Solo él sabe si el dinero rebotó o si el recibo fue un error; adivinarlo sería peor que preguntarlo |
| `enrollDebtOnClient` **reutiliza** la suscripción `scheduled` en vez de crear otra | Hay índice único de una sola `scheduled` por chofer: crear la segunda reventaba. Los registros nuevos no tienen ninguna, así que ahí nada cambia |
| El botón vive en la tarjeta de **Estado**, junto al aviso de que falta la membresía | El aviso ya nombra el problema; la acción que lo resuelve va pegada a él |

## 2026-08-19 — Quien debe, paga: el estado no puede cerrarle la puerta

Probando en el teléfono lo anterior salió el fallo de verdad: la app enrutaba
**solo por `status`**, así que un afiliado `pending` caía en «Solicitud en
revisión» y **no tenía forma de pagar**, aunque debiera $190 y sus facturas
estuvieran emitidas. El backend nunca lo impidió — su única puerta cerrada es
para `applicant` (`assertPayableAndAcceptTerms`) — y se comprobó en vivo: un
`pending` envía su pago y el backend responde **201**.

No era un caso raro del recibo revertido: **todo registro por panel sin pago**
deja al afiliado exactamente así. Había dos en la base viviéndolo.

| Decisión | Motivo |
|---|---|
| Un `pending` entra a la **pantalla de pago**, no al aviso de revisión | Si debe, tiene que poder pagar; el estado dice de quién es el turno, no si se le cobra |
| La pantalla decide con la **deuda**, no con el estado: `altaScreenState()` | La deuda es el hecho; el estado es contexto. Y si no debe nada, esa misma pantalla muestra el aviso de revisión |
| La regla vive **fuera del widget**, en una función pura con 8 pruebas | Era una cadena de `if` dentro de un `build`, imposible de probar, y ya se había desincronizado del `initState`, que tenía su propia copia |

**Orden de la regla** (importa): un pago ya enviado gana sobre la deuda (no se
paga dos veces) y la deuda gana sobre todo lo demás.

## 2026-08-19 — La limpieza de solicitantes no puede llevarse dinero

Apareció en el log del backend, en **dry-run**: el limpiador tenía marcado para
purgar a un afiliado (`V-23654789`) al que acabábamos de **volver a emitirle la
deuda del alta** — $190 en dos facturas recién emitidas. Con
`applicant_cleanup_enabled` encendido lo habría borrado, y el borrado en cascada
incluye `DELETE FROM invoices`: se habría llevado las facturas y la deuda con él.
Choca de frente con la **regla 7** (un documento de dinero se anula con rastro,
nunca se borra).

El criterio no estaba mal escrito, **se quedó viejo**. «`pending`, vencido el
plazo y sin pago vivo» describía un alta abandonada que no debía nada. Ya no:
un **registro por panel sin pago** y una **deuda de alta re-emitida tras revertir
un recibo** dejan exactamente esa firma — pero con facturas emitidas y dinero por
cobrar. Le habría tocado a más gente: basta con rechazarle el pago a cualquier
`pending` para que entre en la lista con sus facturas a cuestas.

| Decisión | Motivo |
|---|---|
| Tener **cualquier factura** (emitida **o anulada**) excluye al chofer de la purga | Una anulada también es un documento que se conserva. El criterio de selección deja de adivinar si hay dinero: si hay factura, no se toca |
| El borrado en cascada **se niega** si el chofer tiene facturas, dentro de su transacción | Defensa en profundidad: el criterio de selección puede volver a quedarse viejo; el borrado no debe depender de que alguien lo recuerde |
| 3 pruebas nuevas en `tests/applicant-cleanup.test.ts` | Fijan las tres respuestas: sin facturas es candidato, con factura emitida no, con factura anulada tampoco |

**Verificado sobre la base real**: con la regla anterior el limpiador señalaba a
1 afiliado; con la nueva, **cero**.

## 2026-08-20 — El vehículo se arma en el teléfono, no en el servidor

**Cambio de flujo pedido por Luis.** Hasta ahora la app construía el vehículo en
el servidor a pedazos: crear el vehículo (ya queda en la BD) → subir una foto →
crear un documento → adjuntarle el archivo… Ocho llamadas encadenadas donde
cualquier fallo de red dejaba **medio vehículo** guardado y metía un registro
incompleto en la cola de revisión del admin.

Ahora el vehículo se arma como **borrador local en el teléfono**, editable campo
a campo (datos, foto y documentos) mientras el afiliado quiera. Solo cuando está
completo se habilita **«Enviar a revisión»**, con un modal que avisa de que
después ya no podrá editarlo. **El servidor nunca ve un vehículo a medias.**

| Decisión | Motivo |
|---|---|
| **Un endpoint transaccional** (`POST /driver-auth/me/vehicles/submit`) en vez de encadenar los ocho de hoy | Encadenarlos desde la app deja el mismo problema: un fallo a mitad vuelve a dejar medio vehículo en el servidor |
| Los archivos suben al bucket **antes** de la transacción | Un objeto huérfano es inofensivo y se limpia; una fila a medias, no. Mismo patrón que los pagos |
| **Una sola foto** por vehículo, y **obligatoria** desde la app | El admin necesita con qué comparar los papeles; hoy es opcional y hay vehículos aprobados sin ninguna imagen. Las que ya tienen 2 o 3 se **conservan**; el límite rige de aquí en adelante, también en el panel |
| Tras enviar, el **chofer** no edita nada… salvo lo **rechazado** | Es el candado anti-fraude que ya existía para los documentos, ahora también para el vehículo |
| Un **vehículo rechazado vuelve a ser editable** entero y se reenvía | El caso real es una placa mal escrita o una foto ilegible; obligar a cargarlo todo de nuevo castiga al afiliado por un error de un campo |
| Los vehículos que registra el **admin** nacen `approved` y se editan **siempre** | Él es la autoridad y suele cargarlo con la persona delante; el candado es para el canal de la app |
| Un **solo borrador** a la vez | No hay razón para llenar dos vehículos a medias, y evita una lista de borradores que habría que explicar |

Los endpoints antiguos (`POST /me/vehicles`, `/me/documents`, `/vehicles/:id/images`)
**se quedan** mientras haya APK instalados que los usen; se retiran cuando la app
nueva esté desplegada.

## 2026-08-20 — Fase 2: los candados del vehículo (y su salida)

Con el envío completo ya en pie, las reglas que lo sostienen. Sin ellas el flujo
nuevo sería una recomendación: el backend seguía aceptando que el chofer
reemplazara cualquier documento suyo mientras no estuviera aprobado, **incluido
uno en revisión**, que es justo la puerta que este cambio cierra.

| Decisión | Motivo |
|---|---|
| Un documento **de vehículo** solo se reemplaza si está **`rejected`** (409 si no) | Enviado el vehículo, sus papeles quedan cerrados. El rechazo es la única llave, y trae el motivo que dice qué corregir |
| Los documentos **personales** no cambian | Su flujo es otro (nacen sin archivo y se suben sueltos); tocarlo rompería el checklist del registro. Si más adelante se quiere el mismo candado, es una línea |
| El **admin** nunca se bloquea | Es la autoridad; corrige su propia carga |
| **`POST /me/vehicles/:id/resubmit`** para el rechazado | Un candado sin salida es un bug: sin esto, un vehículo rechazado dejaba al chofer encerrado — el mismo error que ya cometimos con el `pending` sin deuda |
| Los archivos sustituidos se borran **después** del commit | Borrarlos antes dejaría al chofer sin nada que mostrar si la escritura falla |
| Las rutas viejas se leen **antes** de sobrescribirlas | Dentro de `RETURNING` la columna ya trae el valor nuevo: leerla ahí habría dejado los archivos viejos en el bucket para siempre (encontrado al revisar, antes de desplegar) |
| El límite de fotos cuenta **cuántas hay**, no busca hueco libre | Con vehículos de 3 fotos heredadas, buscar el primer hueco dejaría reemplazar una borrada y volver a 3. Las heredadas se conservan; simplemente no admiten otra |

## 2026-08-20 — Fase 4: una sola foto también en el panel

Cierra el cambio de flujo del vehículo. El límite estaba escrito **tres veces**
en el panel (`vehicle-form`, `vehicle-draft-modal` y el detalle del vehículo),
que es exactamente cómo un límite acaba diciendo 3 en una pantalla y 1 en otra.
Ahora vive en `core/models/vehicle-photos.ts` y los tres lo leen de ahí.

Encontrado al bajarlo: el detalle calculaba los huecos libres como
`maxPhotos - images.length`, que en un vehículo con las **3 fotos heredadas** da
**-2**, y `slice(0, -2)` no descarta archivos, los conserva. Habría dejado subir
fotos justo en los vehículos que ya estaban por encima del límite. Corregido con
un piso en cero.

Los vehículos que ya tienen 2 o 3 fotos **las conservan y se siguen viendo
todas**; simplemente no admiten otra. El contador dice «3» en vez de «3/1»,
porque un contador que se lee como roto hace dudar del resto de la pantalla.

## 2026-08-20 — El chofer aprobado tiene que saber CUÁNDO empieza

El admin aprueba y programa el inicio para el próximo lunes. El chofer abría la
app y **no veía nada de eso**: su Inicio se veía normal, y la única señal que
podía obtener era intentar ponerse activo y recibir «Tu cuenta no está habilitada
para trabajar. Contacta a la oficina» — un callejón, y encima falso: no está
inhabilitado, está **temprano**, y la fecha ya existe en la base.

| Decisión | Motivo |
|---|---|
| `GET /me/account` devuelve **`tariffStartsAt`** | El dato ya vivía en `driver_subscriptions.current_period_start`; solo faltaba dárselo al canal de la app |
| El **409** de `/me/availability` dice la fecha | Un mensaje que manda a llamar a la oficina para algo que el sistema ya sabe es una llamada de teléfono desperdiciada |
| Aviso en el **Inicio**, con día de la semana y cuenta atrás | Es donde aterriza; el inicio siempre cae en lunes y así es como el chofer lo recuerda («el lunes 24 de agosto · faltan 4 días») |
| El mensaje distingue penalizado / en pausa / programado | Los tres compartían la misma frase genérica, y cada uno se corrige de forma distinta |

## 2026-08-20 — Cierre de sesión y siguiente bloque

La sesión del 19/20 de agosto queda documentada en
**`edv-route-mobile/docs/HANDOFF-2026-08-20.md`** (cubre los tres proyectos): smoke E2E del rechazo
con semanas adelantadas cerrado en verde, cinco bugs reales de producción corregidos, el cambio de
flujo del vehículo completo en cuatro fases y verificado contra producción, y los ajustes de UX del
panel y la app.

**El siguiente bloque es el sistema de notificaciones**, con el alcance y el orden ya decididos
(§6 del handoff): tablas + buzón de salida → endpoints y bandeja → campana en el header → Firebase
al final. La razón de ese orden es que todo funciona sin push, y Firebase es la única parte que
depende de terceros.

**El hilo que une la sesión**: cada arreglo de estos dos días hizo que la app diga la verdad *cuando
el chofer la abre* — el pago rechazado que no se veía, el inicio programado que nadie le decía, el
afiliado con deuda que no podía pagar. Lo que falta es que se entere *cuando ocurre*, y eso es
exactamente lo que resuelve el bloque de notificaciones.

## 2026-08-20 — Sistema de avisos, Fase 1: tablas y buzón de salida

Primer bloque construido del sistema de notificaciones (alcance y orden en el §6 del
`HANDOFF-2026-08-20.md`). Migración `1752450000000_notifications-outbox`.

| Decisión | Motivo |
|---|---|
| **Una sola tabla** `notifications` para la bandeja **y** el buzón de salida | Es el mismo hecho. Dos tablas solo se pueden contradecir, y no hay ningún dato que una tenga y la otra no |
| El aviso se escribe **dentro de la transacción del hecho** (`writeNotification` recibe el **cliente**, no el pool) | Si el pago se revierte, el aviso se va con él. Es la única diferencia real con `writeAudit`, que escribe *después* porque una operación fallida no debe dejar bitácora |
| **Jamás** llamar al proveedor dentro de la transacción | Colgaría el tick del motor de deuda tras una llamada de red (ya pasó algo así con la multa) y un push antes del COMMIT avisa de algo que puede no ocurrir |
| Columna **`deliver_after`** en vez de un segundo scheduler | Es lo que separa el AVISO del HECHO sin perder la atomicidad: el motor marca la mora a las 00:05 y programa el mensaje para las ~7:00 am en esa misma transacción. La alternativa —un proceso que relea los hechos para avisar— rompe justo la propiedad que da valor al buzón |
| `title` y `body` **ya redactados** en la fila | Si el teléfono compone el texto, la bandeja discrepa del push y corregir una palabra exige publicar un APK |
| **Sin estado `sending`**: reclamo con `FOR UPDATE SKIP LOCKED` en una transacción por lote | Un estado `sending` deja filas encalladas para siempre la primera vez que el proceso muera a media entrega. Con locks, un caído hace ROLLBACK a `pending` y el siguiente pase las recoge: entrega **al menos una vez**, el lado correcto del error para un aviso |
| `skipped` **no es un fallo** (sin token vivo, o todos muertos) | Hay choferes que **nunca** recibirán push (Huawei sin Play Services desde 2019, permiso denegado en Android 13+). Para ellos la bandeja es el único canal, y marcar `sent` sin entrega sería mentir |
| **Dos candados** contra el push accidental: `NODE_ENV=production` en el plugin **+** `notifications_enabled` en `app_settings` | Prod y dev comparten BD. El primero es físico (un backend local sencillamente no tiene despachador, ni con la bandera encendida); el segundo es el interruptor de negocio, que se lee en cada tick como `debt_engine_enabled` |
| El interruptor vive en el **plugin**, no en la función de despacho | Así la suite prueba la entrega **sin tocar la fila global** que lee el backend desplegado. Una prueba que necesita encender el interruptor de verdad es una prueba que puede dejar mandando push reales si una aserción muere antes de restaurarlo |
| `device_tokens.token` **UNIQUE GLOBAL**, no por usuario | El token identifica un **teléfono**. Dos dueños significa que el siguiente que use el aparato recibe los montos y los motivos de rechazo del anterior. Es privacidad, no orden |
| `notification_type` como **enum de PostgreSQL** con la lista cerrada de v1 (15 casos) | Kanel lo vuelve un tipo cerrado en TypeScript y el compilador caza un aviso mal escrito. Que añadir un caso cueste una migración es el freno deseado para no derivar en campañas manuales (`push_campaigns` sigue pospuesta) |
| Enviador **de mentira** (`LogPushSender`) desde el primer día, detrás de una interfaz | Todo el sistema se prueba de punta a punta sin Firebase, igual que `StorageProvider` aísla a Supabase. En la Fase 4 solo se sustituye esa pieza |

**Fuera de esta fase, a propósito**: enganchar los ~10 puntos donde nacen los avisos (Fase 1b).
Toca servicios de dinero ya probados y no debe mezclarse con la creación de las tablas.

## 2026-08-20 — Sistema de avisos, Fase 1b: dónde nacen los avisos

Los 15 casos de v1 enganchados a los hechos que los provocan. Ningún endpoint nuevo todavía
(eso es la Fase 2): esto solo llena el buzón.

| Decisión | Motivo |
|---|---|
| **Un catálogo de mensajes** (`notification-messages.ts`): los servicios dicen QUÉ pasó, el catálogo cómo se lee | Sin la separación, el mismo hecho se redacta de tres formas en tres módulos y nadie puede revisar de un vistazo el tono que recibe el afiliado. El `MessageInput` es una unión discriminada: no se puede añadir un caso sin su redacción |
| `reject` de un pago pasa a ser **transaccional** solo para llevar su aviso | Es EL aviso que justifica todo el sistema. Sin él, el afiliado volvía a la pantalla de pago como si no hubiera enviado nada y reenviaba el mismo comprobante mientras la oficina lo daba por respondido |
| `reviewVehicle` pasa a ser **transaccional** (veredicto + poner en uso + aviso) | Decirle «tu vehículo fue aprobado y ya puedes trabajar con él» y luego fallar al ponerlo en uso lo deja mirando un mensaje sobre el que no puede actuar |
| `payment_received` **solo** cuando el pago lo reporta él desde la app | Si lo registra el panel, tiene al empleado delante: el acuse es la persona. Y el aviso de aprobación llega igual |
| El **recordatorio se programa al emitir el cobro** (`deliver_after` = domingo 4pm) y **se borra al aprobar el pago** | Programarlo en el mismo paso evita un segundo trabajo que rederive quién debe qué. Borrarlo es lo que impide recordarle que pague lo que acaba de pagar — y ese ruido es exactamente lo que hace que la gente silencie los avisos, incluidos los que importan |
| Un recordatorio **ya enviado no se borra** | Sería reescribirle el historial de la bandeja |
| Mora y penalización se entregan a las **7:00 am** del huso de negocio, no a las 00:05 | Una mala noticia a las doce y cinco de la noche despierta a alguien por algo que no puede resolver hasta que abra la oficina |
| Los avisos de estado salen de `moved` (el cambio de estado del CHOFER), no de las filas de cargo | Lo que necesita oír es qué le pasó a ÉL — está en mora, no puede trabajar, ya puede volver — no que una fila cambió de estado |
| El motor devuelve también el **estado anterior** (`old_status` desde el snapshot pre-UPDATE) | «Cuenta reactivada» solo es cierto viniendo de `penalized`. Un moroso que pagó nunca estuvo fuera de la calle, y decirle que «ya puede trabajar otra vez» no tiene sentido |
| `debt_overdue` **sin importe** | El motor sabe cuántas semanas se deben, no un total. Multiplicar semanas por el precio de hoy mentiría en silencio el día que cambie la versión de la tarifa |
| La multa del aviso de penalización es **opcional** | Se puede cruzar el tope con una multa anterior sin pagar, y no se multa dos veces; pero igual hay que decirle que no puede trabajar |
| En el **motor** el aviso se escribe tras cada paso, sobre el pool (no dentro de la transacción) | El tick es una secuencia de sentencias independientes ya confirmadas, igual que su bitácora. Envolver el motor entero en una transacción para ganar atomicidad de un mensaje mantendría bloqueadas filas de dinero durante todo el pase |
| `startTariff` avisa **después** de `enrollment.approve`, releyendo la fecha | Pasarle un cliente a `approve` para cargar un mensaje amplía el radio de impacto sobre código de dinero a cambio de poco: nada de esto es reversible de una forma que deje el aviso huérfano, y el afiliado ya ve la fecha en su Inicio al abrir la app |
| `application_rejected` **sin motivo** | Rechazar una solicitud hoy no pide ninguno (el panel no manda el campo), e inventarlo sería poner palabras en boca del admin |

**Pendiente que esto deja abierto (Fase 2)**: la bandeja debe listar solo los avisos cuyo
`deliver_after` ya pasó — un recordatorio programado para el domingo no es algo que haya ocurrido.

## 2026-08-20 — Sistema de avisos, Fases 2 y 3: bandeja y campana

Endpoints del canal de la app, la pantalla de avisos y la campana en el header. Con esto el
sistema **funciona entero sin push**: solo falta Firebase (Fase 4), que es puro transporte.

| Decisión | Motivo |
|---|---|
| La bandeja lista **solo** los avisos con `deliver_after` ya pasado | No es un detalle de entrega colándose en la lectura: es lo que la bandeja SIGNIFICA. Un recordatorio programado para el domingo no ha ocurrido, y mostrarlo hoy le enseña un aviso sobre una semana que no ha empezado, fechado como si sí |
| Paginación por **keyset** (`before=<id>`), no OFFSET | Llegan avisos mientras hace scroll; el OFFSET le movería la ventana debajo, repitiendo o saltándose filas. Además evita un `count(*)` sobre una tabla que solo crece: se pide una fila de más y eso responde «¿hay más?» |
| Marcar leído es **idempotente** y **no mueve** `read_at` la segunda vez | Abrir dos veces el mismo aviso no puede ser un error que la app tenga que manejar. Y cuándo lo leyó es un hecho, no la última vez que lo abrió |
| El filtro por usuario va **dentro del WHERE**, no comprobado después | Un id ajeno simplemente no coincide: responde 204 igual y no revela si el aviso existe |
| `read-all` solo marca lo que **podía ver** | No se puede dar por leído algo que aún no se le ha mostrado |
| El contador viaja **dentro de `/me/account`** | La app ya pide esa llamada en cada pantalla. Un dato de segunda llamada que falla sin señal deja la campana mintiendo mientras el resto de la pantalla está fresco — fue exactamente el bug del «vehículo en uso» |
| **El shell es el dueño del contador** y también del estado de cuenta | Las dos pestañas pintan un header desde ahí; dos cargas independientes mostraban dos campanas distintas. De paso el Inicio dejó de pedir su propio `GET /me/account` (eran dos al arrancar) |
| La pantalla **devuelve el contador al cerrarse** (`pop`) | Refrescar la cuenta al volver sería una segunda ida al servidor por un número que la pantalla que acaba de cerrar ya conocía |
| Abrir un aviso lo marca leído; **primero local, luego el servidor** | Leer no es algo que el chofer deba HACER: un botón «marcar como leído» es un toque extra para contarle a la app lo que acaba de ver. Y hacerle esperar el viaje de red para ver que deja de estar en negrita es la app dudando de lo que él acaba de hacer |
| La campana en el **header**, no en la isla flotante | La isla navega entre lugares donde uno *está*; los avisos se consultan y se cierran. Además la isla gasta uno de los ~3 cupos que hacen falta para Viajes. Ventaja concreta: en el header el **dorado está libre** (en la isla ya significa «pestaña activa»), así que el indicador se lee sin ambigüedad |
| El tile «Notificaciones — próximamente» del Inicio se **borra** | Anunciar como futuro algo que el chofer ya ve dos centímetros más arriba es peor que no tener el tile |
| La app **nunca compone texto**: pinta `title`/`body` tal como llegan | Si el teléfono redacta, la bandeja y el push empiezan a decir cosas distintas y corregir una palabra exige publicar un APK. Del `type` solo se deriva el **icono y su color** |

## 2026-08-20 — Sistema de avisos, Fase 4: Firebase (push real)

Última pieza. Proyecto `edv-route`, paquete `com.edvroute.edv_route_mobile`.

| Decisión | Motivo |
|---|---|
| **Sin SDK**: FCM HTTP v1 llamado a mano (`node:crypto` firma el JWT, `fetch` lo envía) | `firebase-admin` arrastra un árbol de dependencias enorme para hacer dos cosas que necesitamos: firmar un JWT y mandar JSON. El intercambio OAuth son 40 líneas documentadas |
| Las credenciales son **opcionales** en el arranque, como las de Storage | Sin las tres variables el despachador conserva el enviador de mentira y la API sirve todo lo demás igual. El push **jamás** puede ser lo que impida arrancar |
| **Mensajes de notificación**, no de datos | Los pinta el sistema: sobreviven a los gestores de batería de Xiaomi/Oppo/Vivo y llegan con la app cerrada. Un mensaje de datos aterriza en un manejador que esos lanzadores se niegan a despertar |
| El **canal `edv_avisos` declarado en el manifiesto**, no solo en Dart | Android 8+ se niega a mostrar una notificación sin canal. Si solo se creara desde Dart, un push que llega con la app **cerrada** (donde no ha corrido ni una línea de Dart) no se dibujaría |
| Una llamada HTTP **por dispositivo** | La v1 no tiene endpoint multicast (el de lotes se retiró) y un chofer tiene uno o dos teléfonos, no cientos |
| `UNREGISTERED`/`INVALID_ARGUMENT`/`NOT_FOUND` → **revocar la fila**; lo demás → reintentar | Un token muerto que nadie borra llena la tabla de direcciones donde no contesta nadie, y cada envío las paga |
| Un **401** tira el token de acceso cacheado | Si el token murió antes de tiempo, el siguiente pase acuña uno nuevo en vez de fallar tres veces y abandonar el aviso |
| La clave privada viaja en **una sola línea** con `\n` literales | Un `.env` es de líneas y el editor de Railway también: la misma forma tiene que funcionar en los dos sitios |
| **Upsert sobre el token**, no sobre (usuario, token) | El token identifica un TELÉFONO: FCM entrega el mismo en ese aparato, así que la fila se reapunta al nuevo dueño en vez de dejar dos. Es privacidad, no orden |
| Al cerrar sesión se revoca en el servidor **y** se borra el token local | Dos puertas: la primera impide que se le siga enviando; la segunda hace que el siguiente chofer reciba un token **nuevo** en vez de heredar este |
| El registro se dispara en `DriverRootScreen`, no en el shell | Un `applicant` nunca llega al shell — y es justo quien espera el veredicto de su solicitud. Ese es el único punto por el que pasa toda sesión autenticada |
| Todo fallo del push es **silencioso** para el chofer | Un teléfono sin Play Services o con el permiso negado tiene que seguir usando la app igual: la bandeja es su canal y no depende de ningún proveedor |

## 2026-08-21 — Adelantar pagos desde la app

Un afiliado con deuda **cero** no tenía forma de pagar nada desde la app: la pantalla decía que
estaba al día y ahí terminaba (lo encontró Luis probando el APK 10).

| Decisión | Motivo |
|---|---|
| El canal de la app acepta ahora `advance` (antes solo `debt` y `enroll`) | La lógica ya existía y estaba probada — `prepareAdvanceContext` valida aprobado, tarifa vigente y sin cambio programado. Era abrir la puerta, no escribir el motor |
| `change_plan` **sigue siendo solo-admin** | Elegir otra tarifa es una decisión comercial, no un pago |
| El adelanto **ABSORBE** las semanas que el motor ya emitió (), en vez de crear otras nuevas encima | Encadenaba N semanas tras la última PAGADA, así que una semana ya emitida y sin pagar —el caso clásico: el motor factura el viernes para el lunes siguiente— recibía un **segundo cargo**, y el primero pasaba a mora días después: deuda fantasma a quien acababa de pagar un mes. Ahora la paga como su primera semana, que es lo que «adelantar dos semanas» significa para el chofer. Mismo importe, sin duplicado |
| Rechazar el adelanto fue el **primer intento y era un candado sin salida** | Esa semana **no es deuda todavía** (su período no ha empezado, decisión del 2026-08-19), así que nada dejaba pagarla y nada dejaba adelantar. Un candado sin salida es un bug — la misma lección del vehículo rechazado |
| **SIN tope de semanas** (revertido el mismo día) | Puse un límite de 12 semanas y **contradecía una decisión ya tomada**: adelantar es libre, no hay tope de producto. Queda solo el respaldo técnico de 520 contra un dedazo (99999 semanas), que ya existía |
| En la app es un **enlace discreto**, no un botón, y **solo aparece sin deuda** (decisión de Luis) | El que debe ve un botón sólido «Pagar»; el que está al día, una línea callada. El peso visual dice la urgencia y nadie confunde una cosa con la otra — sin leer una palabra |
| Las semanas se eligen en una hoja **antes** de la pantalla de pago, y ahí ya no se pueden cambiar | «Adelantar» no significa nada hasta saber cuánto. Y volver a ofrecer el selector dejaría cambiar lo ya decidido contra un total que se le acaba de cotizar |
| La hoja destaca **hasta cuándo queda cubierto**, no el monto | Es lo que al chofer le importa de adelantar; el total es el medio, no el fin |
| El modal de captura de pago es **el mismo**, sin tocar | Un segundo formulario de pago sería una tercera copia de la misma revisión (ya pasó con las solicitudes) |

## 2026-08-21 — Estados que se contradecían en pantalla

Tres fallos que Luis vio en el perfil del panel: «En mora» con **0 semanas de deuda**, «Tarifa
Semanal **Vencida**» con cobertura pagada hasta el 24, y el aviso del cobro sin decir la consecuencia.

| Decisión | Motivo |
|---|---|
| Aprobar un pago **deriva el estado del chofer en la misma transacción** (`deriveDriverState`) | El motor era el único que lo hacía, una vez por minuto. Durante ese minuto el panel mostraba «En mora · Debe 0 semana(s) de tarifa»: una etiqueta discutiendo con el número que tenía al lado. El motor sigue siendo la autoridad de las transiciones por **tiempo**; esto cierra la de **evento**, con la misma regla para que no puedan discrepar |
| La regla vive en `billing-sql.ts`, no copiada en el repositorio de pagos | Es la misma pregunta que responde el motor. Una segunda copia deriva el día que se toque una de las dos — exactamente lo que ya justificaba ese archivo |
| El scheduler de tarifas **rescata** suscripciones `expired` con cobertura pagada viva (antes solo avanzaba las `active`) | Con el motor de deuda encendido la cobertura vive en `subscription_payments`, no en `current_period_end`. Una tarifa semanal expirada **antes** de encender el motor se quedaba expirada **para siempre**: el paso que avanza el período solo miraba `active` y el que expira solo expira. El chofer pagaba, el motor le facturaba bien, y su tarjeta decía «Vencida» mientras tenía otra semana cubierta |
| El aviso `charge_issued` ahora nombra la **factura** y el **día en que entra en mora** | «Se emitió tu semana» le dejaba a él deducir la consecuencia. Ahora dice las tres cosas de golpe: que la factura existe, cuánto es y hasta cuándo tiene |

## 2026-08-21 — Segunda tanda de la app: el pago y los avisos, probados en el teléfono

Todo esto salió de Luis usando el APK contra producción, no de buscar fallos.

| Decisión | Motivo |
|---|---|
| Un afiliado **ya operando** nunca queda retenido en la pantalla de alta (regla nueva y **primera** de `altaScreenState`) | Reportó un pago y la app lo mandó a una pantalla de espera cuyo único botón era «Cerrar sesión»: **encerrado fuera de su cuenta** hasta que un admin lo revisara. `tariffStarted` es la señal sólida — el admin solo puede establecer el inicio con el alta saldada |
| La pantalla de pago se abre **apilada** desde el perfil (`isEntrance: false`) | Reportar un pago es algo que hace DENTRO de la app, no una puerta que se cierra tras él. Título «Reportar pago», sin logout, y al enviar «Volver a la app» |
| **Dos preguntas, dos funciones**: `altaScreenState` (¿dónde pertenece este chofer?) y `reportPaymentState` (¿qué hay que pagar?) | Responder ambas con una sola regla es lo que convirtió un pago en una puerta cerrada. Es la misma trampa que atrapó a los `pending` el 19/08, una puerta más adentro |
| Los métodos de pago pasan de lista completa a **selector** | Cinco tarjetas empujaban el formulario fuera de pantalla en una hoja que ya scrollea. Es una elección única de una lista cerrada: `PickerField`, el mismo del banco emisor |
| El envío ocurre **DENTRO del modal**, con su loading, y solo cierra cuando el servidor responde | Se cerraba al pulsar y enviaba después: durante el viaje de red no había nada en pantalla. Si falla se queda **abierto con todo lo escrito** — cerrarlo obligaba a rellenar el formulario entero para reintentar |
| El perfil se refresca **antes** de que el modal cierre | Lo que aparece detrás ya es el estado nuevo, nunca la tarjeta vieja por un parpadeo |
| Con la app abierta, el aviso es una **tarjeta de marca que baja desde arriba**, no un `SnackBar` | Losa gris en el borde de abajo: parecía un mensaje de depuración. Android no dibuja nada mientras la app está en primer plano, así que **eso ES la notificación** para el chofer y tiene que parecerlo |
| Tocar un push **abre la bandeja** (`onMessageOpenedApp` + `getInitialMessage`) | Antes solo levantaba la app y había que buscar la campana. Con la app CERRADA el toque llega antes de que exista el shell, así que queda en bandera y el shell la recoge al montarse |
| Tocar un aviso en la bandeja lo **abre como un mensaje** (`notification_detail_sheet`) | Solo lo marcaba leído: la lista era un muro de texto sobre el que no se podía actuar. El cuerpo entero sin recortes, el momento completo, y el **motivo del rechazo en bloque propio** — iba diluido en el párrafo y es lo único que le dice qué corregir |
| El veredicto del pago se dice **una vez, en el panel, donde se pulsó** | El perfil llevaba un banner «Pago rechazado» permanente repitiendo dos líneas que el admin ya sabía. Un veredicto es un momento, no un estado del perfil; el rastro sigue en Historial de pagos |
| El aviso del panel dice **que el afiliado ya fue notificado** | Información que el admin no tenía: hasta ayer rechazar era a ciegas |

### Deuda conocida que este día dejó al descubierto

⚠️ **La suite de pruebas le factura de verdad a choferes reales.** `debt-engine.test.ts`
fuerza `billing_day_of_week`/`billing_hour` para que el motor emita en el acto, y el tick emite
**para todos los afiliados elegibles**, no solo los de prueba. El martes 18/08 a las 10:24 eso
emitió a Luis y a Darwing la semana del 24/08, **tres días antes de tiempo** — y por eso el
viernes a las 18:00 no se generó nada (ya existía) y no hubo aviso que mandar.

Los valores se restauran al terminar, así que el calendario sigue siendo viernes 18:00; pero si
la suite muere a media corrida quedarían forzados. **Propuesta pendiente de aprobación**: que
`runDebtEngineTick` acepte limitarse a un chofer y que las pruebas pasen el suyo.

## 2026-08-24 — 📧 El correo pasa a ser obligatorio en los dos canales

> Salió al preparar la recuperación de clave ("olvidé mi contraseña"): si el correo es el canal
> por el que se recupera una cuenta, un afiliado sin correo no tiene forma de volver a entrar.
> **Sin migración** (la columna sigue nullable por los registros previos). Verificado: backend
> `typecheck` · panel `build` · app `analyze` + 65/65 tests.

**El hallazgo.** El panel **ya lo exigía** desde siempre (`required` en el wizard). El agujero
estaba en el canal de la app, cuyo campo decía literalmente **«Correo (opcional)»** y aceptaba
vacío — y en el backend, que solo exigía nombre y apellido en ambos canales. De los 10 afiliados
en producción, el único sin correo (**Yornel Marval**, V-20356841, aprobado) se auto-registró
desde la app. Ninguno de los otros nueve tiene un correo basura.

| Decisión | Motivo |
|---|---|
| El correo es **obligatorio al registrarse en los dos canales**, exigido en el **backend** (`createBody` y `registerBody` lo llevan en `required`) y no solo en cada cliente | Es una regla del **dato**, no del canal: la recuperación de clave no puede depender de por qué puerta entró el afiliado. Se aparta a propósito del precedente de 2026-07-16 (`password`/`nationalId` opcionales en la API, obligatorios en el panel), porque aquel dejaba justo el hueco que produjo este caso |
| El correo **ya no se puede vaciar** en ninguna edición: `personProperties.email` deja de admitir `null`, y `PATCH /driver-auth/me` rechaza un valor en blanco en vez de convertirlo en `NULL` | Un correo que se puede borrar no es un canal de recuperación fiable. El `\|\| null` del auto-servicio era una puerta silenciosa: el chofer podía quedarse sin salida sin enterarse |
| El **PATCH sigue siendo parcial** (no lleva `required`): solo se prohíbe **vaciarlo**, no se obliga a mandarlo en cada edición | Nadie debe reescribir el correo del chofer para corregirle el teléfono — mismo criterio que la contraseña desde 2026-07-16 |
| El panel exige el correo también **al editar** el perfil (antes solo al crear) | La validación decía "editar lo deja opcional para que los registros viejos se puedan guardar", y ese permiso convertía cualquier edición en una forma de dejar a alguien sin correo |
| ⚠️ **Yornel Marval sigue sin correo** y no se le inventa uno | Es un dato real que solo él o la oficina pueden aportar. En cuanto un admin guarde su perfil el panel se lo exigirá; mientras tanto no podría recuperar su clave |

## 2026-08-24 — 🔑 «Olvidé mi clave»: recuperación por correo desde la app

> Hasta hoy la clave la ponía un admin y no había forma de recuperarla: el enlace del login
> mostraba «próximamente». Migración `1752460000000_password-reset-codes` (aditiva) + módulo de
> correo + 4 pantallas en la app. Verificado: backend `typecheck` y **smoke E2E contra la base
> real** (los 8 pasos, incluida la clave restaurada intacta) · app `analyze` limpio y **75/75
> tests**. Pantallas aprobadas por Luis antes de escribir el código.

**El flujo**: cédula + correo → código de 6 dígitos al correo → clave nueva. Tres pasos, tres
endpoints públicos (los únicos del canal del chofer, porque quien olvidó su clave no puede
autenticarse).

| Decisión | Motivo |
|---|---|
| **Dos datos, no uno**: cédula y correo tienen que apuntar al mismo afiliado, comprobados en un **solo `WHERE`** | La cédula sola es semipública (está en cada documento que entrega) y un correo solo no dice de quién es. Resolver por cédula y comparar el correo después haría el desajuste observable **por tiempo**, y tienta a una comparación «suficientemente parecida» más adelante |
| El código se guarda **hasheado (argon2id)**, nunca en claro | Un código de recuperación **es una clave temporal**. Un respaldo filtrado o una línea de log descuidada no puede regalar una cuenta. Son cortos y de bajo volumen: el coste del hash es irrelevante aquí |
| **La fila es toda la máquina de estados**: no hay columna `status` | Cada pregunta ya tiene respuesta autoritativa: vencido = `expires_at`, gastado = `used_at`, verificado = `verified_at`, sin intentos = `attempts`. Una columna de estado sería una segunda opinión capaz de contradecir a las cuatro |
| **Un solo intento vivo por chofer**, garantizado por índice único parcial | Pedir otro código invalida el anterior. Dos códigos vivos duplican la superficie de adivinanza, y la garantía no puede depender de que todos los llamadores futuros se acuerden |
| Verificar el código entrega un **token de un solo propósito** (`type: 'pwd_reset'` + id del intento), no una sesión | Los guards de sesión lo rechazan por su `type`, así que acertar 6 dígitos **no** abre la app ni el dinero del chofer. Lleva el id de la fila porque un JWT no se puede revocar y la fila sí: un replay se topa con `used_at` aunque la firma siga viva |
| `confirm` **rechaza explícitamente un token de sesión** de chofer | Sin esa comprobación, una sesión robada bastaba para cambiar la clave sin conocer la actual — exactamente lo que `PATCH /me` evita exigiendo `currentPassword`. Verificado en el smoke: responde 401 |
| La clave nueva y el gasto del intento van en **una transacción** | Partido en dos, una caída entre medias deja un código verificado todavía usable contra una cuenta cuya clave ya cambió |
| **3 intentos, 10 minutos, 5 códigos por hora, 60 s entre envíos** | Un código de 6 dígitos con intentos ilimitados es un código que cualquiera adivina; sin tope por hora, el sistema se convierte en una forma de bombardear el correo de otro. El límite se cuenta **sobre las propias filas**, no en memoria: sobrevive a un reinicio y no hay contador que mantener sincronizado |
| Si el envío del correo falla, el código se **gasta** | Dejarlo vivo lo deja mirando seis casillas esperando un correo que no va a llegar, y le quema una petición de su cupo por nada |
| El correo de «tu clave fue cambiada» se manda **después**, best-effort | La clave YA cambió: fallar la petición ahí le diría que no. Es el único modo en que el dueño real se entera de que otro completó la recuperación, cuando hacer algo todavía es barato |
| **Proveedor de correo detrás de una interfaz** (`EmailSender` + `ResendEmailSender` + `LogEmailSender`), opcional al arrancar | Mismo patrón que `StorageProvider` y `PushSender`: sin credenciales la API arranca igual y el código queda en el log (así se probó el flujo entero antes de contratar nada). En **producción** sin proveedor el endpoint responde 503 en vez de prometer un correo que solo llegó a un archivo de log |
| **Sin SDK**: Resend por REST con `fetch` nativo | El paquete `resend` envuelve un POST con un bearer. Mismo criterio que ya se aplicó a Supabase Storage y a FCM |
| El **correo no lleva imágenes**, ni el logo | Los clientes bloquean imágenes remotas por defecto y las incrustadas del todo: el logo se vería como un recuadro roto en la primera apertura, que es peor que no ponerlo. La marca va en el degradado, el dorado y la tipografía, que siempre se pintan |
| ⚠️ **NO se cierran las sesiones de otros teléfonos** | La pantalla lo prometía en el diseño y se **quitó** en vez de dejarla mintiendo. Los tokens del chofer se validan solo por firma y viven 8 h; cerrarlos exige consultar la BD **en cada petición**, justo lo que no conviene con el techo de 15 conexiones. Va junto con el pendiente de validar el `status` en `authenticateDriver`, que necesita esa misma consulta |
| El código de 6 casillas **pega el código completo** | Hallado por su propia prueba: `maxLength: 1` instala un formateador que **truncaba el pegado al primer carácter antes** de que corriera el reparto. La gente copia el código del correo, no lo memoriza |

## 2026-08-24 — 📧 Los correos salen por Gmail mientras no haya dominio propio

> EDV Route todavía no tiene dominio, y **ningún proveedor de correo envía a destinatarios
> arbitrarios desde un dominio sin verificar** — Resend incluido: sin dominio solo deja escribirte
> a ti mismo. Decisión de Luis tras ver las opciones. Aditivo: `SmtpEmailSender` junto al de
> Resend, ambos detrás de `EmailSender`. Verificado: `typecheck` limpio y los tres casos de
> selección de proveedor comprobados arrancando la app.

| Decisión | Motivo |
|---|---|
| **Gmail por SMTP**, no un proveedor que acepte remitentes sin dominio (Brevo lo permite) | Enviando por el SMTP de Gmail el correo **sale de verdad de los servidores de Google, firmado por Google**, así que autentica bien y llega a bandeja. Un proveedor que reenvía «en nombre de» una dirección `@gmail.com` **no alinea la firma DKIM** y Gmail lo archiva como spam — y un código de recuperación en spam es un código que no se envió |
| El límite de 500 correos/día **no aprieta** | Diez afiliados; aunque cada uno pidiera recuperar su clave dos veces al mes son ~20 correos. La advertencia habitual de «no uses Gmail para transaccional» va por volumen y por reputación compartida, y a esta escala no aplica |
| Se añade **`nodemailer`**, apartándose del «sin SDK» del proyecto | Resend, FCM y Supabase Storage son **un POST autenticado** cada uno: ahí el SDK no compraba nada. SMTP es un handshake TLS, un intercambio de autenticación y un diálogo de comandos. Escribir eso a mano sería el error, no la disciplina |
| **Resend gana si están las dos configuraciones** | Migrar el día que exista el dominio es **añadir dos variables**, no acordarse de quitar otras dos. El código no se toca: los dos enviadores viven detrás de la misma interfaz, que es exactamente para lo que se creó |
| Con SMTP, `EMAIL_FROM` vacío cae en `SMTP_USER` | Gmail reescribe el remitente a la cuenta autenticada, así que un `EMAIL_FROM` distinto se enviaría en silencio bajo otra dirección. Igualarlos evita esa sorpresa |
| La contraseña es una **contraseña de aplicación** de Google, nunca la real | Exige verificación en 2 pasos, se revoca sola sin cambiar la clave de la cuenta, y no da acceso al buzón |
| Tiempos de espera cortos (10 s conexión, 20 s socket) | La pantalla del chofer está esperando esta llamada: mejor un fallo claro que pueda reintentar que una petición colgada hasta que el cliente se rinda |

## 2026-08-24 — ⚠️ Railway no deja salir SMTP: el correo queda a la espera de un dominio

> Cierre del bloque de recuperación de clave. Verificado en vivo, no leído en un foro: las
> **mismas** credenciales de Gmail autentican desde una máquina local y agotan el tiempo de espera
> desde Railway.

**El hallazgo.** Railway **bloquea los puertos 25, 465 y 587** en los planes Hobby y de prueba;
SMTP solo existe a partir de Pro (20 USD/mes). Recomendar Gmail sin comprobar antes la red de
salida del hosting fue un error de análisis: la pregunta correcta no era «¿puede este proveedor
mandar correo?» sino «¿deja este hosting salir por ese puerto?».

| Decisión | Motivo |
|---|---|
| **El correo de producción tiene que ir por una API HTTPS**, no por SMTP | El puerto 443 no lo bloquea nadie. Resend, Brevo, Mailgun y Postmark funcionan así; Gmail no. Es una restricción del **hosting**, no del proveedor de correo |
| **Se deja parado hasta tener dominio propio** (decisión de Luis) | Las alternativas eran Brevo con remitente `@gmail.com` —que Gmail archiva como spam, y los diez afiliados son de Gmail, o sea el peor caso— o Railway Pro a 240 USD/año para ahorrarse los ~12 de un dominio. Ninguna compra nada frente a esperar |
| ⚠️ **Las variables `SMTP_*` se quitan de producción**, no se dejan «por si acaso» | Con ellas el backend se cree configurado y responde *«no pudimos enviar, inténtalo de nuevo en unos minutos»*: invita a reintentar algo que **nunca** va a funcionar. Sin ellas dice *«comunícate con la oficina»*, que es la verdad y es accionable. Un mensaje de error que miente es peor que la funcionalidad ausente |
| **`SmtpEmailSender` se conserva** aunque no sirva en producción | No es código muerto: es lo único que permite probar el flujo de correo **en local**, donde SMTP sí sale — así se verificó de punta a punta (correo real recibido, con su plantilla). Y sirve tal cual el día que se cambie de hosting o se suba a Pro |
| El día del dominio: **dos variables** y listo | `RESEND_API_KEY` + `EMAIL_FROM`. Resend gana sobre SMTP en el plugin, ya está implementado y probado. No se toca una línea de código, ni del backend ni de la app |

## 2026-08-24 — 📮 Gmail por su API HTTP: el correo sale sin dominio y sin SMTP

> Salida al bloqueo de SMTP de Railway, sin renunciar a que el remitente sea la cuenta de EDV
> Route. Decisión de Luis: se hace Gmail y **lo ya construido queda como plan B** (Resend para el
> día del dominio, SMTP para local). Verificado: `typecheck` limpio, el MIME generado revisado a
> mano y la prioridad de proveedores comprobada arrancando la app en los cuatro casos.

**La distinción que lo resuelve**: que el destinatario *vea* un remitente es trivial —cualquier
proveedor deja poner el `From`—, pero que el correo *llegue* exige que quien firma el mensaje sea
quien dice ser. Por eso un proveedor externo reenviando «en nombre de» un `@gmail.com` acaba en
spam, y por eso Gmail hablando por su propia API no.

| Decisión | Motivo |
|---|---|
| **Gmail por HTTPS** (`gmail.googleapis.com`) en vez de SMTP | Es la **misma** cuenta y el mismo Gmail: el correo sale de los servidores de Google firmado por Google. Lo único que cambia es el transporte — puerto 443 en vez de 465, y el 443 no lo bloquea nadie. Resuelve el bloqueo de Railway sin bajar la calidad de entrega ni pagar un dominio |
| **Sin SDK**, igual que FCM | `googleapis` arrastra un cliente para cada producto de Google para hacer un POST. El intercambio de token es el mismo baile que ya hace `fcm-push-sender.ts`: `fetch` al endpoint de OAuth y el access token cacheado hasta poco antes de caducar |
| Permiso **`gmail.send` y nada más** | Puede enviar como la cuenta y **no puede leer un solo mensaje**. Es el mínimo con el que esto funciona, y limita el daño si el refresh token se filtra |
| ⚠️ **La app OAuth tiene que quedar PUBLICADA** («En producción») | En modo «Prueba» Google **caduca el refresh token a los 7 días** y el correo se muere cada semana sin causa aparente. Es la trampa central de este montaje, así que está escrita en el runbook, en `.env.example`, en el script de autorización y en el mensaje de error del propio enviador |
| Se publica **sin completar la verificación** de Google | La verificación de permisos sensibles existe para apps que autorizan a terceros. Aquí el dueño de la app y el único usuario son la misma cuenta: publicar sin verificar deja un aviso de «app no verificada» que se ve **una vez**, al autorizar. Verificarla costaría días de formularios para no cambiar nada |
| El `From` se **omite** si no hay `EMAIL_FROM` | Gmail reescribe el remitente a la cuenta autorizada. Poner un nombre suelto sin dirección daría una cabecera malformada; omitirla deja que Gmail la rellene bien |
| **Orden de preferencia**: Resend → Gmail API → SMTP → log | Resend sigue ganando en cuanto exista el dominio, así que migrar es **añadir** dos variables, no acordarse de quitar tres. SMTP se queda para local, que es donde sí sale |
| El MIME se arma a mano (`multipart/alternative`, base64 en líneas de 76, asunto en RFC 2047) | Es lo que pide el estándar y lo que Gmail espera en `raw`. Los asuntos llevan acentos: sin codificar la cabecera llegan como galimatías. Revisado generando el mensaje real antes de confiarlo |

## 2026-08-24 — 🎨 El avatar del remitente: foto de perfil sí, BIMI no

> Pregunta de Luis al ver que Farmatodo muestra su logo en Gmail. Evaluado, **no implementado**.

Son **dos caminos distintos** que se confunden con facilidad:

| Camino | Qué hace falta | Veredicto |
|---|---|---|
| **Foto de perfil de la cuenta de Google** | Subir una imagen en la cuenta. Gratis | ✅ **Recomendado.** Pendiente de hacer |
| **BIMI** (el logo *verificado*) | Dominio propio + DMARC en `quarantine`/`reject` + **certificado de marca de 650–1.750 USD/año** | ❌ Fuera de alcance |

**Fuera de alcance por precio, no por dificultad**: ningún emisor entrega un VMC o CMC gratis, y el
VMC además exige marca registrada. Con diez afiliados no compensa. Tendría sentido el día que EDV
Route mande miles de correos y la suplantación sea un riesgo real.

La foto de perfil consigue casi lo mismo a la vista del destinatario por cero euros — con el matiz
honesto de que Google decide cuándo mostrarla según el historial entre cuentas y su propia caché,
así que no es una garantía absoluta. La imagen buena ya existe:
`edv-route-mobile/assets/images/edv_icon.png` (cuadrada, 1024×1024, fondo de marca).

## 2026-08-24 — 📍 Ubicación de los afiliados, Fase 1: la tubería del backend

> Primera fase de [proposals/ubicacion-afiliados](../proposals/ubicacion-afiliados/README.md).
> Migración `1752470000000` + módulo `locations` + job de retención. **La app todavía no manda
> nada**: esto se probó con peticiones directas. Verificado: `typecheck` limpio y **8/8** en
> `tests/locations.test.ts`, cada prueba con su propio chofer creado y borrado.

| Decisión | Motivo |
|---|---|
| **Un lote de puntos por petición**, nunca uno suelto | La app guarda una cola local mientras no hay señal. Vaciarla de uno en uno convierte cada reconexión en veinte viajes contra un pool que en producción tiene ocho conexiones. El lote entra en **una sola sentencia** con `unnest` |
| **Dos fechas por punto**: cuándo lo tomó el teléfono y cuándo llegó | Con la cola, un punto puede llegar horas tarde. El recorrido se dibuja con la primera; la diferencia entre ambas mide cuánto estuvo sin señal, que es información operativa y no contabilidad |
| La **última posición** vive en `drivers`, aparte del historial | No es duplicar: el mapa pregunta «dónde está cada uno ahora», y responder eso desde el historial obliga a sacar la fila más nueva de cada chofer entre decenas de miles **cada vez que alguien lo abre**. Estaba en el diseño v7 y nunca se había implementado |
| La última posición **solo avanza, nunca retrocede** | Un vaciado de cola trae puntos de hace horas. Sin el guard, el chofer daría saltos hacia atrás en el mapa cada vez que recupera cobertura |
| **La precisión se guarda siempre y se filtra al leer** | Un punto con 500 m de error sirve para el historial y no para asignar una carrera. Descartarlo al escribir perdería lo primero por proteger lo segundo |
| **Los puntos malos se descartan uno a uno**, no tumban el lote | Una lectura corrupta no puede llevarse por delante las diecinueve buenas que venían detrás. Se descarta lo que no es una posición: fuera de rango, el `(0,0)` de un teléfono **sin fix**, y lo anterior a 24 h |
| Unos segundos **en el futuro** se aceptan; una hora, no | Los relojes de los teléfonos van desajustados. Rechazar todo lo que venga por delante tiraría en silencio cada punto de unos cuantos aparatos; el tope de 5 minutos separa el reloj torcido de la falsificación |
| Quién puede reportar reutiliza **`CAN_OPERATE_STATUSES`**, no una copia | Es la misma pregunta que gobierna el interruptor de disponibilidad. Una segunda copia deriva el día que se toque una de las dos, y entonces un chofer podría estar activo y no poder reportar, o al revés |
| Un `overdue` **sí** reporta | Debe semanas pero sigue trabajando: si desaparece del mapa, deja de recibir carreras justo cuando más necesita pagarlas |
| El rechazo va con **motivo**, y la app **apaga el servicio** | Repetir una petición cada diez minutos contra una puerta cerrada gasta batería para nada. El chofer suspendido merece que su teléfono se calle, no que insista |
| **`intervalSeconds` viaja en cada respuesta** | Es cómo un cambio de ritmo llega a todos los teléfonos sin publicar un APK. Declarado en el schema de respuesta: Fastify borra en silencio lo que no esté declarado, y ya se comió tres campos antes |
| El **job de retención se despliega con la tabla**, no después | Una tabla que solo crece, en una base de 500 MB, es una bomba con temporizador. Lee la ventana en cada pasada, así cambiarla en el panel surte efecto sin redesplegar. Y **solo corre en producción**, como el despachador de avisos: prod y dev comparten base, y un backend local no puede borrar el historial de producción |

**Gotcha nuevo**: **PostGIS vive en el esquema `extensions`** en Supabase. Una sesión normal lo lleva
en el `search_path`, pero **node-pg-migrate no**, así que una migración tiene que calificar el tipo
(`extensions.geography`). Las consultas en caliente no lo necesitan.

**Corregido de paso**: la documentación de `PATCH /driver-auth/me/availability` daba la forma de la
**respuesta** (`{ isAvailable }`) como si fuera la del **cuerpo** (`{ available }`). Se descubrió
porque una prueba escrita contra la doc no ponía al chofer inactivo, y el fallo parecía estar en el
control de acceso nuevo.

## 2026-08-24 — 🔑 Ubicación, Fase 2: la sesión del chofer no caduca, pero se puede cortar

> Segunda fase de [proposals/ubicacion-afiliados](../proposals/ubicacion-afiliados/README.md).
> Verificado: `typecheck` limpio y **7/7** en `tests/driver-session.test.ts`, más el resto de la
> suite en verde (todo salvo `debt-engine`, que se deja aparte porque factura de verdad).

**El problema**: la app ya guardaba la sesión, pero el token duraba **8 horas**. Cerrarla y volver
al día siguiente te echaba fuera — y con el rastreo encima, eso significa que **se apagaría solo
cada noche**.

| Decisión | Motivo |
|---|---|
| **`DRIVER_JWT_EXPIRES_IN` separado** (365d), el del admin intacto en 8h | Alargar la sesión del chofer no puede alargar la del admin: el panel es un navegador, a menudo en una máquina compartida. Un token de admin de un año sería mucho peor que el problema que resuelve |
| **`authenticateDriver` comprueba la cuenta en CADA petición** | Es el complemento sin el cual el token largo es imprudente. Un JWT de un año **no se revoca por caducidad**, así que esto es lo único que puede cortarle el acceso a alguien: suspenderlo desde el panel lo deja fuera —y apaga el rastreo de su teléfono— en segundos, en vez de dejar un aparato robado o prestado reportando durante meses |
| **Solo `suspended` pierde el acceso** | No se toca la decisión del 2026-08-18: un chofer con deuda —**`penalized` incluido**— entra igual, porque la app es la única pantalla donde puede ver y pagar lo que debe. El candado del trabajo sigue en cada función (`CAN_OPERATE_STATUSES`), nunca en la puerta |
| **Un `rejected` también entra** | Tiene que poder leer **por qué** lo rechazaron, y un admin puede reabrir su solicitud. Un candado sin salida es un bug que este proyecto ya ha desplegado tres veces |
| Una cuenta **borrada** responde 401, no 403 | El limpiador de solicitantes borra registros abandonados; un token que sobrevive a su cuenta no puede seguir sirviendo. Y la app distingue «vuelve a entrar» de «te suspendieron» |
| El coste: **una consulta más por petición**, sin caché | Es una búsqueda por clave primaria sobre una flota de decenas. Cachearla cambiaría la inmediatez por rendimiento que no hace falta, y la inmediatez es justo el punto |

### Deuda propia saldada: 12 pruebas que rompí esta mañana

Hacer el correo **obligatorio** al registrar rompió todas las pruebas que creaban choferes sin
correo, y no las actualicé en su momento. Salieron al verificar esta fase: `validation` (5),
`payment-submission` (2), `invoice-state` (1), `invoice-payment` (1) y `notification-events` (1).

Ninguna era un fallo del código: describían un contrato que **cambió a propósito**. Es exactamente
el patrón del 18/08 («todas describían diseños que se cambiaron a propósito y nadie volvió a
mirar»), y la lección se repite: **un cambio de contrato no está terminado hasta que la suite lo
refleja**.

## 2026-08-24 — 📍 Ubicación, Fase 3: la app reporta con la pantalla apagada

> Tercera fase de [proposals/ubicacion-afiliados](../proposals/ubicacion-afiliados/README.md).
> Verificado: `flutter analyze` limpio, **82/82** tests (7 nuevos de la cola) y **APK release
> compilado** — pero el comportamiento real (que Android no lo mate, que el permiso se conceda)
> solo se prueba en un teléfono.

| Decisión | Motivo |
|---|---|
| **`geolocator` + `flutter_foreground_task`**, no `flutter_background_geolocation` | El tercero es el que más se recomienda y **cuesta 500 USD por app** para compilar en release. Funciona sin licencia en depuración, que es justo la trampa: se descubre al generar el APK final |
| **Servicio en primer plano** con notificación permanente | Android mata el trabajo en segundo plano en minutos. Es la única forma de seguir reportando con la app cerrada — y la notificación no es un mal necesario: es la señal honesta para alguien a quien se está localizando |
| ⚠️ El rastreo corre en **otro isolate**, sin memoria compartida con la app | De ahí salen dos decisiones que si no, parecerían raras: la cola es un **archivo** (un almacén en memoria sería invisible desde allí) y el token se lee del almacén seguro **en cada pase**, en vez de pasárselo |
| La cola **borra por cantidad**, no vaciando el archivo | El rastreador puede añadir un punto mientras el envío está en vuelo; vaciar lo tiraría sin enviar |
| Al llenarse, se descartan **los más viejos** | Un punto fresco vale más que uno rancio — y los rancios son justo los que el servidor rechaza pasadas 24 h |
| Un **403 apaga el servicio**, un fallo de red no | Son cosas distintas: la red significa «reintenta en diez minutos», el 403 significa «deja de despertar el GPS». Tratarlos igual gasta batería en una petición que nunca se va a aceptar |
| El **permiso se pide al ponerse activo**, no al entrar | Pedirlo al iniciar sesión es pedirlo antes de que el chofer tenga motivo para decir que sí — y un permiso denegado no vuelve a preguntarse. Tiene **pantalla propia** porque Android 11+ no muestra un diálogo para «todo el tiempo»: manda a los ajustes del sistema, y es donde más gente se cae del flujo |
| Al **arrancar la app** se reanuda el rastreo, pero **sin pedir permisos** | Un chofer que estaba activo puede haber perdido el servicio (reinicio, gestor de batería). Reanudarlo es correcto; plantarle una pantalla de permisos nada más abrir, cuando no está decidiendo nada, es intrusivo |
| **Cerrar sesión para el servicio Y borra la cola** | Mismo criterio que revocar el token de push: el siguiente chofer en ese teléfono no puede heredar las posiciones del anterior |
| El **ritmo lo aplica el servidor** en cada respuesta | Es lo que permite subir la frecuencia el día que haya viajes sin publicar un APK |
| `autoRunOnBoot` encendido | Un chofer que reinicia el teléfono a media jornada no debería desaparecer del mapa hasta que se dé cuenta |

**Asunción declarada**: quedarse activo toda la noche es, por ahora, **responsabilidad del chofer**
— no hay apagado automático. Es lo más simple y lo que no añade comportamiento sorpresa; la capa de
apagado se monta encima sin rehacer nada. Pendiente de decisión de Luis.

## 2026-08-24 — 🛰️ Corrección: «mientras usas la app» SÍ basta para rastrear

> Salió al probar el APK 18 en el teléfono: el diálogo de Android **no ofrecía** «Permitir todo el
> tiempo», y la pantalla insistía en pedirlo. Parecía que el rastreo con la app cerrada era
> imposible. No lo es — el error estaba en la pantalla.

**El modelo real de permisos**, que es fácil de entender al revés:

| Lo que se quiere hacer | Permiso que hace falta |
|---|---|
| Rastrear con la app cerrada, habiendo **arrancado** el servicio con la app abierta | **«Mientras usas la app»** ✅ |
| **Arrancar** el servicio desde segundo plano (revivirlo tras reiniciar el teléfono) | «Todo el tiempo» |

Un servicio en primer plano de tipo `location` **iniciado con la app en primer plano cuenta como
«while-in-use»**, y sigue recibiendo posiciones después de cerrarla. Eso es justo para lo que
existen los servicios en primer plano.

| Decisión | Motivo |
|---|---|
| El arranque exige **`canTrack()`** (`always` o `whileInUse`), no `always` | La comprobación anterior bloqueaba el rastreo por un permiso que no hace falta, y encima **Android 11+ ya no lo ofrece en el diálogo**: solo se concede a mano en los ajustes del sistema, que es el paso donde más gente se cae |
| «Todo el tiempo» se ofrece **después**, como extra | Cuando esa pantalla aparece, el rastreo **ya está funcionando**. Se enmarca como una mejora («si reinicias el teléfono, se reanuda solo»), nunca como un problema. Bloquear en ese paso sería bloquear en lo que casi nadie completa, por un beneficio que casi nadie nota |
| La pantalla vuelve a mirar el permiso al **volver de los ajustes** | Android no avisa de eso: se detecta por el ciclo de vida de la app. Sin ello, quien sí lo concede se queda mirando una pantalla que no se entera |
| `autoRunOnBoot` se deja encendido | Solo surte efecto para quien concedió «todo el tiempo». Para el resto, Android rechaza el arranque y no pasa nada: la app reanuda el rastreo al abrirse |

**La lección**, y es la segunda vez esta sesión: verificar la plataforma **antes** de diseñar contra
ella. Con Railway fue el puerto de salida; aquí, qué permiso exige Android para qué. En ambos casos
la pregunta correcta no era «¿se puede hacer esto?» sino «¿bajo qué condiciones exactas?».

## 2026-08-28 — ⚠️ Arrancar el backend en local dispara los schedulers contra PRODUCCIÓN

> Salió construyendo la app en local para listar las rutas registradas: al hacer `buildApp()` se
> registran los **siete** schedulers y todos empiezan a hacer ticks contra la base — que es la misma
> de producción. Era **viernes**, el día en que el motor de deuda emite.

**Comprobado inmediatamente**: cero facturas creadas en la última hora y cero en todo el día. No
hubo daño. Pero el daño no ocurrió por diseño, sino por suerte.

| Scheduler | ¿Se protege de correr fuera de producción? |
|---|---|
| `location-retention` | ✅ **Sí**: comprueba `NODE_ENV !== 'production'` y ni siquiera programa el timer |
| `debt-scheduler` | ❌ **No**. Solo mira `debt_engine_enabled`, que está **encendido** |
| El resto (`subscription`, `document`, `applicant-cleanup`, `scheduled-driver-activation`, `notification-dispatcher`) | ❌ **No** |

**La regla, hasta que se arregle**: no ejecutar `buildApp()` en local —ni `npm run dev`— salvo que
se quiera de verdad que los schedulers corran contra los datos reales. Para comprobar que unas rutas
quedaron registradas, basta el `typecheck` y una petición contra el backend desplegado; para probar
lógica, los tests con sus propios afiliados desechables.

**La solución de fondo**, cuando se aborde: llevar la salvaguarda de `location-retention` a todos los
schedulers, o —mejor— el proyecto Supabase separado para producción que ya está en la lista de
pendientes. Mientras las dos cosas compartan base, cualquier arranque local es un actor más
escribiendo en producción.

**La lección, que ya es la tercera vez**: verificar la plataforma antes de operar sobre ella. Con
Railway fue el puerto de salida; con Android, qué permiso exige qué; aquí, qué se pone en marcha por
el simple hecho de construir la aplicación.

## 2026-08-28 — 🗺️ El mapa en blanco: MapLibre necesita DOS ficheros que el build no emite

> Costó media tarde. El síntoma estaba diseñado para engañar.

MapLibre no dibuja en el hilo principal: procesa las teselas en un **worker**, y calcula la ruta de
ese fichero **a partir de la URL de su propio módulo**. Empaquetado por Angular, esa URL apunta a un
trozo del build, así que pedía `/maplibre-gl-worker.mjs` — **un fichero que la compilación nunca
generó**.

**Por qué fue tan caro de encontrar:**

| Lo que se veía | Lo que hacía pensar |
|---|---|
| Los controles de zoom y la atribución, bien colocados | Que el mapa estaba vivo y era un problema de datos |
| El estilo, el índice de teselas y los sprites en 200 | Que la red y el proveedor estaban bien |
| Lienzo del tamaño correcto, WebGL activo, sin errores | Que era un problema de tamaño del contenedor |
| **Ni una sola petición de tesela** | Lo único que apuntaba a la verdad |

En desarrollo esa petición daba **404**; en producción la respondía el **`index.html`** por el
fallback de la SPA. MapLibre no protesta en ninguno de los dos casos.

**Y son dos ficheros, no uno**: `maplibre-gl-worker.mjs` importa `./maplibre-gl-shared.mjs`
(~490 KB). Copiando solo el primero, el worker sigue sin arrancar y el síntoma es idéntico.

**La solución** (`edv-route-admin/angular.json` + `map-view.ts`): copiar ambos a `assets/` en el
build y apuntar MapLibre con `setWorkerUrl`.

⚠️ **`angular.json` solo se lee al arrancar el servidor.** Tocar los assets y confiar en la recarga
en caliente deja el arreglo fuera: en producción funcionaba y en local no, por eso pareció que el
arreglo no servía. Hay que reiniciar `npm start`.

⚠️ **Una pestaña oculta no dibuja.** Chrome congela `requestAnimationFrame` en pestañas en segundo
plano, y sin él MapLibre no renderiza ni pide teselas. Un mapa comprobado desde una pestaña que no
está en primer plano sale en blanco **aunque esté perfecto**. Cualquier verificación visual de un
mapa exige la pestaña visible.

**La lección**, que ya va siendo un patrón en este proyecto: cuando algo falla en silencio, **mirar
la red antes que el código**. La lista de peticiones dijo en diez segundos lo que dos hipótesis
razonables sobre el tamaño del contenedor no habían encontrado en una hora.

## 2026-08-31 — 🔑 Recuperación de clave del cliente (fase C-d): misma maquinaria, identidad distinta

**Decisión**: el pasajero recupera su clave con **su correo, solo** — sin cédula, que no tiene en
el sistema — y los tres pasos corren por la **misma** `PasswordResetService` del chofer, importada
y generalizada, nunca copiada. El servicio ganó `requestClientCode`/`verifyClientCode` (resuelven
la identidad y comparten el medio del flujo) y `confirm` un parámetro de canal que solo decide la
redacción del correo de aviso («entrar con tu correo o tu teléfono», no «con tu cédula»).

**Lo que esto implica y por qué está bien:**

- **La búsqueda está acotada a `clients`.** Una cuenta que solo es chofer responde «los datos no
  coinciden» en `/client-auth/password-reset/request`: tiene su propio canal, y esta puerta no debe
  servir para confirmar correos de la lista de afiliados.
- **La enumeración con un solo campo se asume a propósito**, como se asumió la del chofer con dos:
  `/client-auth/register` ya le dice a cualquiera si un correo está tomado, así que el «no
  coinciden» de aquí no revela nada nuevo — y el pasajero que teclea mal su propio correo merece
  enterarse. Pasar a la respuesta neutra sigue siendo un cambio de una línea.
- **Un afiliado-que-es-cliente comparte LA clave** (una sola fila en `users`): recuperarla por
  cualquiera de los dos canales la cambia para ambos lados. Es coherente con la decisión de que
  conserva su clave al ganar el lado de pasajero.
- En la app, el contrato `PasswordResetRepository` se generalizó con `ResetIdentity` (correo +
  cédula opcional) y **las pantallas 2 y 3 del flujo son las mismas** para ambos canales; cada
  canal aporta su pantalla de identidad, su repositorio y sus textos.

**Pruebas**: `tests/client-password-reset.test.ts` (3 verdes) cubre lo específico del cliente:
identidad por correo, el 404 del chofer-sin-lado-cliente, el camino completo código→token→clave
nueva, la redacción del correo y el rechazo del token repetido. La maquinaria compartida ya estaba
probada en producción desde el 2026-08-24.

## 2026-08-31 — 🪪 El registro del cliente en paridad con el del afiliado (y un candado que faltaba)

**Decisión de Luis**: `users` es la tabla madre con lo básico de la persona; `drivers` y
`clients` cuelgan de ella con lo propio de cada rol — y el registro del pasajero pide **los
mismos campos** que el del afiliado. Obligatorios: primer nombre, primer apellido, **fecha de
nacimiento, cédula, teléfono**, correo y clave. Opcionales solo: segundo nombre, segundo
apellido y dirección. (Esto revierte la propuesta C2 del plan, que dejaba la cédula fuera.)

**Dónde vive la cédula del cliente**: en `clients.national_id`, NO en `users` ni en `drivers`.
La del afiliado está **verificada por la oficina** contra sus documentos; la del pasajero es
**autodeclarada** al registrarse. Son niveles de confianza distintos y una columna compartida
borraría la diferencia. Un afiliado-cliente conserva la verificada en `drivers` (no se duplica
nada en `clients`) y la API presenta ambas unificadas con `COALESCE(d.national_id,
c.national_id)`. UNIQUE parcial en `clients.national_id`; la unicidad **cruzada** (que un
pasajero nuevo no reclame la cédula de un afiliado, ni al revés) la comprueba el servicio.

**🔒 El candado que faltaba (arreglado en el mismo cambio)**: registrarse como cliente con el
correo o teléfono de un afiliado existente **adjuntaba el lado cliente y devolvía sesión SIN
verificar la clave** — saber el correo de un afiliado bastaba para obtener una sesión sobre su
cuenta (y con ella cambiarle correo y teléfono por `PATCH /me`). Ahora el camino de adjuntar
exige **probar la clave de la cuenta** (verificada como un login) y que la cédula tecleada
coincida con la verificada del afiliado. Todos los rechazos de ese camino responden **el mismo
mensaje** («Ya existe una cuenta…») para no regalar enumeración; solo el dueño legítimo (clave
correcta) recibe el aviso claro de cédula que no coincide.

**Pruebas**: `tests/client-auth.test.ts` pasó a 10 (adjuntar sin clave se rechaza; con clave y
cédula equivocada se rechaza; con ambas correctas adjunta sin duplicar nada; una cédula ajena
no se puede reclamar). Migración `1752500000000_clients-national-id` aplicada y modelos
regenerados.

## 2026-09-01 — 🎩 Los dos roles son independientes: cliente→afiliado ya funciona (y la purga no se lleva al pasajero)

**Regla de Luis, en sus palabras**: un cliente puede registrarse como afiliado y un afiliado como
cliente; si lo rechazan en un rol, el otro no se entera; son «entidades diferentes que comparten
algunos datos». Una persona (`users`), dos sombreros (`drivers`, `clients`), cada uno con su vida.

**Lo que faltaba**: la dirección cliente→afiliado. El registro de afiliado siempre creaba una
persona nueva, así que a un cliente lo rechazaba por «correo ya registrado» (y con otro correo lo
DUPLICABA como persona). Ahora `/driver-auth/register` reconoce a la persona existente —por
correo, teléfono o cédula, de cualquiera de los dos lados— y le adjunta el rol de chofer como
`applicant`, con las mismas dos pruebas del camino espejo: **su clave** (verificada como un login;
todos los rechazos responden el mismo mensaje para no regalar enumeración) y **su cédula** debe
coincidir con la que declaró como cliente. Su lado cliente no se toca: sigue activo, con su
cédula declarada donde estaba (la del chofer pasará a ser la verificada cuando la oficina revise).

**El derivado peligroso que se blindó**: la purga de solicitudes abandonadas
(`applicant-cleanup`) borra la fila de `users` en cascada. Si el solicitante abandonado era
también cliente, la purga se llevaba su vida de pasajero entera. Ahora la selección excluye a
cualquier persona con lado cliente (`NOT EXISTS clients`), con su prueba.

**Pruebas**: `tests/driver-attach.test.ts` (4: adjunta con su clave y su lado cliente intacto;
sin la clave no adjunta nada; la cédula debe coincidir; el rechazo como chofer deja al cliente
como si nada) + el caso nuevo en `applicant-cleanup.test.ts`.

**Pendiente de decisión (propuesto por Luis el mismo día)**: claves SEPARADAS por rol. Hoy la
clave es una sola (`users.password_hash`) y la usan ambos logins; separar (p. ej.
`clients.password_hash` propia, el chofer se queda donde está) haría que recuperar o cambiar la
clave de un lado no toque el otro. Toca login, recuperación y cambio de clave del cliente + una
migración. Sin construir hasta que Luis confirme.

## 2026-09-01 — 🔑 Cédula primero, formulario corto y una clave por rol (numérica de 6 a 8)

**Las tres decisiones de Luis, construidas juntas** porque se sostienen entre sí:

1. **La cédula viaja primero** en ambos registros (`register/check-cedula`): si nadie la tiene,
   formulario completo; si la persona existe sin este rol, **formulario corto**
   (`register/attach`); si ya tiene este rol, «entra con tu cuenta». Confirmar existencia por
   cédula es enumeración asumida — el mismo criterio ya tomado con el correo.
2. **El formulario corto** pide SOLO lo propio del rol nuevo: correo, teléfono y clave — más
   **la clave que ya se tiene**, que es la prueba de propiedad (sin ella, saber una cédula
   bastaría para montarse en la cuenta de otro; todos los rechazos de la prueba responden un
   único mensaje). Nombres, cédula y nacimiento ni se piden ni se muestran: nada se le revela a
   quien solo escribió una cédula.
3. **Una clave por rol** — y correo y teléfono también por rol: el chofer sigue guardando lo
   suyo en `users` (el lado del dinero NO se movió: facturas, avisos y listas intactos) y el
   cliente estrenó `clients.email/phone/password_hash` (migración `role-credentials`, con
   backfill para los clientes existentes). La recuperación de clave del pasajero ahora toca
   **solo** la clave de pasajero; la del chofer, solo la de chofer. La clave puede ser igual o
   distinta entre roles — sin limitar (decisión explícita). Los nombres **se comparten** (Luis:
   «que ambos casos compartan los nombres»): editarlos desde cualquier rol cambia a la persona.

**Política de clave nueva (ambos roles): solo números, de 6 a 8** (`^\d{6,8}$`), aplicada en
registro, cambio y recuperación. Las claves existentes siguen entrando (el login no valida
formato); la regla rige claves NUEVAS.

**Verificación**: 38 pruebas del backend en verde (client-auth 9 · driver-attach 4 ·
client-password-reset 3 · clients-admin 3 · applicant-cleanup 3 · driver-session · validation)
+ smoke de punta a punta contra el servidor local (11/11: check→registro→attach en ambas
direcciones→logins con claves propias→la clave de un rol NO abre el otro).

⚠️ **Transición en producción**: la migración copia el contacto/clave actual de cada cliente a
sus casillas nuevas, así que al desplegar nadie pierde acceso; desde ahí las copias divergen
libremente.
