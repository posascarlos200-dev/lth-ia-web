-- ============================================================================
-- LTH IA · Hardening de RPCs SECURITY DEFINER  (aplicado 2026-07-12)
-- Proyecto: dupdiecesnyjowfvjjre (LTH OS)
--
-- Este archivo documenta las DOS migraciones ya aplicadas a producción:
--   1) lock_reasoning_rpcs_anon_and_ownership_guard
--   2) revoke_public_execute_on_reasoning_rpcs
--
-- Motivo: ai_consume_reasoning_use / ai_get_reasoning_status /
-- ai_try_reasoning_free_call / ai_get_reasoning_models eran ejecutables por
-- `anon` (grant por defecto a PUBLIC) y las tres primeras confiaban en el
-- p_user_id enviado por el cliente -> IDOR + abuso de cuota + fuga de estado.
--
-- Idempotente y compatible hacia atrás: service_role (auth.uid() nulo) sigue
-- pudiendo pasar cualquier p_user_id; un usuario `authenticated` solo puede
-- operar sobre SÍ MISMO.
-- ============================================================================

-- ----- Migración 1: guard de propiedad -----

create or replace function public.ai_consume_reasoning_use(p_user_id uuid, p_app_id text default 'lth-ia'::text, p_metadata jsonb default '{}'::jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_profile public.profiles%rowtype;
  v_limits public.ai_plan_limits%rowtype;
  v_wallet public.ai_user_wallets%rowtype;
  v_days integer; v_period interval; v_anchor timestamptz; v_start timestamptz; v_end timestamptz;
  v_limit integer; v_used integer;
begin
  if p_user_id is null then return jsonb_build_object('allowed', false, 'reason', 'not_authenticated', 'error', 'Debes iniciar sesion.'); end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_profile from public.profiles where id = p_user_id;
  select * into v_limits from public.ai_plan_limits where plan = coalesce(v_profile.plan, 'free'::public.lth_plan);
  v_limit := greatest(coalesce(v_limits.reason_weekly_uses, 0), 0);
  if v_profile.plan_active is distinct from true or v_limit <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'not_in_plan', 'limit', v_limit, 'used', 0, 'remaining', 0, 'error', 'Tu plan no incluye el modo razonamiento.');
  end if;
  v_wallet := public.ai_prepare_wallet(p_user_id);
  if v_wallet.weekly_started_at is null then
    update public.ai_user_wallets set weekly_started_at = now(), updated_at = now() where user_id = p_user_id returning * into v_wallet;
  end if;
  v_days := greatest(coalesce(v_limits.weekly_window_days, 7), 1);
  v_period := make_interval(days => v_days);
  v_anchor := v_wallet.weekly_started_at;
  if now() < v_anchor then v_start := v_anchor;
  else v_start := v_anchor + (floor(extract(epoch from (now() - v_anchor)) / greatest(extract(epoch from v_period), 1))::bigint * v_period); end if;
  v_end := v_start + v_period;
  select count(*)::integer into v_used from public.ai_reasoning_uses where user_id = p_user_id and used_at >= v_start and used_at < v_end;
  if v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'reason', 'weekly_exhausted', 'limit', v_limit, 'used', v_used, 'remaining', 0,
      'resets_at', v_end, 'seconds_until_reset', greatest(0, floor(extract(epoch from (v_end - now())))::integer),
      'error', 'Te quedaste sin usos de razonamiento esta semana.');
  end if;
  insert into public.ai_reasoning_uses (user_id, app_id, metadata) values (p_user_id, p_app_id, coalesce(p_metadata, '{}'::jsonb));
  update public.ai_user_wallets set reason_free_calls = 4, reason_free_until = now() + interval '5 minutes', updated_at = now() where user_id = p_user_id;
  v_used := v_used + 1;
  return jsonb_build_object('allowed', true, 'reason', 'ok', 'limit', v_limit, 'used', v_used, 'remaining', greatest(v_limit - v_used, 0),
    'resets_at', v_end, 'seconds_until_reset', greatest(0, floor(extract(epoch from (v_end - now())))::integer));
end;
$function$;

create or replace function public.ai_get_reasoning_status(p_user_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_profile public.profiles%rowtype;
  v_limits public.ai_plan_limits%rowtype;
  v_wallet public.ai_user_wallets%rowtype;
  v_days integer; v_period interval; v_anchor timestamptz; v_start timestamptz; v_end timestamptz;
  v_limit integer; v_used integer;
begin
  if p_user_id is null then return jsonb_build_object('enabled', false, 'reason', 'not_authenticated'); end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_profile from public.profiles where id = p_user_id;
  select * into v_limits from public.ai_plan_limits where plan = coalesce(v_profile.plan, 'free'::public.lth_plan);
  v_limit := greatest(coalesce(v_limits.reason_weekly_uses, 0), 0);
  if v_profile.plan_active is distinct from true or v_limit <= 0 then
    return jsonb_build_object('enabled', false, 'reason', 'not_in_plan', 'limit', v_limit, 'used', 0, 'remaining', 0, 'cost', coalesce(v_limits.reason_use_cost, 25));
  end if;
  v_wallet := public.ai_prepare_wallet(p_user_id);
  if v_wallet.weekly_started_at is null then
    update public.ai_user_wallets set weekly_started_at = now(), updated_at = now() where user_id = p_user_id returning * into v_wallet;
  end if;
  v_days := greatest(coalesce(v_limits.weekly_window_days, 7), 1);
  v_period := make_interval(days => v_days);
  v_anchor := v_wallet.weekly_started_at;
  if now() < v_anchor then v_start := v_anchor;
  else v_start := v_anchor + (floor(extract(epoch from (now() - v_anchor)) / greatest(extract(epoch from v_period), 1))::bigint * v_period); end if;
  v_end := v_start + v_period;
  select count(*)::integer into v_used from public.ai_reasoning_uses where user_id = p_user_id and used_at >= v_start and used_at < v_end;
  return jsonb_build_object(
    'enabled', true, 'reason', 'ok',
    'limit', v_limit, 'used', v_used, 'remaining', greatest(v_limit - v_used, 0),
    'cost', coalesce(v_limits.reason_use_cost, 25),
    'week_started_at', v_start, 'resets_at', v_end,
    'seconds_until_reset', greatest(0, floor(extract(epoch from (v_end - now())))::integer)
  );
end;
$function$;

create or replace function public.ai_try_reasoning_free_call(p_user_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_wallet public.ai_user_wallets%rowtype;
begin
  if p_user_id is null then return jsonb_build_object('free', false); end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.ai_user_wallets
  set reason_free_calls = reason_free_calls - 1, updated_at = now()
  where user_id = p_user_id and reason_free_until is not null and reason_free_until > now() and reason_free_calls > 0
  returning * into v_wallet;
  if v_wallet.user_id is null then return jsonb_build_object('free', false); end if;
  return jsonb_build_object('free', true, 'remaining_free_calls', greatest(v_wallet.reason_free_calls, 0));
end;
$function$;

alter function public.lth_version_cmp(text, text) set search_path = '';

-- ----- Migración 2: quitar el acceso de PUBLIC (de ahí venía `anon`) -----
-- authenticated y service_role ya están concedidos explícitamente y quedan intactos.
revoke execute on function public.ai_consume_reasoning_use(uuid, text, jsonb) from public;
revoke execute on function public.ai_get_reasoning_status(uuid)              from public;
revoke execute on function public.ai_try_reasoning_free_call(uuid)           from public;
revoke execute on function public.ai_get_reasoning_models()                  from public;
