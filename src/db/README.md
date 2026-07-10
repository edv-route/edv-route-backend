# src/db — Esquema y modelos

## ⚠️ Regla de oro

**Cada modificación de la base de datos (nueva migración, cambio de columna, nuevo enum)
exige regenerar los modelos** para que nunca queden desactualizados:

```bash
npm run db:types
```

Los comandos `npm run migrate` y `npm run migrate:down` ya lo hacen **automáticamente**
al terminar. Solo necesitas correrlo a mano si tocaste la base de datos por otra vía.

## Contenido

| Ruta | Qué es | ¿Se edita a mano? |
|---|---|---|
| `migrations/` | Migraciones versionadas (node-pg-migrate). **Fuente de verdad del esquema** | ✅ Sí — así se cambia la BD |
| `models/` | Un modelo TypeScript por tabla + enums, generados desde la BD con Kanel | ❌ **NUNCA** — se regeneran (cualquier edición manual se pierde) |
| `case-types.ts` | Helper `Camelize<T>`: convierte snake_case (BD) → camelCase (API) a nivel de tipos | ✅ Sí |
| `seed-admin.ts` | Crea el primer administrador | ✅ Sí |

## Flujo para cambiar el esquema

```bash
npm run migrate:create -- nombre-del-cambio   # 1. crear la migración
# 2. escribir el cambio en el archivo generado en migrations/
npm run migrate                               # 3. aplicar (regenera modelos solo)
npm run typecheck                             # 4. el compilador señala los repositorios afectados
```

El paso 4 es el beneficio de todo el sistema: si un cambio de esquema rompe un tipo usado
en un repositorio, **no compila** — se corrige antes de llegar a producción.
