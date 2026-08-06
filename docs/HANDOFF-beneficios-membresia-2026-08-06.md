# HANDOFF — Los beneficios nuevos no llegan a los choferes nuevos (UX de membresía)

**Fecha:** 2026-08-06 · **Estado:** diagnosticado, **SIN corregir** (a pedido de Luis; se ataca en una tarea aparte).
**Prioridad:** media-alta (confunde y hace que los afiliados no reciban los beneficios que el negocio cree haber activado).

## Síntoma reportado

Luis creó beneficios nuevos "hace días" y espera que **todo chofer nuevo** se afilie con ellos, pero
todos se registran con **un solo beneficio** (Seguro funerario), el de la primera versión.

## Diagnóstico (con datos reales de la BD — `scripts/diagnose-benefits.ts`)

- **Una sola membresía: v1**, `active=true`, **9 pagos**, beneficios de la versión = **[Seguro funerario]**.
- Catálogo de beneficios: **4 activos** — Seguro funerario (#1), Seguro de salud (#4), Etiquetas (#5),
  Seguro contra accidentes (#6).
- Los 9 choferes pagaron **v1**. **No existe v2.**

**No es un bug de código.** El backend guarda y versiona bien
(`memberships.repository.ts`: `insertBenefits`/`updateWithBenefits`/`replaceCurrent`), el alta usa la
membresía `WHERE active` (`payment-submissions.service.prepareEnrollContext` y la rama de deuda de
`drivers.service.register`), y el perfil lee los beneficios de la **versión que el chofer pagó**
(`drivers.repository` subconsulta `benefits`, join `membership_benefits` por `mp.membership_id`).

**Causa raíz:** hay DOS conceptos que se confunden:
1. **Catálogo de beneficios** = lista de beneficios que existen.
2. **Beneficios de la versión de la membresía** (`membership_benefits`) = los que esa versión otorga.

Crear un beneficio en el catálogo **no lo incluye** en la versión. Para que un beneficio llegue a los
choferes hay que **Membresía → Editar membresía → marcar el beneficio → Guardar**. Eso nunca se hizo:
v1 conserva su único beneficio. Es un fallo de **UX/mental-model**, no de datos.

## Reglas que hay que respetar al diseñar la solución

- **Inmutabilidad por versión** (doc v7 #22): editar la membresía **con pagos** archiva la versión y
  crea una réplica activa (v2); los miembros existentes **conservan** los beneficios y el precio que
  pagaron. Editar **sin pagos** es in-place. Esto es intencional y NO se debe romper.
- Con el estado actual (v1 con 9 pagos), incluir los 3 beneficios crearía **v2**; los 9 de v1 seguirían
  con 1 beneficio. En **pre-producción** conviene: borrar los choferes de prueba → editar in-place →
  v1 queda con los 4 y todos los nuevos los reciben.

## Propuestas para la tarea futura (elegir con Luis)

1. **UX en la pantalla Membresía (mínimo viable):**
   - Mostrar en la card de la versión vigente un aviso tipo *"3 de 4 beneficios del catálogo no están
     incluidos en esta versión"* con un CTA "Editar membresía".
   - Al **crear un beneficio nuevo** (en el catálogo embebido), ofrecer/checkbox *"Incluir en la
     membresía vigente"* que dispare la edición (respetando el versionado).
2. **Aclarar el lenguaje**: renombrar "Beneficios incluidos" del modal a algo que deje claro que ahí se
   decide qué otorga la membresía; y en el catálogo, una nota "crear aquí no lo activa para los choferes".
3. **(A discutir, mayor)** ¿Tiene sentido un catálogo separado con una sola membresía? Si el negocio
   nunca tendrá varias membresías, quizá el catálogo sobra y los beneficios se gestionan directo en la
   versión. Cambio de modelo — evaluar antes de tocar.

## Cómo reproducir / verificar

`node --import tsx scripts/diagnose-benefits.ts` (solo lectura) imprime versiones, catálogo y qué
versión pagó cada chofer.
