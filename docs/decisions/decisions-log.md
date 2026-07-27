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
