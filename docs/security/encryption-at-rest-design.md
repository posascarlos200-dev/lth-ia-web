# Cifrado de mensajes — en reposo, transparente

**Estado (2026-07-13): PARCIALMENTE APLICADO en producción.**

Ya está vivo en el proyecto `dupdiecesnyjowfvjjre` con `pgcrypto` (`pgp_sym_encrypt`) y una
clave en Vault (`ia_messages_key`):
- ✅ Columna `public.ia_conversations.messages_enc bytea` + helpers en schema `private`
  (`ia_msg_key` / `ia_enc` / `ia_dec`), no expuestos por PostgREST.
- ✅ Trigger `trg_ia_conversations_seal`: **toda escritura nueva se cifra** y el claro se
  anula (se quitó el `NOT NULL` de `messages`).
- ✅ RPC de lectura `public.ia_pull_conversations()` (definer, filtra por `auth.uid()`,
  `coalesce(ia_dec(messages_enc), messages)` → sirve filas cifradas y aún-en-claro).
- ✅ Web (`app.js`) ya lee por el RPC.
- ✅ Respaldo del texto plano original en `private.ia_messages_migration_backup` (42 filas).

**PENDIENTE:**
- ⏳ **Backfill** de las 42 filas existentes (cifrar y anular su claro). Lo bloqueó el
  clasificador de seguridad por ser un UPDATE masivo destructivo en prod; requiere que el
  usuario lo autorice explícitamente. Comando:
  `update public.ia_conversations set messages = messages where messages is not null;`
  (el trigger las sella; ya verificado que `ia_dec(ia_enc(messages)) = messages`).
- ⏳ **LTH OS escritorio + Edge Function**: migrar su lectura al RPC / `ia_dec` (necesita el
  repo de LTH OS). Hasta entonces, no abrir LTH OS de escritorio para evitar que reescriba.
- ⏳ Tras verificar los 3 clientes: `drop table private.ia_messages_migration_backup`.

> Rollback: `update ia_conversations c set messages = b.messages from
> private.ia_messages_migration_backup b where b.id = c.id;` luego `drop trigger` y la columna.

## El modelo de amenaza (qué protege y qué no)

- **Tránsito:** ya cifrado. Todo va por HTTPS/TLS a Supabase. No hay nada que arreglar aquí.
- **En reposo:** hoy `public.ia_conversations.messages` (jsonb) guarda el chat en **texto
  plano**. Un dump/backup robado, o alguien con lectura directa a la tabla, ve todo.
- **Realidad ineludible:** Mady (el LLM en la Edge Function) *tiene que leer* el texto para
  responder, y el historial es **compartido con LTH OS** de escritorio. Por eso el cifrado
  E2E "zero-knowledge" NO es viable sin reescribir LTH OS y sin que el LLM deje de ver el
  texto (que igual lo ve al procesar). Lo viable y valioso es **cifrado en reposo**: la
  fila queda como ciphertext; solo el servidor (con la clave en Vault) descifra.

## Diseño

Clave simétrica en **Supabase Vault** (no en el código). Cifrado AEAD determinista con
`pgsodium`/`pgcrypto`. La columna `messages` en claro se reemplaza por `messages_enc bytea`
y el acceso pasa por funciones `SECURITY DEFINER` que cifran al escribir y descifran al leer.

### 1) Clave en Vault
```sql
-- una sola vez; guarda el id que devuelve
select vault.create_secret(encode(gen_random_bytes(32),'base64'), 'ia_messages_key');
```

### 2) Columna cifrada + helpers
```sql
alter table public.ia_conversations add column if not exists messages_enc bytea;

create or replace function public.ia_enc(p jsonb) returns bytea
 language plpgsql security definer set search_path = '' as $$
declare k bytea;
begin
  select decode(decrypted_secret,'base64') into k from vault.decrypted_secrets where name='ia_messages_key';
  return pgsodium.crypto_aead_det_encrypt(convert_to(coalesce(p,'null')::text,'utf8'), convert_to('ia_conversations','utf8'), k);
end $$;

create or replace function public.ia_dec(p bytea) returns jsonb
 language plpgsql security definer set search_path = '' as $$
declare k bytea;
begin
  if p is null then return null; end if;
  select decode(decrypted_secret,'base64') into k from vault.decrypted_secrets where name='ia_messages_key';
  return convert_from(pgsodium.crypto_aead_det_decrypt(p, convert_to('ia_conversations','utf8'), k),'utf8')::jsonb;
end $$;
```

### 3) Escritura transparente (trigger)
```sql
create or replace function public.ia_conversations_seal() returns trigger
 language plpgsql security definer set search_path = '' as $$
begin
  if new.messages is not null then
    new.messages_enc := public.ia_enc(new.messages);
    new.messages := null;          -- nunca persistir el claro
  end if;
  return new;
end $$;

create trigger trg_ia_conversations_seal
  before insert or update on public.ia_conversations
  for each row execute function public.ia_conversations_seal();
```

### 4) Lectura
Los clientes dejan de leer la columna `messages` directamente y pasan a una RPC/vista que
descifra solo las filas del dueño (RLS sigue aplicando por `user_id = auth.uid()`):
```sql
create or replace function public.ia_get_conversations() returns setof jsonb
 language sql security definer set search_path = '' as $$
  select jsonb_build_object(
           'id', id, 'title', title, 'source', source, 'updated_at', updated_at,
           'messages', public.ia_dec(messages_enc))
  from public.ia_conversations
  where user_id = auth.uid();
$$;
revoke execute on function public.ia_get_conversations() from public;
grant  execute on function public.ia_get_conversations() to authenticated, service_role;
```

## Cambios necesarios en clientes (por eso no se auto-aplica)

1. **Frontend (este repo, `app.js`):** el `SELECT ...&select=...,messages,...` sobre
   `/rest/v1/ia_conversations` (~línea 2057) debe migrar a la RPC `ia_get_conversations`.
   El `upsert` (~línea 2150) sigue mandando `messages` en claro por TLS; el trigger lo sella.
2. **Edge Function `lth-ia-cloud` (repo LTH OS):** donde lea historial, usar la RPC o
   `ia_dec`. Escribe con `service_role`; el trigger la sella igual.
3. **LTH OS escritorio:** misma migración de lectura a la RPC. **Crítico:** si LTH OS sigue
   leyendo `messages` directo, verá `null` tras el corte.

## Plan de corte (sin downtime, reversible)

1. Añadir `messages_enc`, helpers, trigger (el trigger empieza a sellar lo nuevo).
2. Backfill: `update ia_conversations set messages_enc = ia_enc(messages), messages = null where messages is not null;` por lotes.
3. Migrar los tres clientes a la lectura por RPC y desplegar.
4. Verificar en los tres (web, edge, escritorio) que el historial se lee bien.
5. Solo entonces: quitar/one-way la columna `messages` en claro.

> Rollback: mientras exista la columna `messages`, se puede repoblar desde `messages_enc`
> con `ia_dec` y desactivar el trigger.
