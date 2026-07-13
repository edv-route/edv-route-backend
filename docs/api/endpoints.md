# API REST — Referencia de endpoints

> Actualizado: 2026-07-10 · Base URL: `http://localhost:3000/api/v1`

## Convenciones

- **Auth**: salvo `GET /health` y `POST /auth/login`, todos los endpoints exigen
  `Authorization: Bearer <token>` (JWT de 8 h emitido en el login).
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
| GET | `/settings` | Configuración (las claves nacen por migración, nunca por API) |
| PATCH | `/settings/:key` | Actualizar el valor de una clave existente |

## Membresía y tarifas (versionado condicional)

Editar una versión **sin pagos** la modifica en el sitio; **con pagos** la archiva y crea una
réplica activa automáticamente (quien pagó conserva precio y beneficios de su versión).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/memberships` | Historial de versiones (la activa + archivadas) |
| GET | `/memberships/current` | Versión vigente con sus beneficios |
| POST | `/memberships` | Crear la primera membresía (409 si ya existe una vigente) |
| PUT | `/memberships/current` | Editar la vigente (versionado condicional) |
| GET / POST | `/subscription-plans` | Catálogo de tarifas (`billingPeriod: daily\|weekly\|monthly\|annual`; `allowedVehicleTypeIds` vacío/null = todos) |
| PUT | `/subscription-plans/:id` | Editar (versionado condicional) |
| PATCH | `/subscription-plans/:id/active` | Archivar / reactivar |

## Afiliados (wizard + ciclo de vida)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/drivers` | Listado paginado. Query: `status`, `search` (nombre/email/cédula), `page`, `limit` |
| POST | `/drivers` | **Paso 1**: crear (solo `fullName` obligatorio por panel; `nationalId` opcional) |
| GET | `/drivers/:id` | Perfil completo: vehículos, documentos, membresía, suscripción |
| PATCH | `/drivers/:id` | Editar datos / suspender / reactivar |
| POST | `/drivers/:id/documents` | **Paso 2** (opcional): registrar documento contra un requerimiento |
| POST | `/drivers/:id/vehicles` | **Paso 3**: registrar vehículo (por panel nace aprobado) |
| POST | `/drivers/:id/enroll` | **Paso 4**: `{ planId, periods }` — cobra membresía + tarifa; `periods > 1` = adelanto ×N. Emite facturas (la #1 agrupa membresía + primer período) |
| POST | `/drivers/:id/subscription/renew` | `{ periods }` — cobra N períodos (factura c/u). Si la tarifa está **vencida**, reactiva la operación automáticamente. Vencimientos a las 00:00 (`business_timezone`) |
| POST | `/drivers/:id/approve` | Aprobar (exige pagos registrados; la tarifa comienza a correr) |
| POST | `/drivers/:id/reject` | Rechazar: reembolsa ambos pagos y anula sus facturas (conservan número) |

## Facturación

- Numeración **continua global** (`invoice_number` desde una secuencia única, sin reinicio anual).
- Las facturas nunca se borran: los reembolsos las marcan `voided` con fecha y admin responsable.
- Comprobante **interno no fiscal** (la facturación SENIAT es un análisis aparte).

## Utilidades

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Liveness: hora de la BD + versión de PostGIS (sin auth) |
