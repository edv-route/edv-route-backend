# Profesionales del Volante — Documentación de diseño

Plataforma de transporte (tipo taxi/carrera) de un gremio: apps móviles para clientes y afiliados, panel web de administración. **El módulo admin está en desarrollo activo** (ver [architecture/overview.md](../architecture/overview.md)). Se construirá primero el módulo admin.

## Por dónde empezar

1. **[database-design-v7.md](database-design-v7.md)** — el documento canónico: arquitectura, las 33 decisiones vigentes, las 33 tablas con sus campos, convenciones y trabajo pendiente. Si algo contradice a cualquier otro documento, gana este.
2. **[database-erd-v7.png](database-erd-v7.png)** — el modelo v7 completo en una imagen anotada (5 vistas, 33 tablas con descripción, incluida la facturación). Para presentar a terceros.
3. **[database-erd-v7-admin.png](database-erd-v7-admin.png)** — la vista del módulo admin v7 (2 vistas en alta resolución, 15 tablas con descripciones, facturación incluida). Para revisar con el equipo.
4. **[erd-svg-v7/](erd-svg-v7/)** — las 5 vistas del modelo v7 en SVG vectorial (zoom sin pérdida).
5. **Artifact navegable** (documento web con FKs clicables, al día en v7): https://claude.ai/code/artifact/73b24b23-2944-47d4-b4c7-8cb01f3c47a5

Históricos (no usar como referencia): documentos v1 a v6, imágenes v1/v3/v4/v5/v6 ([database-erd-v1.png](archive/database-erd-v1.png), [database-erd-v3.png](archive/database-erd-v3.png), [database-erd-v3-admin.png](archive/database-erd-v3-admin.png), [database-erd-v4.png](archive/database-erd-v4.png), [database-erd-v4-admin.png](archive/database-erd-v4-admin.png), [database-erd-v5-admin.png](archive/database-erd-v5-admin.png), [database-erd-v6.png](archive/database-erd-v6.png), [database-erd-v6-admin.png](archive/database-erd-v6-admin.png)) y carpetas [erd-svg/](archive/erd-svg/), [erd-svg-v3/](archive/erd-svg-v3/), [erd-svg-v4/](archive/erd-svg-v4/), [erd-svg-v6/](archive/erd-svg-v6/).

## Cronología de las decisiones (2026-07-07)

- **Ronda 1 — fundamentos**: arquitectura frontend + backend propio (Node.js/Fastify, REST + WebSockets) + PostgreSQL/PostGIS en Supabase; Supabase Auth para usuarios de apps; sin APIs pagas en desarrollo (PostGIS para distancias con factor de corrección, OSM para mapas, FCM para push); 13 decisiones de negocio del dominio de viajes (cancelaciones, moneda dual USD/Bs, subasta con expiración, matching por radio expansivo, etc.).
- **Ronda 2 — módulo admin**: tabla `admins` separada con auth propio en Fastify; planes de suscripción (diario/semanal/mensual/anual) en modalidad prepago con gracia configurable, reemplazando la cuota semanal fija del PDF original; registro dual de choferes (app y admin); tipo de vehículo nullable + camioneta; capacitaciones con entidad propia; alcance del panel cerrado (dashboard, documentos con vencimientos, beneficios, auditoría).
- **Ronda 3 — membresía y renombrado**: membresía como requisito de afiliación (se paga antes de la aprobación; rechazo → reembolso registrado); otorga los beneficios; renombrado global al lenguaje del negocio.
- **Ronda 4 (2026-07-08) — corrección con el colega**: renombrado interno REVERTIDO (código dice chofer/suscripción, pantalla dice Afiliado/Tarifa); dos tipos de usuario (user | driver) en `users` y la tabla `clients` eliminada; membresías múltiples y **recurrentes** (mensual/anual, ya no vitalicias), cada una con sus beneficios, una activa por chofer; inmutabilidad por versión ("regla de los 150 USD": editar un plan con suscriptores archiva la versión y crea otra — los vigentes conservan precio y beneficios hasta vencer).
- **Ronda 5 (2026-07-08) — confirmación de la dueña**: la membresía vuelve a ser **única con pago único vitalicio**; nuevas **promociones de membresía** (ventanas temporales con descuento porcentual o fijo, una activa, aplicación automática); los **beneficios son globales y vigentes** (la versión pagada congela solo el precio); en tarifas, **adelanto de N períodos** ("pago × 10 semanas" genera 10 pagos con su período exacto) y los adelantos no consumidos **no se reembolsan** (debe constar en el contrato).
- **Ronda 6 (2026-07-08)**: beneficios linkeados a la membresía y **por versión** (el miembro goza los de la versión que pagó); **versionado condicional** (sin pagos se edita in place, con pagos se crea réplica; el admin siempre edita la última activa); **promociones suprimidas** (pospuestas); nueva tabla **requirements** (documentos exigibles configurables para chofer y vehículo, con obligatoriedad); **wizard de registro en 4 pasos** (datos → documentos → vehículo → pago de membresía **+ tarifa**, con activación de la tarifa diferida a la aprobación y doble reembolso si se rechaza); **ratings por rol** (`clients` reintroducida, `users` sin role — una cuenta puede ser chofer y cliente).
- **Ronda 7 (2026-07-08)**: los requerimientos obligatorios **solo bloquean el registro desde la app** (el admin puede omitirlos, chofer y vehículo); en el paso 4 el chofer elige **tarifa básica o adelantar N períodos**; nueva tabla **invoices** — **facturación interna uniforme** (todo cobro emite comprobante; en el wizard la factura #1 agrupa membresía + primera tarifa y cada período adelantado lleva la suya: 10 semanas → 10 facturas), **no fiscal** (⚠️ SENIAT es análisis aparte con el contador) y con **anulación con rastro** en reembolsos.

## Glosario (fijado — evita la colisión de términos)

| En pantalla (frontend) | En código/BD | Qué es |
|---|---|---|
| Afiliado | `drivers` | El chofer miembro del gremio (una cuenta puede ser también cliente) |
| Membresía | `memberships` | Pago único vitalicio; da los beneficios de la versión pagada |
| Tarifa | `subscription_plans` | Plan recurrente (diario→anual) que habilita operar |
| Requerimientos | `requirements` | Documentos exigibles configurables (obligatorios solo desde la app) |
| Factura / Recibo | `invoices` | Comprobante interno de cada cobro (no fiscal), con anulación trazable |
| Tarifa de viaje | `fare_rules` | Cálculo del precio del viaje para el pasajero (base + km + min) |

(Promociones de membresía: concepto pospuesto en la ronda 6 — sin tabla por ahora.)

## Próximos pasos

1. Flujos críticos segundo a segundo (wizard de 4 pasos → aprobación → activación diferida de tarifa → renovación/adelantos con facturas → gracia → suspensión; rechazo con doble reembolso y anulación).
2. Refinamiento lógico (tipos definitivos, enums, constraints, índices, numeración de facturas, lógica de réplica del versionado condicional).
3. Matriz de permisos (dos planos de identidad: admins con auth propio, usuarios con Supabase).
4. DDL y migraciones — solo con autorización explícita.

---
*Los diagramas se regeneran desde definiciones mermaid; pedir "regenerar diagramas BD" en cualquier sesión de Claude Code.*
