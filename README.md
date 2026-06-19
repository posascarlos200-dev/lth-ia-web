# LTH IA · Mady (web)

Web móvil/PC para chatear con Mady. Es un sitio estático (HTML, CSS y JavaScript) conectado a Supabase Auth, las Edge Functions de LTH IA y el historial compartido con LTH OS.

## Acceso por invitación

Las cuentas que ya existían antes de desplegar la migración conservan el acceso. Los nuevos usuarios de la web siguen este flujo:

1. Escriben correo y una contraseña segura de 12 caracteres.
2. Cloudflare Turnstile y los límites internos validan la solicitud.
3. Supabase Auth guarda la contraseña y mantiene la cuenta sin confirmar.
4. La solicitud aparece en **Pendientes** dentro de LTH OS Admin.
5. El owner genera el PIN, lo envía manualmente y pulsa **Marcar enviado**.
6. El usuario dispone de 24 horas y 5 intentos para introducirlo.
7. Tras validarlo, vuelve a iniciar sesión con su contraseña.

Nunca se almacenan contraseñas ni PIN en texto. La web conserva únicamente un token opaco para consultar el estado.

## Componentes

- `lth-ia-cloud`: chat autenticado; conserva su protección JWT actual.
- `lth-ia-invites`: endpoint dedicado para solicitudes, estado, PIN y autorización web.
- `lth_ia_web_access`: ciclo de vida de las invitaciones, cerrado a `anon` y `authenticated` mediante RLS y privilegios.
- LTH OS Admin: lista pendiente, generación de PIN, envío, rechazo y reapertura con auditoría.

## Configuración obligatoria antes de producción

En `config.js`:

- `TURNSTILE_SITE_KEY`: clave pública del widget para el dominio real de Vercel.
- `INVITE_FUNCTION_PATH`: `/functions/v1/lth-ia-invites`.

Como secretos de Supabase:

- `TURNSTILE_SECRET_KEY`.
- `LTH_IA_INVITE_PEPPER`, aleatorio y con al menos 32 caracteres.

También se debe activar **Leaked Password Protection** en Supabase Auth y autorizar el dominio real en Turnstile. No desplegar la web nueva antes de completar estos puntos.

## Orden de despliegue

1. Aplicar `supabase/migrations/20260619120000_lth_ia_web_invitation_access.sql`.
2. Comprobar que todas las cuentas actuales quedaron como `grandfathered`.
3. Configurar los dos secretos.
4. Desplegar `lth-ia-invites` con `verify_jwt=false` únicamente para esa función.
5. Desplegar la versión actualizada de `lth-admin-api` y compilar LTH OS Admin.
6. Configurar Turnstile para el dominio de Vercel y colocar la site key en `config.js`.
7. Publicar LTH IA Web.
8. Repetir Security Advisor y Performance Advisor.

## Pruebas locales

```powershell
node tests/invitation-flow.test.js
node ..\..\scripts\test-lth-ia-web-invitations.js
```

El registro real permanece desactivado localmente mientras `TURNSTILE_SITE_KEY` esté vacío. El inicio de sesión existente se mantiene visible.