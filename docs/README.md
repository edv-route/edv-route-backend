# Documentación — EDV Route Backend

| Documento | Contenido |
|---|---|
| [roadmap.md](roadmap.md) | **Estado del proyecto**: qué está completado, qué falta y qué está pospuesto |
| [database/schema.md](database/schema.md) | **Esquema físico completo**: las 19 tablas y la vista `v_driver_payments` con columnas, tipos, constraints, índices, enums y garantías |
| [database/database-design-v7.md](database/database-design-v7.md) | Diseño conceptual canónico (33 tablas, decisiones de modelado) + ERDs en la misma carpeta |
| [database/archive/](database/archive/) | Versiones históricas del diseño (v1–v6) — no usar como referencia |
| [api/endpoints.md](api/endpoints.md) | Referencia de la API REST (auth, convenciones, todos los endpoints) |
| [architecture/overview.md](architecture/overview.md) | Arquitectura: stack, capas, metodología y flujo de una petición |
| [features/notifications.md](features/notifications.md) | **Sistema de avisos al afiliado** (COMPLETO y encendido) (buzón transaccional, bandeja y campana): cómo funciona, los 15 avisos y de dónde salen, los candados contra el push accidental y cómo se ve en la app |
| [guides/setup.md](guides/setup.md) | Levantar el entorno de desarrollo desde cero |
| [guides/deploy-railway.md](guides/deploy-railway.md) | **Despliegue en producción** (Railway): arquitectura, variables, runbook y gotchas |
| [decisions/decisions-log.md](decisions/decisions-log.md) | Registro cronológico de decisiones de negocio y técnicas |
| [proposals/](proposals/estados-del-chofer/README.md) | **Propuestas / próximos pasos**: [rediseño del perfil del afiliado](proposals/rediseno-perfil-afiliado/README.md) (🚧 en curso, sin desplegar), [rediseño del estado del chofer](proposals/estados-del-chofer/README.md) (⭐ próximo), [tarifa con deuda y penalización](proposals/tarifa-penalizacion/README.md), y el [registro en 2 pasos](proposals/registro-2-pasos/README.md) (ya implementado) |

⚠️ **Regla de oro**: toda modificación de la base de datos exige regenerar los modelos
(`npm run migrate` lo hace automáticamente) **y actualizar
[database/schema.md](database/schema.md)** en el mismo cambio.
