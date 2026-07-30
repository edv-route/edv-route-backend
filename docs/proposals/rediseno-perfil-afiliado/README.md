# Rediseño del perfil del afiliado + documentos por vehículo

> **Estado: EN CURSO (2026-07-28).** Frontend compila limpio (build de producción) y el
> backend con typecheck + tests verdes. **Nada de este bloque está pusheado ni desplegado**
> todavía — probar en local primero. Este documento es la fuente de verdad del alcance,
> lo hecho y lo que falta.

## Contexto y objetivo

El perfil del afiliado (`driver-detail`) mostraba 3 tarjetas apretadas (Datos · Vehículos ·
Documentos) y trataba documentos y vehículos como **dos listas planas sin relación**: no se
sabía a qué vehículo pertenecía cada documento, aunque el modelo de BD **ya** lo soporta
(`documents.driver_id` XOR `vehicle_id`, CHECK `documents_exactly_one_owner`;
`requirements.applies_to = driver|vehicle`).

Objetivo: perfil en **pestañas a ancho completo**, vehículos como **catálogo con fotos**,
**detalle de vehículo en pantalla propia** con sus documentos, separar documentos de chofer vs
vehículo, **quitar la fecha de vencimiento** y **unificar el patrón de alta con modales**.

## Decisiones cerradas

- **3 pestañas** en el perfil: Datos personales (por defecto) / Vehículos / Documentos.
- **Vehículos como cards con 1–3 fotos**; **detalle del vehículo en PANTALLA NUEVA** (no modal).
- **Documentos del perfil = solo del chofer**; los del vehículo viven bajo cada vehículo.
- **Alta de vehículo y de documento del chofer por MODAL** (patrón "+ Agregar" → diálogo), no
  editores inline. En el **wizard** el modal **no persiste nada**: emite un draft y todo se
  guarda en la transacción única de `POST /drivers/register`. **Ninguna función guarda un
  vehículo/documento sin su chofer.**
- **Fecha de vencimiento: se elimina** (queda solo la fecha de registro). Retirada de la UI ya;
  la limpieza destructiva de BD/backend es la **Fase 5** (pendiente).
- Las **fotos del wizard** se suben tras el `register`, contra `createdVehicles` (el vehículo no
  tiene id hasta registrar).

## Hecho y verificado

### Backend

| Pieza | Detalle |
|---|---|
| Tabla `vehicle_images` | Migración `1752310000000`. Columnas: `id`, `vehicle_id` (FK CASCADE), `file_url`, `position` smallint CHECK 1–3, `uploaded_by`, `created_at`; `UNIQUE(vehicle_id, position)`. Modelos regenerados. Ya aplicada a la BD compartida. Ver [schema.md](../../database/schema.md#vehicle_images--fotos-del-vehículo-máx-3). |
| Módulo `vehicles/vehicle-images` | `repository` + `service` + `routes` (montado bajo `/drivers`). Solo JPG/PNG validado por contenido; ruta `${driverId}/vehicles/${vehicleId}/${uuid}.ext`; máx 3 → 409. `findDetail` devuelve `images[]` por vehículo. |
| Endpoints de fotos | `POST /drivers/:id/vehicles/:vehicleId/images` (201) · `GET …/images/:imageId/file` (URL firmada 60 s) · `DELETE …/images/:imageId` (204, borra fila + archivo). |
| `DELETE /documents/:id` | Módulo `documents`: borra la fila **y** el archivo del storage. Requirió abrir CORS a `DELETE` en `app.ts` (el preflight no lo permitía). |
| `PATCH /drivers/:id/vehicles/:vehicleId` | Editar datos del vehículo (tipo, marca, modelo, año, color, placa). |
| `register` anidado | `POST /drivers/register` acepta `vehicles[].documents[]` (documentos de vehículo, `applies_to='vehicle'`); `insertDocument` parametrizado para dueño `{driverId}` XOR `{vehicleId}`; respuesta con **`createdVehicles: [{ id, documentIds }]`** para correlacionar la subida de archivos. |
| Fix crítico `db.ts` | `pool.on('error')` — el pooler de Supabase recicla conexiones idle y sin este listener el proceso **crasheaba** (era la causa de que "Registrar vehículo" se colgara). Ver [decisions-log](../../decisions/decisions-log.md). |

### Frontend (admin)

| Pieza | Detalle |
|---|---|
| Perfil en 3 pestañas | `driver-detail` a ancho completo (antes 3 tarjetas). |
| Detalle de vehículo | `driver-vehicle-detail`, ruta `/drivers/:id/vehicles/:vehicleId`: datos + galería de fotos (subir/ver/borrar) + **documentos del vehículo**. Las cards del perfil enlazan "Ver detalle y documentos →". |
| Documentos del perfil = solo chofer | La pestaña Documentos filtra `appliesTo === 'driver'`; card con chip **Adjunto**/**Sin archivo**, y Ver/Descargar/Reemplazar/Quitar. |
| Modal de vehículo (perfil) | `features/drivers/vehicle-form` (modal 2 columnas: datos+fotos \| documentos). Crea el vehículo y luego sube fotos + crea docs con archivo. |
| Editar vehículo | `PATCH …/vehicles/:vehicleId` + botón "Editar" en el detalle del vehículo. |
| **Wizard — paso Vehículo → MODAL** | `features/drivers/vehicle-draft-modal` (captura pura, **sin HTTP**; emite `VehicleDraft` con `File[]` de fotos + documentos con `File`; soporta **editar** vía `initial`). El paso 3 es lista de cards + tile "+ Agregar vehículo" + modal. URLs de preview con dueño claro (el modal crea/revoca; al confirmar se ceden al wizard). |
| **Wizard — paso Documentos → MODAL** | `features/drivers/document-draft-modal` (captura pura; emite `DocDraft`; **editar** vía `initial` + `takenIds`; solo requerimientos `appliesTo === 'driver'`). El paso 2 es lista + tile "+ Agregar documento" + modal, mismo patrón que vehículos. |
| Vencimiento fuera de la UI | Wizard (paso 2) y modal "Agregar documento" del perfil sin campo "Vence"; card sin "Vence/Sin vencimiento" ni badge "Vencido". El `register` sigue enviando `expiresAt: null` (contrato intacto). |
| Flag dev `unlockSteps` | `environment.unlockSteps` (dev `true` / prod `false` vía `environment.prod.ts` + fileReplacements). Permite saltar al paso 2+ del wizard sin llenar el paso 1 (solo para visualizar en desarrollo). |

## Falta por hacer

Ordenado por prioridad / riesgo.

1. **Smoke test en navegador del registro completo** — recorrer wizard (documentos de chofer +
   vehículos con fotos/documentos por modal) → `register` → verificar que suben fotos y archivos
   contra `createdVehicles`, y que no quedan huérfanos si el register falla.
2. **Fase 5 — quitar `expires_at` del backend/BD (DESTRUCTIVO)**. La UI ya no lo usa; falta:
   - Migración `dropColumn documents.expires_at` + `UPDATE status='valid' WHERE status='expired'`
     (mantener el enum `document_status`: Postgres no permite quitar un valor; `expired` queda sin uso).
   - Eliminar el `document-scheduler`, las alertas de documentos del dashboard, el filtro
     `expiringDays` del módulo documents y la columna en la vista global `Documentos`.
   - Quitar `expiresAt` en drivers (register/addDocument/insertDocument/findDetail/routes) y en los
     modelos/UI del frontend.
   - **Orden seguro (mismo cambio):** editar código → `npm run migrate` (regenera) → `npm run typecheck`
     (revela todas las refs) → build → docs.
3. **Editar el requerimiento de un documento ya persistido (perfil)** — hoy solo se puede
   **Reemplazar** el archivo o Quitar+volver a agregar. Si se quiere editar el requerimiento haría
   falta un `PATCH /documents/:id`. Pendiente de decisión.
4. **Miniatura** de la primera foto en las cards de vehículo del perfil (opcional).
5. **Docs canónicos** — este documento + `endpoints.md` (ya actualizado con fotos de vehículo,
   `DELETE /documents/:id`, `PATCH` de vehículo y `register` anidado) + `decisions-log.md`
   (entrada 2026-07-28). `schema.md` ya incluía `vehicle_images`.
6. **Push + deploy** — nada de este bloque está en producción; probar en local primero.

## Verificación

- **Backend**: `npm run typecheck`; tras `migrate` confirmar modelos regenerados; curl de endpoints
  (4ª imagen → 409, XOR dueño válido, fallo forzado del `register` sin huérfanos de storage).
- **Frontend**: `npm start`; recorrer pestañas → card de vehículo → detalle → fotos (add/delete/view)
  → documento de vehículo; wizard con documentos y vehículos por modal (agregar + editar); confirmar
  que el vencimiento desapareció de la UI y que dashboard/`/documents` renderizan sin regresión.

## Riesgos

- **CHECK XOR dueño** en `documents`: `insertDocument` debe setear exactamente uno; probar ambas ramas.
- **Huérfanos de storage** al borrar imagen/documento (`storage.remove`); borrar un vehículo dejaría
  archivos huérfanos (endpoint futuro).
- **`expiresAt` solo se revela por completo tras `migrate`** (typecheck) → tratar migrate+typecheck
  como un único gate en la Fase 5.
- **Límite 1000 líneas**: preferir componentes nuevos a anexar.

## Referencias

- API: [api/endpoints.md](../../api/endpoints.md) · Esquema: [database/schema.md](../../database/schema.md)
- Decisiones: [decisions/decisions-log.md](../../decisions/decisions-log.md)
- Relacionado: [registro en 2 pasos](../registro-2-pasos/README.md) (base del wizard transaccional).
