# El cliente (pasajero) — plan de arranque

> Estado: **C-a a C-d HECHAS** (backend + app) · Panel: **lista de clientes HECHA**
> (2026-08-31; ficha y suspensión pendientes) · Fecha: 2026-08-31 · Pedido por Luis
>
> Alcance de esta primera entrega: **entrar, registrarse, un inicio de mentira y un perfil
> editable**. Sin viajes: eso viene después y es otro plan.

## 0. En una línea

Que un pasajero pueda crear su cuenta, entrar, ver una pantalla de inicio que **enseñe la pinta
que tendrá** (sin funcionar), moverse por la isla de iconos de abajo y editar sus datos y su foto.

---

## 1. Lo que ya está hecho y no se ve

Esto es lo que más cambia el tamaño del trabajo, así que va primero.

| Pieza | Estado |
|---|---|
| **La app ya contempla los dos modos** | ✅ `user_type_selection_screen.dart` ya muestra «Modo pasajero», deshabilitado con «Disponible muy pronto». Hay que **encenderlo**, no inventarlo |
| **`users` ya tiene todo lo que un cliente necesita** | ✅ nombres desglosados, correo, teléfono, foto, dirección, fecha de nacimiento, `password_hash` y `status` |
| **`drivers` no es un usuario: EXTIENDE a `users`** | ✅ Es el patrón a copiar: `clients` colgará igual |
| Subida de foto de perfil (bucket privado, URL firmada, valida que el JPG sea un JPG) | ✅ Existe para el chofer, se replica |
| Recuperación de clave por correo | ✅ Existe y funciona en producción |
| Validaciones de persona (nombres, correo, teléfono, cédula, clave) | ✅ Escritas y en uso en los dos canales |
| **Tabla `clients`** | ❌ **No existe** |
| **Autenticación de cliente** | ❌ No existe. El token distingue `admin` y `driver`; falta un tercero |

**La conclusión práctica**: no se construye una app nueva ni un sistema de cuentas nuevo. Se añade
una tabla delgada, un módulo de autenticación espejo del que ya funciona, y unas pantallas que
reutilizan los formularios que ya existen.

---

## 2. Decisiones que necesito de ti

Van primero porque **la número 1 cambia el resto del plan**.

| # | Pregunta | Lo que propongo | Por qué |
|---|---|---|---|
| **C1** | **¿Con qué inicia sesión un cliente?** El chofer usa cédula + clave | **Correo + clave** | La cédula tiene sentido en un afiliado: es un gremio, hay contrato y cobros. A un pasajero pedirle la cédula para bajarse una app es fricción, y encima el correo ya es el canal de recuperación obligatorio del sistema |
| **C2** | **¿Cédula obligatoria al registrarse?** | **No.** Opcional, o directamente fuera | Cada campo obligatorio cuesta registros. Si más adelante hace falta (facturación, un incidente), se pide entonces |
| **C3** | **¿Teléfono obligatorio?** | **Sí, y verificado más adelante** | Es como el chofer lo va a contactar. Pero la verificación por SMS cuesta dinero por mensaje: **hoy no**, se registra sin verificar y se decide cuando haya viajes |
| **C4** | **¿El cliente necesita aprobación?** | **No.** Se registra y entra | El chofer pasa por aprobación porque va a operar y a pagar. Un pasajero que espera aprobación para pedir un viaje se va a la competencia |
| **C5** | **¿Foto obligatoria?** | **No.** Iniciales de respaldo, como ya hace el panel | Y el día que haya viajes, el chofer agradecerá verle la cara — pero pedirla al registrarse frena |

---

## 3. La base de datos

### `clients` — delgada a propósito

Copia exacta del patrón de `drivers`: la persona vive en `users`, y esta tabla solo guarda **lo que
es propio de ser cliente**.

| Columna | Para qué |
|---|---|
| `user_id` | PK y FK → `users`, CASCADE |
| `status` | `active` / `suspended`. Un pasajero que se porta mal hay que poder pararlo |
| `accepted_privacy_at` | Consentimiento en el registro, con fecha. Mismo criterio que el chofer |
| `created_at` / `updated_at` | |

**Lo que NO lleva**, y conviene decirlo: nada de viajes, valoraciones ni métodos de pago. Esas
columnas se añaden cuando exista aquello a lo que se refieren; inventarlas ahora es adivinar.

⚠️ **La migración tiene que calificar los tipos de PostGIS si algún día guarda una dirección
favorita** — el mismo gotcha de la ubicación. Hoy no aplica.

⚠️ Tras la migración: `npm run migrate` regenera los modelos, y `npm run typecheck` después.

---

## 4. El backend

Módulo `client-auth`, **espejo de `driver-auth`**. No es copiar y pegar: es el mismo esqueleto con
las reglas del cliente.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/client-auth/register` | Crea `users` + `clients` y devuelve token. Exige aceptar privacidad |
| POST | `/client-auth/login` | Correo + clave → token |
| GET | `/client-auth/me` | Su perfil |
| PATCH | `/client-auth/me` | Edita sus datos. Cambiar la clave exige la actual |
| POST | `/client-auth/me/photo` | Foto de perfil (multipart, valida el contenido real, bucket privado) |
| POST | `/client-auth/password-reset/*` | Los tres pasos que ya existen para el chofer |

**El token gana una tercera audiencia.** Hoy `verifyAudience` distingue `admin` y `driver` con el
claim `type`; se añade `client` y su guard `authenticateClient`. **Es imprescindible**: sin esa
comprobación, un token de cliente abriría los endpoints del chofer, porque los tres se firman con
el mismo secreto.

**Duración de la sesión**: la del chofer dura un año porque su teléfono es su herramienta de
trabajo y se compensa comprobando la cuenta en cada petición. Para el cliente propongo lo mismo por
comodidad, con la misma comprobación — pero es decisión aparte si prefieres algo más corto.

### Validaciones: las que ya hay

No se inventa ninguna. `personProperties` ya define, y se reutiliza tal cual:

- **Nombres**: 2-80, con patrón que acepta acentos, apóstrofos y guiones.
- **Correo**: formato válido, 5-120. **Obligatorio**: es el canal de recuperación.
- **Teléfono**: `+58` y diez dígitos.
- **Cédula**: `V/E/J` y 5-9 dígitos (si C2 dice que se pide).
- **Clave**: mínimo 6, admite solo dígitos (tipo PIN, como la del chofer).

La app repite las mismas reglas en el formulario para avisar antes de enviar, pero **el servidor
valida igual**: el cliente puede mentir, el servidor no.

---

## 5. La app

Misma app, encendiendo el modo que ya está previsto.

| Pantalla | Qué lleva |
|---|---|
| **Selección de modo** | Se habilita «Modo pasajero» y deja de decir «muy pronto» |
| **Entrar** | Correo + clave, con «olvidé mi clave» |
| **Registrarse** | Mismo formulario del afiliado, con sus mismas validaciones, sin lo que solo aplica a un chofer |
| **Inicio (maqueta)** | La pinta que tendrá: saludo, un buscador de destino que no busca, viajes recientes de mentira **marcados como ejemplo**, accesos rápidos |
| **Isla de iconos** | Abajo, igual que la del afiliado |
| **Perfil** | Sus datos, editables, y la foto |

⚠️ **Sobre la maqueta**: lo que no funcione tiene que **decir que no funciona**. Un botón que no
hace nada es peor que no tenerlo — es la lección del tile de «Beneficios», que prometía y respondía
«próximamente». Datos de ejemplo visiblemente marcados como tales.

### Reutilización

El formulario de registro del chofer (`driver_register_screen.dart`) ya tiene los validadores
escritos, los mismos que pide el servidor. La cabecera, la subida de foto y la recuperación de
clave también existen. **La mayor parte del trabajo de la app es ensamblar, no inventar.**

---

## 6. El panel

No lo has pedido, pero lo anoto porque aparece solo en cuanto haya un cliente registrado:
**alguien tendrá que poder verlos, buscarlos y suspender a uno**. Es una sección sencilla —lista
con búsqueda y ficha—, y hasta que exista, un cliente problemático no se puede parar más que a mano
en la base de datos.

No entra en esta entrega salvo que lo pidas.

---

## 7. Orden de trabajo

| Fase | Qué | Dónde | Estado |
|---|---|---|---|
| **C-a** | Tabla `clients`, guard de cliente, y los endpoints de registro, entrada y perfil, con sus pruebas | Backend | ✅ 2026-08-31 |
| **C-b** | Entrar y registrarse en la app, con el modo pasajero encendido | App | ✅ 2026-08-31 |
| **C-c** | Isla de iconos, inicio de maqueta y perfil editable con foto | App | ✅ 2026-08-31 |
| **C-d** | Recuperación de clave del cliente | Backend + App | ✅ 2026-08-31 (misma maquinaria del chofer, identidad por correo solo; ver decisions-log) |

C-a es independiente: se prueba entera con peticiones sueltas antes de que la app tenga una
pantalla. C-b y C-c comparten el esqueleto de navegación.

**Fuera de esta entrega, a propósito**: viajes, pagos del pasajero, valoraciones, verificación del
teléfono por SMS y la sección del panel.

---

## 8. Lo que puede complicarse

| Riesgo | Cómo se evita |
|---|---|
| **Un correo ya usado por un chofer** | `users` es compartida. Un mismo correo no puede ser dos cuentas: hay que decidir si una persona puede ser chofer y pasajero a la vez (**pregunta abierta**), y hasta entonces el registro lo rechaza con un mensaje claro |
| Una app con dos modos crece y se enreda | Los dos modos ya viven separados por carpeta (`features/`); el cliente sigue el mismo corte |
| La maqueta se toma por producto terminado | Todo lo no funcional, marcado en pantalla |
| El token de cliente abre puertas del chofer | El guard comprueba la audiencia. Va en C-a, no después |
