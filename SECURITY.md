# Seguridad · LTH IA Web

Registro de la auditoría de seguridad del **2026-07-12** y de los controles vigentes.
Proyecto Supabase: `dupdiecesnyjowfvjjre` (LTH OS). Este repo es **solo el frontend**;
las Edge Functions y las migraciones "de verdad" viven en el repo de LTH OS.

## Resumen de la auditoría

| Área | Resultado |
|------|-----------|
| Secretos en el repo / historial de git | **Limpio.** Solo se exponen `SUPABASE_PUBLISHABLE_KEY` y `TURNSTILE_SITE_KEY`, que son claves públicas de cliente por diseño. Nunca se commiteó `.env`, `service_role` ni `sb_secret_`. |
| RLS de Supabase | **Sólidas.** `ia_conversations` / `ia_media` scope `user_id = auth.uid()`; `profiles` bloquea auto-escalada de plan/email; tablas `private.*` con deny total. |
| RPCs `SECURITY DEFINER` | **Corregido** (ver abajo). |
| Renderizado de mensajes (XSS) | Patrón seguro: `renderMarkdown` escapa primero y solo permite enlaces `https?://`; el iframe de vista previa es `sandbox` **sin** `allow-same-origin`. |
| Cabeceras HTTP | **Añadidas** en `vercel.json` (este commit). |

## Corregido en la base de datos (aplicado el 2026-07-12)

Dos migraciones aplicadas al proyecto de producción. SQL archivado en
[`docs/security/20260712_reasoning_rpc_hardening.sql`](docs/security/20260712_reasoning_rpc_hardening.sql).

1. **RPCs de razonamiento ejecutables por `anon`.** `ai_consume_reasoning_use`,
   `ai_get_reasoning_status`, `ai_try_reasoning_free_call` y `ai_get_reasoning_models`
   estaban abiertas a `anon` (vía el grant por defecto a `PUBLIC`) y las tres primeras
   confiaban en un `p_user_id` recibido del cliente. Un anónimo podía, con solo la clave
   anon pública, **agotar la cuota de razonamiento de cualquier usuario**, regalarse
   llamadas internas gratis, o **leer el estado de plan/consumo de cualquiera** (IDOR).
   - Fix: `REVOKE EXECUTE ... FROM PUBLIC` (quedan `authenticated` + `service_role`) y se
     añadió guard de propiedad `if auth.uid() is not null and p_user_id is distinct from auth.uid() then raise 'forbidden'`
     a las tres funciones. Compatible hacia atrás: `service_role` (edge function, `auth.uid()` nulo)
     puede seguir pasando cualquier `p_user_id`; un usuario `authenticated` solo opera sobre sí mismo.
2. **`lth_version_cmp` con `search_path` mutable** → fijado a `''` (limpia el WARN del linter).

## Pendiente — requiere acción manual en el dashboard

- [ ] **Activar Leaked Password Protection** en Supabase Auth
  (Authentication → Policies → "Leaked password protection"). No se puede activar por SQL.
  Ya figuraba como obligatorio en el README. Ref:
  https://supabase.com/docs/guides/auth/password-security
- [ ] **Rotar el Personal Access Token** de Supabase que se usó para esta auditoría
  (Account → Access Tokens). Un PAT es de alcance amplio; rótalo tras cualquier uso compartido.

## Cabeceras HTTP (este repo, `vercel.json`)

Se aplicó el subconjunto **seguro** (no rompe nada, aun sin poder probar en vivo):
`frame-ancestors 'none'` + `X-Frame-Options: DENY` (anti-clickjacking), `nosniff`,
`Referrer-Policy`, `HSTS`, `Permissions-Policy`, `object-src 'none'`, `base-uri 'self'`.

### CSP completa recomendada (habilitar tras probar)

La app hace fetch **desde el navegador** a DuckDuckGo y Wikipedia (capa de investigación
gratuita), carga Turnstile, y la función "Crear algo" inyecta scripts inline vía `srcdoc`.
Por eso una CSP estricta debe probarse antes de forzarla. Política objetivo:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: blob: https:;
connect-src 'self' https://dupdiecesnyjowfvjjre.supabase.co https://challenges.cloudflare.com https://api.duckduckgo.com https://duckduckgo.com https://*.wikipedia.org;
frame-src 'self' https://challenges.cloudflare.com;
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

> Notas: `'unsafe-inline'` en `script-src` es necesario mientras la vista previa ejecute
> scripts inline vía `srcdoc` (hereda la CSP del padre). `'unsafe-eval'` cubre a jsPDF si
> lo requiere — verificar. Aun con esas dos excepciones, la CSP sigue aportando: bloquea
> orígenes de script/exfiltración no listados, plugins, y secuestro de `<base>`.

## Cifrado de mensajes

Ver [`docs/security/encryption-at-rest-design.md`](docs/security/encryption-at-rest-design.md).
El tránsito ya va por TLS. El hueco real era **en reposo** (`ia_conversations.messages` en
texto plano). **Cifrado en reposo transparente (pgcrypto + Vault) ya está aplicado**
(2026-07-13): trigger que sella toda escritura, RPC de lectura que descifra, la web ya lee por
el RPC, y **las 42 filas existentes ya están cifradas** (backfill verificado, cero pérdida).
**Pendiente:** migrar la lectura de LTH OS de escritorio y la edge function al RPC/`ia_dec`
(necesita el repo de LTH OS), y luego borrar `private.ia_messages_migration_backup`.
