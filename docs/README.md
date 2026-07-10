# Documentación — EDV Route Backend

| Documento | Contenido |
|---|---|
| [database/schema.md](database/schema.md) | **Esquema físico completo**: las 17 tablas con columnas, tipos, constraints, índices, enums y garantías |
| [database/database-design-v7.md](database/database-design-v7.md) | Diseño conceptual canónico (33 tablas, decisiones de modelado) + ERDs en la misma carpeta |
| [database/archive/](database/archive/) | Versiones históricas del diseño (v1–v6) — no usar como referencia |
| [api/endpoints.md](api/endpoints.md) | Referencia de la API REST (auth, convenciones, todos los endpoints) |
| [architecture/overview.md](architecture/overview.md) | Arquitectura: stack, capas, metodología y flujo de una petición |
| [guides/setup.md](guides/setup.md) | Levantar el entorno de desarrollo desde cero |
| [decisions/decisions-log.md](decisions/decisions-log.md) | Registro cronológico de decisiones de negocio y técnicas |

⚠️ **Regla de oro**: toda modificación de la base de datos exige regenerar los modelos
(`npm run migrate` lo hace automáticamente) **y actualizar
[database/schema.md](database/schema.md)** en el mismo cambio.
