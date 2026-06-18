/* ════════════════════════════════════════════════════════════
   LTH IA Web · app.js
   Chat movil con Mady. Auth Supabase (email/password) + edge
   function lth-ia-cloud (stream SSE) + historial sincronizado
   con la tabla ia_conversations (compartido con PC y LTH Remote).
   Sin dependencias, sin build: archivos estaticos.
   ════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const CFG = window.LTH_IA_CONFIG || {};
  const SB_URL = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const SB_KEY = String(CFG.SUPABASE_PUBLISHABLE_KEY || '');
  const FN_URL = SB_URL + (CFG.FUNCTION_PATH || '/functions/v1/lth-ia-cloud');
  const REST_URL = SB_URL + '/rest/v1/ia_conversations';
  const AUTH_URL = SB_URL + '/auth/v1';

  const SESSION_KEY = 'lth_ia_web_session_v1';
  const CONVO_KEY = 'lth_ia_web_convos_v1';
  const TOMB_KEY = 'lth_ia_web_tombstones_v1';
  const HISTORY_LIMIT = 18;

  const SYSTEM_PROMPT = [
    'Eres LTH IA, tambien llamada Mady: la asistente oficial del ecosistema LTH OS, hablando desde la web movil del usuario.',
    'Tu tono es cercano, claro y resolutivo. Respondes en espanol salvo que el usuario use otro idioma.',
    'Usa Markdown simple cuando ayude: **negritas**, listas, y bloques de codigo con ``` para codigo.',
    'Se concisa por defecto; extiende solo cuando el usuario lo pida o el tema lo exija.',
    'No inventes datos; si no estas segura, dilo. Eres parte de LTH OS, un sistema operativo de apps creado por el equipo LTH.'
  ].join(' ');

  // Motor de imagen: el MISMO modelo/ruta que usa LTH IA en el OS (edge compartido).
  const MEDIA_REST_URL = SB_URL + '/rest/v1/ia_media';
  const FEEDBACK_REST_URL = SB_URL + '/rest/v1/ai_response_feedback';
  const IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
  const IMAGE_SYSTEM_PROMPT = 'Eres Mady, la asistente de LTH OS. Genera directamente la imagen que describe el usuario y acompanala con una frase breve en espanol. La imagen debe tratar EXACTAMENTE lo pedido; no agregues marcas, textos ni elementos no solicitados (nunca generes productos LTH si no se piden). Si el usuario pide texto dentro de la imagen, respetalo exactamente.';
  const PDF_SYSTEM_PROMPT = 'Eres Mady, la asistente de LTH OS. El usuario quiere un documento que se exportara a PDF. Redacta el documento COMPLETO en espanol, bien estructurado en Markdown simple: una primera linea con el titulo usando "# Titulo", luego secciones con "## Subtitulo", parrafos claros y listas con "- " cuando ayude. No uses tablas ni bloques de codigo ni HTML. Entrega solo el contenido del documento, sin preambulos como "aqui tienes" ni despedidas.';

  // Modo razonamiento premium: IA principal (clasifica + mejora prompt) -> especialista -> juez.
  const ORCHESTRATOR_PROMPT = [
    'Eres la IA PRINCIPAL del modo razonamiento de Mady (LTH OS). NO respondas la pregunta del usuario.',
    'Tu trabajo: entender la intencion, clasificarla y preparar instrucciones limpias para el modelo especialista.',
    'Categorias:',
    '- "imagen": crear, editar o generar una imagen (logos, fotos, ilustraciones, banners).',
    '- "codigo": programar, depurar, scripts o arquitectura de software.',
    '- "chat_max": requiere informacion ACTUAL de internet, fuentes, precios, noticias, lanzamientos, versiones nuevas, documentacion actual o verificacion externa.',
    '- "chat_simple": pregunta o charla que NO requiere internet ni verificacion externa (conocimiento general, explicaciones, redaccion).',
    '- "razonamiento": razonamiento tecnico profundo, estrategia, logica compleja o decisiones de arquitectura (sin necesidad de web ni de generar codigo extenso).',
    'Reglas:',
    '1) Si la peticion es ambigua y no puedes elegir bien la categoria o falta un dato clave, pide aclaracion con 1-3 preguntas concisas (need_clarification=true). PERO si ya hiciste preguntas antes en esta conversacion y el usuario ya respondio, NO vuelvas a preguntar: decide y procede.',
    '2) Si esta clara, reescribe la peticion en "improved_prompt": instrucciones limpias, completas y especificas para el especialista (objetivo, contexto relevante del chat, formato esperado y restricciones).',
    '3) Devuelve SOLO JSON valido, sin texto fuera del JSON.',
    'Formato exacto: { "need_clarification": false, "questions": "", "category": "chat_simple", "improved_prompt": "" }'
  ].join('\n');
  const JUDGE_PROMPT = [
    'Eres el JUEZ FINAL del modo razonamiento de Mady. Recibes la PETICION ORIGINAL del usuario, el PROMPT MEJORADO que se le dio al especialista y el BORRADOR que produjo (con sus fuentes si las hay).',
    'Tu trabajo:',
    '1) Juzga si el borrador cumple EXACTAMENTE el prompt mejorado y responde bien la peticion original.',
    '2) Si falta optimizar algo o algo no cumple, APLICA TU MISMO las correcciones DIRECTAMENTE sobre el borrador, de forma INCREMENTAL: corrige solo lo que falla (codigo, datos, estructura, fuentes); NO reconstruyas todo desde cero ni borres lo que ya esta bien.',
    '3) Entrega la RESPUESTA FINAL para el usuario, ordenada, clara y entendible (Markdown). Es la version corregida y pulida, lista para mostrar; NO menciones el borrador, el juez ni el proceso.',
    'Devuelve SOLO JSON valido:',
    '{ "veredicto": "APROBADO", "confianza": 90, "fuentes": [], "advertencia": "", "respuesta_final": "" }',
    'veredicto in {APROBADO, APROBADO_CON_CORRECCIONES, RECHAZADO}. confianza 0-100. fuentes = URLs reales usadas (si aplica). advertencia = que no se pudo verificar (si aplica). respuesta_final = la respuesta final en Markdown para el usuario.'
  ].join('\n');

  // Motor LTH OS (PC): se enruta por la cola remote_commands (accion ia-ask),
  // igual que LTH Remote. El Mady completo del PC responde.
  const REMOTE_CMD_URL = SB_URL + '/rest/v1/remote_commands';
  const ENGINE_KEY = 'lth_ia_web_engine_v1';
  const OSDEV_KEY = 'lth_ia_web_osdevice_v1';
  const REASON_KEY = 'lth_ia_web_reason_v1';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ───────────────────────── Estado ───────────────────────── */
  const state = {
    session: null,     // { access_token, refresh_token, expires_at, user }
    user: null,
    credits: null,
    modelLabel: 'LTH IA',
    convos: [],
    activeId: null,
    tombstones: [],
    busy: false,
    abort: null,
    authMode: 'login',
    engine: 'web',
    osConnected: null,   // null = comprobando, true = conectado, false = sin conexion
    presenceTimer: null,
    reasoning: false
  };

  /* ───────────────────────── Utils ───────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const el = {};
  const nowSec = () => Math.floor(Date.now() / 1000);
  const uid = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clampPct = (v) => Math.max(0, Math.min(100, Number(v || 0) || 0));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Markdown ligero y seguro (escapa primero, luego aplica formato).
  function renderMarkdown(src) {
    let text = String(src || '');
    const blocks = [];
    // Bloques de codigo ```...```
    text = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
      blocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
      return 'B' + (blocks.length - 1) + '';
    });
    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, (_m, c) => '<code>' + c + '</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    const lines = text.split('\n');
    let html = '';
    let list = null; // 'ul' | 'ol'
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
    let para = [];
    const flushPara = () => {
      if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const ph = line.match(/^B(\d+)$/);
      if (ph) { flushPara(); closeList(); html += blocks[Number(ph[1])] || ''; continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + ul[1] + '</li>'; continue; }
      if (ol) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + ol[1] + '</li>'; continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }
      closeList(); para.push(line);
    }
    flushPara(); closeList();
    return html || '<p></p>';
  }

  /* ───────────────────────── Sesion ───────────────────────── */
  function saveSession(s) {
    state.session = s;
    state.user = s && s.user ? s.user : state.user;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function clearSession() {
    state.session = null; state.user = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  function authBaseHeaders() {
    return { apikey: SB_KEY, 'Content-Type': 'application/json' };
  }

  async function authFetch(path, body) {
    const res = await fetch(AUTH_URL + path, {
      method: 'POST', headers: authBaseHeaders(), body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.msg || data.error_description || data.error || data.message || 'Error de autenticacion.';
      throw new Error(msg);
    }
    return data;
  }

  function normalizeSession(data) {
    if (!data || !data.access_token) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: Number(data.expires_at || 0) || (nowSec() + Number(data.expires_in || 3600)),
      user: data.user || null
    };
  }

  async function ensureToken() {
    const s = state.session;
    if (!s || !s.access_token) return null;
    if (Number(s.expires_at || 0) - nowSec() > 60) return s.access_token;
    if (!s.refresh_token) return null;
    try {
      const data = await authFetch('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      const next = normalizeSession(data);
      if (next) { if (!next.user) next.user = s.user; saveSession(next); return next.access_token; }
    } catch (_) {}
    return null;
  }

  /* ─────────────────── Edge function (IA) ─────────────────── */
  function ApiError(message, status, credits) {
    const e = new Error(message); e.status = status; e.credits = credits; return e;
  }

  async function callEdge(payload, signal) {
    const token = await ensureToken();
    if (!token) throw ApiError('Tu sesion expiro. Vuelve a entrar.', 401);
    return fetch(FN_URL, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
  }

  async function fetchStatus() {
    try {
      const res = await callEdge({ action: 'status' });
      const data = await res.json().catch(() => ({}));
      if (data && data.success) {
        state.credits = data.credits || null;
        if (data.modelLabel || data.model) state.modelLabel = data.modelLabel || data.model;
        renderCredits();
      }
    } catch (_) {}
  }

  // Envia el historial y procesa el stream SSE. onDelta(text), devuelve {text, credits}.
  // routeOpts opcional = modelo/params elegidos por el auto-router.
  async function streamChat(messages, onDelta, signal, routeOpts) {
    const payload = { action: 'stream', system: (routeOpts && routeOpts.system) || SYSTEM_PROMPT, messages };
    if (routeOpts && routeOpts.model) {
      payload.model = routeOpts.model;
      if (routeOpts.maxTokens) payload.maxTokens = routeOpts.maxTokens;
      if (routeOpts.temperature != null) payload.temperature = routeOpts.temperature;
      if (routeOpts.reasoning) payload.reasoning = routeOpts.reasoning;
    }
    const res = await callEdge(payload, signal);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw ApiError(data.error || 'No se pudo conectar con Mady.', data.status || res.status, data.credits);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let credits = null;
    let errored = null;

    const handle = (evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === 'content' && evt.text) { full += evt.text; onDelta(full); }
      else if (evt.type === 'complete') { if (typeof evt.text === 'string' && evt.text.length >= full.length) full = evt.text; if (evt.credits) credits = evt.credits; onDelta(full); }
      else if (evt.type === 'error') { errored = evt.error || 'Error en el stream.'; if (evt.credits) credits = evt.credits; }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i = buffer.indexOf('\n\n');
      while (i >= 0) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const dataStr = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n').trim();
        if (dataStr) { try { handle(JSON.parse(dataStr)); } catch (_) {} }
        i = buffer.indexOf('\n\n');
      }
    }
    if (errored) throw ApiError(errored, 500, credits);
    return { text: full, credits };
  }

  /* ─────────────────── Conversaciones ─────────────────── */
  function loadConvos() {
    try { const a = JSON.parse(localStorage.getItem(CONVO_KEY) || '[]'); state.convos = Array.isArray(a) ? a.filter((c) => c && c.id) : []; } catch (_) { state.convos = []; }
    try { const t = JSON.parse(localStorage.getItem(TOMB_KEY) || '[]'); state.tombstones = Array.isArray(t) ? t.map(String) : []; } catch (_) { state.tombstones = []; }
  }
  function saveConvos() { try { localStorage.setItem(CONVO_KEY, JSON.stringify(state.convos.slice(0, 40))); } catch (_) {} }
  function saveTombstones() { try { localStorage.setItem(TOMB_KEY, JSON.stringify(state.tombstones.slice(-300))); } catch (_) {} }
  function activeConvo() { return state.convos.find((c) => c.id === state.activeId) || null; }

  function newConvo() {
    state.activeId = null;
    renderMessages(); renderConvoList(); closeDrawer();
    el.input && el.input.focus();
  }

  function ensureActiveConvo(firstText) {
    let c = activeConvo();
    if (c) return c;
    c = { id: uid(), title: (firstText || 'Nuevo chat').slice(0, 48), messages: [], created: new Date().toISOString(), updated: Date.now() };
    state.convos.unshift(c);
    state.activeId = c.id;
    return c;
  }

  function deleteConvo(id) {
    id = String(id || '');
    if (!id) return;
    if (!state.tombstones.includes(id)) { state.tombstones.push(id); saveTombstones(); }
    state.convos = state.convos.filter((c) => c.id !== id);
    if (state.activeId === id) state.activeId = state.convos[0] ? state.convos[0].id : null;
    saveConvos(); renderConvoList(); renderMessages();
    // Propaga el borrado a la nube (best-effort).
    ensureToken().then((token) => {
      if (!token) return;
      fetch(REST_URL + '?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, Prefer: 'return=minimal' }
      }).catch(() => {});
    });
  }

  async function syncPull() {
    const token = await ensureToken();
    if (!token) return;
    try {
      const res = await fetch(REST_URL + '?select=id,title,messages,source,updated_at&order=updated_at.desc&limit=80', {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token }
      });
      if (!res.ok) return;
      const rows = await res.json().catch(() => []);
      if (!Array.isArray(rows) || !rows.length) return;
      let changed = false;
      for (const row of rows) {
        const id = String(row.id || ''); if (!id) continue;
        if (state.tombstones.includes(id)) continue;
        const remoteMsgs = (Array.isArray(row.messages) ? row.messages : [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
        let c = state.convos.find((x) => x.id === id);
        if (!c) {
          if (!remoteMsgs.length) continue;
          state.convos.push({
            id, title: String(row.title || '').trim() || 'Chat', updated: Date.parse(row.updated_at) || Date.now(),
            created: new Date(Number(remoteMsgs[0] && remoteMsgs[0].ts) || Date.now()).toISOString(),
            messages: remoteMsgs.map((m) => ({ id: m.id || uid(), role: m.role, content: String(m.content || ''), ts: Number(m.ts) || Date.now(), media: Array.isArray(m.media) ? m.media : undefined }))
          });
          changed = true; continue;
        }
        const known = new Set(c.messages.map((m) => m.role + '|' + (Number(m.ts) || 0) + '|' + String(m.content || '').slice(0, 60)));
        for (const m of remoteMsgs) {
          const key = m.role + '|' + (Number(m.ts) || 0) + '|' + String(m.content || '').slice(0, 60);
          if (known.has(key)) continue;
          c.messages.push({ id: m.id || uid(), role: m.role, content: String(m.content || ''), ts: Number(m.ts) || Date.now(), media: Array.isArray(m.media) ? m.media : undefined });
          known.add(key); changed = true;
        }
      }
      if (changed) {
        state.convos.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        saveConvos(); renderConvoList(); if (activeConvo()) renderMessages();
      }
    } catch (_) {}
  }

  async function syncPushOne(convo) {
    if (!convo) return;
    const token = await ensureToken();
    if (!token) return;
    const row = {
      id: convo.id,
      title: String(convo.title || '').slice(0, 160),
      messages: convo.messages.slice(-120).map((m) => {
        const r = { id: m.id, role: m.role, content: String(m.content || '').slice(0, 20000), ts: m.ts };
        if (Array.isArray(m.media) && m.media.length) r.media = m.media;
        return r;
      }),
      source: 'web',
      updated_at: new Date().toISOString()
    };
    try {
      await fetch(REST_URL + '?on_conflict=user_id,id', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([row])
      });
    } catch (_) {}
  }

  /* ───────────────────────── Render ───────────────────────── */
  function setStatusDot(mode) {
    if (!el.statusDot) return;
    el.statusDot.classList.remove('busy', 'off');
    if (mode === 'busy') el.statusDot.classList.add('busy');
    else if (mode === 'off') el.statusDot.classList.add('off');
  }

  function renderCredits() {
    const c = state.credits;
    el.modelLabel.textContent = state.modelLabel || 'LTH IA';
    if (!c) { el.planTag.textContent = '—'; el.usageVal.textContent = '—'; el.usageFill.style.width = '0%'; return; }
    const plan = String(c.plan || 'free');
    el.planTag.textContent = plan;

    // En el CHAT mostramos el uso de la VENTANA actual (corto plazo). Nunca se
    // muestran creditos ni tokens: solo porcentaje y barra.
    const inCooldown = c.cooldown_until && new Date(c.cooldown_until) > new Date();
    const windowPct = clampPct(c.window_usage_percent);
    if (inCooldown) {
      el.usageLabel.textContent = 'En pausa';
      el.usageVal.textContent = 'vuelve ' + fmtTime(c.cooldown_until);
      el.usageFill.style.width = '100%';
    } else {
      el.usageLabel.textContent = 'Uso actual';
      el.usageVal.textContent = Math.round(windowPct) + '%';
      el.usageFill.style.width = windowPct + '%';
    }
    const alertPct = inCooldown ? 100 : windowPct;
    el.usageFill.classList.toggle('warn', alertPct >= 70 && alertPct < 95);
    el.usageFill.classList.toggle('danger', alertPct >= 95);

    // Panel detallado (settings): semana (principal) + mes + ventana. Solo %.
    el.cpPlan.textContent = plan.toUpperCase() + (c.plan_active ? '' : ' · inactivo');
    const setBar = (barEl, txtEl, pct) => {
      const p = clampPct(pct);
      barEl.style.width = p + '%';
      txtEl.textContent = Math.round(p) + '%';
    };
    setBar(el.cpWeek, el.cpWeekTxt, c.weekly_usage_percent);
    setBar(el.cpMonth, el.cpMonthTxt, c.monthly_usage_percent);
    setBar(el.cpWindow, el.cpWindowTxt, c.window_usage_percent);
    let note = '';
    if (inCooldown) note = 'Llegaste al limite de la ventana actual. Se reactiva ' + fmtTime(c.cooldown_until) + '.';
    else if (plan === 'free') note = 'Plan free: chat de texto. Pasa a Pro para mas modelos e imagenes.';
    el.cpNote.textContent = note;
  }

  function fmtTime(v) {
    try { return new Date(v).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  }

  function renderConvoList() {
    if (!el.convoList) return;
    if (!state.convos.length) { el.convoList.innerHTML = '<div style="padding:18px;color:var(--text-dim);font-size:12px;text-align:center;">Sin conversaciones todavia.</div>'; return; }
    el.convoList.innerHTML = '';
    for (const c of state.convos) {
      const last = c.messages[c.messages.length - 1];
      const sub = last ? String(last.content).replace(/\s+/g, ' ').slice(0, 30) : 'vacio';
      const item = document.createElement('div');
      item.className = 'convo-item' + (c.id === state.activeId ? ' on' : '');
      item.innerHTML = '<div class="ci-title">' + escapeHtml(c.title || 'Chat') + '</div>' +
        '<div class="ci-sub"><span>' + escapeHtml(sub) + '</span><span class="ci-del" data-del="1">borrar</span></div>';
      item.addEventListener('click', (e) => {
        if (e.target && e.target.getAttribute('data-del')) { e.stopPropagation(); deleteConvo(c.id); return; }
        state.activeId = c.id; renderConvoList(); renderMessages(); closeDrawer();
      });
      el.convoList.appendChild(item);
    }
  }

  function bubbleEl(role, html, extraClass) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
    const av = document.createElement('div'); av.className = 'av'; av.textContent = role === 'user' ? 'TU' : 'M';
    const bub = document.createElement('div'); bub.className = 'bubble' + (extraClass ? ' ' + extraClass : '');
    bub.innerHTML = html;
    wrap.appendChild(av); wrap.appendChild(bub);
    return { wrap, bub };
  }

  function renderMessages() {
    const c = activeConvo();
    el.messages.innerHTML = '';
    if (!c || !c.messages.length) { el.messages.appendChild(el.welcome); el.welcome.hidden = false; return; }
    for (const m of c.messages) {
      const html = m.role === 'user' ? escapeHtml(m.content).replace(/\n/g, '<br>') : renderMarkdown(m.content);
      const node = bubbleEl(m.role, html);
      if (Array.isArray(m.media) && m.media.length) appendMedia(node.bub, m.media);
      if (m.role === 'assistant' && m.verdict) appendVerdict(node.bub, m.verdict);
      if (m.role === 'assistant' && String(m.content || '').trim()) appendFeedback(node.bub, m, c);
      el.messages.appendChild(node.wrap);
    }
    scrollDown();
  }

  function scrollDown() { requestAnimationFrame(() => { el.messages.scrollTop = el.messages.scrollHeight; }); }

  function showError(text) {
    const d = document.createElement('div');
    d.className = 'msg-err';
    d.innerHTML = '<b>⚠ ' + escapeHtml(text) + '</b>';
    el.messages.appendChild(d); scrollDown();
  }

  /* ───────────────────────── Enviar ───────────────────────── */
  async function send(text) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    if (el.welcome) el.welcome.hidden = true;

    const convo = ensureActiveConvo(text);
    convo.messages.push({ id: uid(), role: 'user', content: text, ts: Date.now() });
    convo.updated = Date.now();
    if (convo.messages.length === 1) convo.title = text.slice(0, 48);
    saveConvos();
    if (!activeConvo() || el.messages.querySelector('.welcome')) renderMessages();
    else el.messages.appendChild(bubbleEl('user', escapeHtml(text).replace(/\n/g, '<br>')).wrap);
    renderConvoList();
    el.input.value = ''; autoGrow();
    scrollDown();

    // Mismo criterio que el OS: detecta imagen o PDF.
    const wantImage = looksLikeImageRequest(text);
    const wantPdf = !wantImage && looksLikePdfRequest(text);
    if ((wantImage || wantPdf) && !canUsePremium()) {
      const what = wantImage ? 'La generacion de imagenes' : 'La generacion de PDF';
      const note = what + ' es del plan **Pro**. Con tu plan actual puedo ayudarte con texto; mejora a Pro para desbloquearlo.';
      convo.messages.push({ id: uid(), role: 'assistant', content: note, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo);
      return;
    }

    // Burbuja de respuesta segun el tipo.
    const { wrap, bub } = bubbleEl('ai',
      wantImage ? '<span class="gen-img-loading">🎨 Generando imagen<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
        : wantPdf ? '<span class="gen-img-loading">📄 Preparando PDF<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
          : state.engine === 'os' ? '<span class="gen-img-loading">🧠 Motor LTH OS pensando<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
            : '<span class="typing"><i></i><i></i><i></i></span>');
    el.messages.appendChild(wrap); scrollDown();

    setBusy(true);
    state.abort = new AbortController();

    try {
      if (wantImage) {
        await generateImage(text, convo, wrap, bub);
        return;
      }
      if (wantPdf) {
        await generatePdf(text, convo, wrap, bub);
        return;
      }
      // Si el usuario activo el Motor LTH OS, la pregunta pasa primero por el PC.
      if (state.engine === 'os') {
        const ok = await askPcEngine(text, convo, bub);
        if (ok) return;
        bub.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      }

      // Modo razonamiento: skill -> resolver -> verificar (solo planes de pago).
      if (state.reasoning && canUsePremium()) {
        await reasoningAnswer(text, convo, bub);
        return;
      }

      const history = convo.messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));

      // Pensar en automatico como Mady: clasifica la intencion y elige el modelo.
      const route = await autoRoute(text, history);
      if (route && route.action === 'block') {
        const msg = 'No puedo ayudar con esa solicitud.';
        bub.innerHTML = renderMarkdown(msg);
        convo.messages.push({ id: uid(), role: 'assistant', content: msg, ts: Date.now() });
        convo.updated = Date.now(); saveConvos(); renderConvoList(); syncPushOne(convo);
        return;
      }
      if (route && route.tier === 'image') {
        await generateImage(text, convo, wrap, bub);
        return;
      }
      const routeOpts = route ? { model: route.model, maxTokens: route.maxTokens, temperature: route.temperature, reasoning: route.reasoning } : null;
      if (route && route.tier) bub.innerHTML = engineThinkingHtml(route.tier);

      let started = false;
      const result = await streamChat(history, (full) => {
        if (!started) { started = true; bub.classList.add('cursor'); }
        bub.innerHTML = renderMarkdown(full);
        bub.classList.add('cursor');
        scrollDown();
      }, state.abort.signal, routeOpts);

      bub.classList.remove('cursor');
      const finalText = result.text || '';
      bub.innerHTML = renderMarkdown(finalText || '_(sin respuesta)_');
      convo.messages.push({ id: uid(), role: 'assistant', content: finalText, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderConvoList();
      syncPushOne(convo);
      fetchStatus();
    } catch (err) {
      bub.classList.remove('cursor');
      wrap.remove();
      if (err && err.name === 'AbortError') {
        // Detenido por el usuario: guarda lo que se alcanzo a escribir.
        const partial = bub.textContent || '';
        if (partial.trim()) convo.messages.push({ id: uid(), role: 'assistant', content: partial, ts: Date.now() });
      } else {
        const msg = (err && err.message) || 'No se pudo conectar con Mady.';
        showError(msg);
        if (err && err.credits) { state.credits = mergeCredits(state.credits, err.credits); renderCredits(); }
        else fetchStatus();
      }
      saveConvos();
    } finally {
      setBusy(false);
      state.abort = null;
    }
  }

  /* ─────────────────── Imagenes (motor compartido) ─────────────────── */
  const mediaCache = {};

  function looksLikeImageRequest(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(no (generes|crees|hagas)|sin)\b[^.]{0,24}\b(imagen|foto|logo)\b/.test(t)) return false;
    return /\b(gener[ao]|crea(me|la)?|haz(me|la)?|dibuj[ao]|dise[nñ]a|ilustra|render(iza)?|imagina|pinta)\b[^.]{0,44}\b(imagen|imagenes|foto|fotos|ilustracion|dibujo|logo|logotipo|banner|portada|wallpaper|fondo|render|poster|afiche|icono|avatar|arte|grafico)\b/.test(t)
      || /\b(imagen|ilustracion|dibujo|logo|banner|portada|wallpaper|render|poster|afiche)\b\s+(de|del|para|con|sobre)\b/.test(t)
      || /^\s*(imagen|foto|dibujo|logo)\s*[:\-]/.test(t);
  }

  function canUsePremium() {
    const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
    return ['pro', 'studio', 'ultra'].includes(plan) && (state.credits ? state.credits.plan_active !== false : true);
  }

  function looksLikePdfRequest(text) {
    const t = String(text || '').toLowerCase();
    if (/\bno\b[^.]{0,20}\bpdf\b/.test(t)) return false;
    return /\bpdf\b/.test(t)
      || /\b(gener[ao]|crea(me)?|haz(me)?|arma(me)?|prepara(me)?|redacta(me)?|elabora|escribe(me)?|dame)\b[^.]{0,46}\b(documento|reporte|informe|guia|manual|ensayo|carta|contrato|propuesta|articulo|resumen escrito|dossier)\b/.test(t);
  }

  function parseImageMime(url) {
    const m = String(url || '').match(/^data:([^;]+);base64,/i);
    return m ? m[1] : 'image/png';
  }

  // Guarda el medio en la BD (tabla ia_media, se borra solo a las 24h). Devuelve {id, expires_at}.
  async function storeMedia({ convoId, kind, mime, title, prompt, src }) {
    const token = await ensureToken();
    if (!token) return null;
    const value = String(src || '');
    if (!value || value.length > 7500000) return null; // tope ~7.5MB por fila
    try {
      const res = await fetch(MEDIA_REST_URL + '?select=id,expires_at', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify([{ conversation_id: convoId || null, kind, mime: mime || 'image/png', title: (title || '').slice(0, 160), prompt: (prompt || '').slice(0, 2000), data_base64: value, bytes: value.length }])
      });
      if (!res.ok) return null;
      const rows = await res.json().catch(() => []);
      return rows && rows[0] ? rows[0] : null;
    } catch (_) { return null; }
  }

  async function loadMediaImage(imgEl, capEl, mediaId) {
    if (mediaCache[mediaId]) { imgEl.src = mediaCache[mediaId]; return; }
    const token = await ensureToken();
    if (!token) return;
    try {
      const res = await fetch(MEDIA_REST_URL + '?select=data_base64,expires_at&id=eq.' + encodeURIComponent(mediaId), {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token }
      });
      const rows = await res.json().catch(() => []);
      if (rows && rows[0] && rows[0].data_base64) {
        mediaCache[mediaId] = rows[0].data_base64;
        imgEl.src = rows[0].data_base64;
      } else {
        imgEl.remove();
        if (capEl) capEl.textContent = '🗑️ Imagen expirada (se borran a las 24 h)';
      }
    } catch (_) {}
  }

  async function generateImage(prompt, convo, wrap, bub) {
    const res = await callEdge({
      action: 'chat',
      model: IMAGE_MODEL,
      routerMode: 'image',
      routerHint: 'image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '1:1', image_size: '1K' },
      maxTokens: 1200,
      temperature: 0.5,
      system: IMAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    }, state.abort && state.abort.signal);

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(data.error || 'No se pudo generar la imagen.', data.status || res.status, data.credits);
    }

    const urls = (Array.isArray(data.imageUrls) ? data.imageUrls : []).filter(Boolean);
    const caption = String(data.text || '').trim();

    if (!urls.length) {
      const txt = caption || 'No pude generar la imagen esta vez. Intenta describirla con mas detalle.';
      convo.messages.push({ id: uid(), role: 'assistant', content: txt, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      return;
    }

    const media = [];
    for (const url of urls) {
      const mime = parseImageMime(url);
      const stored = await storeMedia({ convoId: convo.id, kind: 'image', mime, title: prompt, prompt, src: url });
      const id = stored && stored.id ? stored.id : ('local_' + uid());
      mediaCache[id] = url;
      media.push({ id: id, kind: 'image', mime: mime });
    }

    convo.messages.push({ id: uid(), role: 'assistant', content: caption || 'Aqui tienes tu imagen.', media: media, ts: Date.now() });
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
  }

  function appendMedia(bub, media) {
    for (const item of media) {
      if (!item || !item.id) continue;
      if (item.kind === 'image') appendImageMedia(bub, item);
      else if (item.kind === 'pdf') appendPdfMedia(bub, item);
    }
  }

  function appendImageMedia(bub, item) {
    const fig = document.createElement('figure');
    fig.className = 'gen-media';
    const img = document.createElement('img');
    img.className = 'gen-img';
    img.alt = 'Imagen generada por Mady';
    img.loading = 'lazy';
    img.addEventListener('click', () => { if (img.src) window.open(img.src, '_blank'); });
    const cap = document.createElement('figcaption');
    cap.className = 'media-note';
    cap.textContent = '🕒 Se guarda 24 h · toca para ampliar';
    fig.appendChild(img); fig.appendChild(cap);
    bub.appendChild(fig);
    loadMediaImage(img, cap, item.id);
  }

  function appendPdfMedia(bub, item) {
    const card = document.createElement('div');
    card.className = 'gen-pdf';
    const ic = document.createElement('div'); ic.className = 'pdf-ic'; ic.textContent = 'PDF';
    const meta = document.createElement('div'); meta.className = 'pdf-meta';
    const name = document.createElement('strong'); name.textContent = item.title || 'Documento';
    const note = document.createElement('span'); note.className = 'media-note'; note.textContent = '🕒 Se guarda 24 h';
    meta.appendChild(name); meta.appendChild(note);
    const actions = document.createElement('div'); actions.className = 'pdf-actions';
    const view = document.createElement('button'); view.type = 'button'; view.className = 'pdf-btn'; view.textContent = 'Ver';
    const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'pdf-btn ghost'; dl.textContent = 'Descargar';
    view.addEventListener('click', async () => {
      const data = await fetchMediaData(item.id);
      if (!data) { note.textContent = '🗑️ PDF expirado (se borran a las 24 h)'; return; }
      openData(data);
    });
    dl.addEventListener('click', async () => {
      const data = await fetchMediaData(item.id);
      if (!data) { note.textContent = '🗑️ PDF expirado (se borran a las 24 h)'; return; }
      downloadData(data, (item.title || 'documento').slice(0, 60) + '.pdf');
    });
    actions.appendChild(view); actions.appendChild(dl);
    card.appendChild(ic); card.appendChild(meta); card.appendChild(actions);
    bub.appendChild(card);
  }

  function appendFeedback(bub, message, convo) {
    const row = document.createElement('div');
    row.className = 'msg-feedback';
    const up = document.createElement('button');
    up.type = 'button'; up.className = 'fb-btn up'; up.setAttribute('aria-label', 'Buena respuesta'); up.title = 'Me gusta';
    up.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 10h3.2v11H2zM22 11a2 2 0 0 0-2-2h-5.1l.9-4.3a1.6 1.6 0 0 0-1.6-1.9c-.45 0-.87.2-1.16.55L8 9.4V21h10a2 2 0 0 0 1.95-1.55l1.95-7A2 2 0 0 0 22 11z"/></svg>';
    const down = document.createElement('button');
    down.type = 'button'; down.className = 'fb-btn down'; down.setAttribute('aria-label', 'Mala respuesta'); down.title = 'No me gusta';
    down.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 14h-3.2V3H22zM2 13a2 2 0 0 1 2 2h5.1l-.9 4.3a1.6 1.6 0 0 0 1.6 1.9c.45 0 .87-.2 1.16-.55L16 14.6V3H6a2 2 0 0 0-1.95 1.55l-1.95 7A2 2 0 0 0 2 13z"/></svg>';
    if (message._feedback === 'up') up.classList.add('on');
    if (message._feedback === 'down') down.classList.add('on');
    up.addEventListener('click', () => submitFeedback(message, convo, 'up', up, down));
    down.addEventListener('click', () => submitFeedback(message, convo, 'down', up, down));
    row.appendChild(up); row.appendChild(down);
    bub.appendChild(row);
  }

  async function submitFeedback(message, convo, rating, upBtn, downBtn) {
    message._feedback = rating;
    upBtn.classList.toggle('on', rating === 'up');
    downBtn.classList.toggle('on', rating === 'down');
    saveConvos();
    const token = await ensureToken();
    const userId = state.session && state.session.user && state.session.user.id;
    if (!token || !userId) return;
    let userMsgId = '';
    const idx = convo.messages.indexOf(message);
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (convo.messages[i] && convo.messages[i].role === 'user') { userMsgId = String(convo.messages[i].id || ''); break; }
    }
    try {
      await fetch(FEEDBACK_REST_URL + '?on_conflict=user_id,conversation_id,assistant_message_id', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: userId,
          conversation_id: String(convo.id || 'web').slice(0, 120),
          conversation_title: String(convo.title || '').slice(0, 180),
          user_message_id: userMsgId.slice(0, 120),
          assistant_message_id: String(message.id || '').slice(0, 120),
          assistant_response: String(message.content || '').slice(0, 30000),
          rating: rating,
          source_app: 'lth-ia-web',
          updated_at: new Date().toISOString()
        }])
      });
    } catch (_) {}
  }

  async function fetchMediaData(mediaId) {
    if (mediaCache[mediaId]) return mediaCache[mediaId];
    const token = await ensureToken();
    if (!token) return null;
    try {
      const res = await fetch(MEDIA_REST_URL + '?select=data_base64&id=eq.' + encodeURIComponent(mediaId), {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token }
      });
      const rows = await res.json().catch(() => []);
      if (rows && rows[0] && rows[0].data_base64) { mediaCache[mediaId] = rows[0].data_base64; return rows[0].data_base64; }
    } catch (_) {}
    return null;
  }

  function dataUriToBlob(uri) {
    const s = String(uri || '');
    const comma = s.indexOf(',');
    const meta = s.slice(0, comma);
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const bin = atob(s.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function openData(uri) {
    try { const url = URL.createObjectURL(dataUriToBlob(uri)); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    catch (_) { window.open(uri, '_blank'); }
  }

  function downloadData(uri, filename) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(dataUriToBlob(uri));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (_) {
      const a = document.createElement('a'); a.href = uri; a.download = filename; a.click();
    }
  }

  function ensurePdfSpace(doc, y, need) {
    const pageH = doc.internal.pageSize.getHeight();
    if (y + need > pageH - 48) { doc.addPage(); return 56; }
    return y;
  }

  function buildPdfFromText(title, md) {
    const ctor = window.jspdf && window.jspdf.jsPDF;
    if (!ctor) throw new Error('No se pudo cargar el generador de PDF.');
    const doc = new ctor({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    const maxW = pageW - margin * 2;

    doc.setFillColor(6, 16, 28); doc.rect(0, 0, pageW, 70, 'F');
    doc.setTextColor(120, 180, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('LTH IA · Mady', margin, 34);
    doc.setTextColor(150, 175, 205); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(new Date().toLocaleString('es'), margin, 52);

    let y = 100;
    doc.setTextColor(18, 26, 38); doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
    for (const ln of doc.splitTextToSize(String(title || 'Documento'), maxW)) { y = ensurePdfSpace(doc, y, 24); doc.text(ln, margin, y); y += 24; }
    y += 6;

    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { y += 8; continue; }
      let text = line, size = 11, bold = false, indent = 0;
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const num = line.match(/^\s*(\d+[.)])\s+(.*)$/);
      if (h) { size = h[1].length === 1 ? 14 : (h[1].length === 2 ? 12.5 : 11.5); bold = true; text = h[2]; y += 6; }
      else if (bullet) { text = '•  ' + bullet[1]; indent = 14; }
      else if (num) { text = num[1] + '  ' + num[2]; indent = 14; }
      text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(28, 36, 48);
      const lh = size + 5;
      for (const w of doc.splitTextToSize(text, maxW - indent)) { y = ensurePdfSpace(doc, y, lh); doc.text(w, margin + indent, y); y += lh; }
      if (h) y += 3;
    }
    return doc.output('datauristring');
  }

  function derivePdfTitle(userText, docText) {
    const firstHeading = String(docText || '').match(/^#\s+(.+)$/m);
    if (firstHeading) return firstHeading[1].trim().slice(0, 90);
    const t = String(userText || '').replace(/\b(genera|crea|hazme|haz|arma|prepara|redacta|elabora|escribe|dame|un|una|el|la|de|pdf|documento|en|formato|sobre)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return (t || 'Documento').slice(0, 80);
  }

  async function generatePdf(prompt, convo, wrap, bub) {
    const history = convo.messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
    const res = await callEdge({ action: 'chat', feature: 'pdf', maxTokens: 4000, system: PDF_SYSTEM_PROMPT, messages: history }, state.abort && state.abort.signal);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(data.error || 'No se pudo generar el documento.', data.status || res.status, data.credits);
    }
    const docText = String(data.text || '').trim();
    if (!docText) {
      convo.messages.push({ id: uid(), role: 'assistant', content: 'No pude generar el documento esta vez. Dame mas detalle de lo que quieres en el PDF.', ts: Date.now() });
      convo.updated = Date.now(); saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      return;
    }
    const title = derivePdfTitle(prompt, docText);
    let dataUri;
    try { dataUri = buildPdfFromText(title, docText); }
    catch (_) {
      // Si el generador de PDF fallara, al menos entrega el texto.
      convo.messages.push({ id: uid(), role: 'assistant', content: docText, ts: Date.now() });
      convo.updated = Date.now(); saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      return;
    }
    const stored = await storeMedia({ convoId: convo.id, kind: 'pdf', mime: 'application/pdf', title, prompt, src: dataUri });
    const id = stored && stored.id ? stored.id : ('local_' + uid());
    mediaCache[id] = dataUri;
    convo.messages.push({ id: uid(), role: 'assistant', content: 'Aqui tienes tu PDF: **' + title + '**.', media: [{ id: id, kind: 'pdf', mime: 'application/pdf', title: title }], ts: Date.now() });
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
  }

  /* ─────────────────── Motor LTH OS (PC) ─────────────────── */
  function osDeviceId() {
    let id = '';
    try { id = localStorage.getItem(OSDEV_KEY) || ''; } catch (_) {}
    if (!id) { id = 'web_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); try { localStorage.setItem(OSDEV_KEY, id); } catch (_) {} }
    return id;
  }

  // Inserta un comando en remote_commands y hace polling del resultado. Si el PC
  // no recoge el comando en ~8s (sigue 'pending'), lo damos por desconectado.
  async function sendOsCommand(action, params, waitMs = 30000) {
    const token = await ensureToken();
    const userId = state.session && state.session.user && state.session.user.id;
    if (!token || !userId) return null;
    const headers = { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    let id = null;
    try {
      const res = await fetch(REMOTE_CMD_URL + '?select=id', {
        method: 'POST',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify([{ user_id: userId, device_id: osDeviceId(), action, params: params || {} }])
      });
      if (!res.ok) return null;
      const rows = await res.json().catch(() => []);
      id = rows && rows[0] && rows[0].id;
    } catch (_) { return null; }
    if (!id) return null;

    const started = Date.now();
    let sawRunning = false;
    while (Date.now() - started < waitMs) {
      await sleep(800);
      try {
        const pr = await fetch(REMOTE_CMD_URL + '?select=status,result,error&id=eq.' + encodeURIComponent(id), { headers });
        const prows = await pr.json().catch(() => []);
        const row = prows && prows[0];
        if (row) {
          if (row.status === 'running') sawRunning = true;
          if (row.status === 'done' || row.status === 'error' || row.status === 'denied') return row;
          if (!sawRunning && Date.now() - started > 8000) return null; // el PC no lo recogio
        }
      } catch (_) {}
    }
    return null;
  }

  async function probeOsEngine() {
    const row = await sendOsCommand('diagnostic-ping', { from: 'web' }, 9000);
    if (!row || row.status !== 'done') return { ok: false };
    const r = row.result || {};
    // engineReady=false => LTH OS sigue vivo en segundo plano pero con su ventana
    // cerrada/oculta: lo tratamos como desconectado (es lo que el usuario espera).
    const ready = r.engineReady !== false;
    return { ok: ready, engineReady: ready, allowControl: r.allowControl === true, sessionLocked: r.sessionLocked === true, pinConfigured: r.pinConfigured === true };
  }

  // Enruta la pregunta al motor completo de Mady en el PC. Devuelve true si respondio.
  async function askPcEngine(text, convo, bub) {
    try {
      bub.innerHTML = '<span class="gen-img-loading">🧠 Motor LTH OS pensando<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>';
      const row = await sendOsCommand('ia-ask', { convoId: convo.id, text }, 165000);
      if (!row || row.status !== 'done') {
        // Emparejamiento perdido (PC reiniciado): vuelve al motor web y pide re-vincular.
        if (row && row.status === 'denied') { state.engine = 'web'; persistEngine(); stopEnginePresence(); }
        state.osConnected = false; renderEngineBadge();
        return false;
      }
      const answer = String((row.result || {}).text || '').trim();
      if (!answer) { state.osConnected = false; renderEngineBadge(); return false; }
      bub.classList.remove('cursor');
      bub.innerHTML = renderMarkdown(answer);
      convo.messages.push({ id: uid(), role: 'assistant', content: answer, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderConvoList(); syncPushOne(convo); fetchStatus();
      state.osConnected = true; renderEngineBadge();
      return true;
    } catch (_) { state.osConnected = false; renderEngineBadge(); return false; }
  }

  function renderEngineBadge() {
    const b = el.engineBadge;
    if (!b) return;
    if (state.engine !== 'os') { b.hidden = true; return; }
    b.hidden = false;
    if (state.osConnected === true) { b.className = 'engine-badge on'; b.textContent = '● LTH OS'; }
    else if (state.osConnected === false) { b.className = 'engine-badge off'; b.textContent = '● LTH OS sin conexión'; }
    else { b.className = 'engine-badge'; b.textContent = '● LTH OS…'; } // comprobando conexion
  }

  function stopEnginePresence() {
    try { clearInterval(state.presenceTimer); } catch (_) {}
    state.presenceTimer = null;
  }

  function startEnginePresence() {
    stopEnginePresence();
    if (state.engine !== 'os') return;
    const tick = async () => {
      if (state.engine !== 'os') { stopEnginePresence(); return; }
      if (state.busy) return; // no interferir mientras Mady responde
      const probe = await probeOsEngine();
      state.osConnected = Boolean(probe.ok);
      renderEngineBadge();
    };
    state.presenceTimer = setInterval(tick, 40000);
    void tick();
  }

  /* ─────────── Auto-router (pensar en automatico como Mady del OS) ─────────── */
  async function autoRoute(text, history) {
    const R = window.LTHRouter;
    const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
    // Solo planes de pago: el free tiene un unico modelo, no hay que enrutar.
    if (!R || !['pro', 'studio', 'ultra'].includes(plan)) return null;
    try {
      const input = R.buildClassifierInput({ userMessage: text, history: (history || []).slice(-4), userPlan: plan, manualMode: 'auto' });
      const res = await callEdge({
        action: 'chat',
        model: R.MODEL_CONFIG.router.model,
        maxTokens: R.MODEL_CONFIG.router.maxTokens,
        temperature: 0,
        response_format: R.MODEL_CONFIG.router.responseFormat,
        system: R.getClassifierPrompt(),
        messages: [{ role: 'user', content: input }]
      }, state.abort && state.abort.signal);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) return null;
      let raw = {};
      try { const m = String(data.text || '').match(/\{[\s\S]*\}/); raw = m ? JSON.parse(m[0]) : {}; } catch (_) { raw = {}; }
      const decision = R.validateDecision(raw, { manualMode: 'auto' });
      return R.chooseModel(decision, { userPlan: plan, manualMode: 'auto' });
    } catch (_) { return null; }
  }

  function engineThinkingHtml(tier) {
    const map = { code: '💻 Programando', premium: '🧠 Razonando', web: '🌐 Buscando en la web', files: '📎 Analizando', standard: '✦ Pensando', cheap: '✦ Escribiendo' };
    return '<span class="gen-img-loading">' + (map[tier] || '✦ Pensando') + '<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>';
  }

  /* ─────────── Modo razonamiento (skill -> resolver -> verificar) ─────────── */
  function persistReason() { try { localStorage.setItem(REASON_KEY, state.reasoning ? '1' : '0'); } catch (_) {} }
  function renderReasonBtn() {
    if (!el.reasonBtn) return;
    el.reasonBtn.classList.toggle('on', !!state.reasoning);
    el.reasonBtn.setAttribute('aria-pressed', state.reasoning ? 'true' : 'false');
  }

  function reasonStageHtml(stage) {
    const map = {
      orchestrate: 'Entendiendo tu pedido',
      codigo: 'Programando la solución',
      chat_max: 'Investigando en la web',
      chat_simple: 'Pensando la respuesta',
      razonamiento: 'Razonando a fondo',
      judge: 'Verificando y puliendo'
    };
    return '<span class="reason-live"><span class="reason-orb"></span><span class="reason-label">' + escapeHtml(map[stage] || 'Razonando') + '</span><span class="reason-dots"><i></i><i></i><i></i></span></span>';
  }

  function parseReasonJson(raw) {
    try { return JSON.parse(raw); } catch (_) {}
    try { const m = String(raw || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; } catch (_) { return {}; }
  }

  function categorySpecialist(category, improved) {
    const brief = '\n\nInstrucciones del orquestador (síguelas al pie de la letra):\n' + improved;
    if (category === 'codigo') {
      return { model: 'deepseek/deepseek-v4-pro', stage: 'codigo', temperature: 0.2, system: 'Eres un ingeniero de software senior. Entrega codigo correcto, integrado y ejecutable; prioriza la correctitud y la integracion real; explica lo esencial brevemente.' + brief };
    }
    if (category === 'chat_max') {
      return { model: 'anthropic/claude-sonnet-4.6:online', stage: 'chat_max', temperature: 0.2, system: 'Eres Mady en modo investigacion con busqueda web. Usa SOLO datos reales y actuales de la web; NO inventes. CITA las fuentes (URLs) que uses. Separa hechos confirmados de inferencias y marca explicitamente lo que no se pudo verificar.' + brief };
    }
    if (category === 'razonamiento') {
      return { model: 'anthropic/claude-opus-4.7', stage: 'razonamiento', temperature: 0.3, system: 'Eres Mady en razonamiento tecnico profundo. Razona con rigor, considera alternativas y justifica cada decision.' + brief };
    }
    return { model: 'openai/gpt-5.5', stage: 'chat_simple', temperature: 0.4, system: SYSTEM_PROMPT + brief };
  }

  function extractVerdict(j) {
    const v = String(j.veredicto || '').toUpperCase();
    const conf = (j.confianza != null && isFinite(Number(j.confianza))) ? Math.max(0, Math.min(100, Math.round(Number(j.confianza)))) : null;
    const fuentes = Array.isArray(j.fuentes) ? j.fuentes.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : [];
    const advertencia = j.advertencia ? String(j.advertencia).trim() : '';
    if (!v && conf == null && !fuentes.length && !advertencia) return null;
    return { veredicto: v, confianza: conf, fuentes: fuentes, advertencia: advertencia };
  }

  function appendVerdict(bub, v) {
    if (!v) return;
    const tone = v.veredicto === 'APROBADO' ? 'ok' : v.veredicto === 'RECHAZADO' ? 'bad' : 'warn';
    const label = v.veredicto === 'APROBADO' ? 'Aprobado'
      : v.veredicto === 'APROBADO_CON_CORRECCIONES' ? 'Aprobado con correcciones'
        : v.veredicto === 'RECHAZADO' ? 'Rechazado' : 'Revisado';
    const card = document.createElement('div');
    card.className = 'verdict-card v-' + tone;
    let html = '<div class="vc-head"><span class="vc-badge">' + escapeHtml(label) + '</span>';
    if (v.confianza != null) html += '<span class="vc-conf">Confianza ' + v.confianza + '%</span>';
    html += '</div>';
    if (v.confianza != null) html += '<div class="vc-bar"><i style="width:' + v.confianza + '%"></i></div>';
    if (v.advertencia) html += '<div class="vc-warn">Sin verificar: ' + escapeHtml(v.advertencia) + '</div>';
    if (v.fuentes && v.fuentes.length) {
      html += '<div class="vc-sources"><span class="vc-srctitle">Fuentes</span>';
      html += v.fuentes.map((s) => {
        const isUrl = /^https?:\/\//i.test(s);
        const label2 = isUrl ? s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : s.slice(0, 40);
        return isUrl
          ? '<a href="' + escapeHtml(s) + '" target="_blank" rel="noopener" class="vc-src">' + escapeHtml(label2) + '</a>'
          : '<span class="vc-src">' + escapeHtml(label2) + '</span>';
      }).join('');
      html += '</div>';
    }
    card.innerHTML = html;
    bub.appendChild(card);
  }

  // Pipeline premium: IA principal (clasifica + mejora prompt) -> especialista -> juez GLM-5.2.
  async function reasoningAnswer(text, convo, bub) {
    const signal = state.abort && state.abort.signal;
    const history = convo.messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));

    // 1) IA principal: entiende, clasifica y mejora el prompt (o pide aclaracion).
    bub.innerHTML = reasonStageHtml('orchestrate');
    const orchRaw = await reasonChat({ model: 'google/gemini-2.5-flash', system: ORCHESTRATOR_PROMPT, messages: history, maxTokens: 1400, temperature: 0.2 }, signal);
    const orch = parseReasonJson(orchRaw);
    if (orch.need_clarification && String(orch.questions || '').trim()) {
      const q = String(orch.questions).trim();
      bub.innerHTML = renderMarkdown(q);
      convo.messages.push({ id: uid(), role: 'assistant', content: q, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderConvoList(); syncPushOne(convo);
      return;
    }
    const category = String(orch.category || 'chat_simple').toLowerCase();
    const improved = String(orch.improved_prompt || text).trim();

    // 2) imagen: flujo de imagen, sin juez (resultado visual).
    if (category === 'imagen') {
      await generateImage(improved, convo, null, bub);
      return;
    }

    // 2) Especialista de la categoria produce el borrador.
    const spec = categorySpecialist(category, improved);
    bub.innerHTML = reasonStageHtml(spec.stage);
    const draft = await reasonChat({ model: spec.model, system: spec.system, messages: history, maxTokens: 9000, temperature: spec.temperature }, signal);

    // 3) Juez GLM-5.2: revisa, parchea incremental y presenta la respuesta final.
    bub.innerHTML = reasonStageHtml('judge');
    const judgeRaw = await reasonChat({
      model: 'z-ai/glm-5.2',
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: 'PETICION ORIGINAL:\n' + text + '\n\nPROMPT MEJORADO:\n' + improved + '\n\nBORRADOR DEL ESPECIALISTA:\n' + draft }],
      maxTokens: 9000,
      temperature: 0.1
    }, signal);
    const j = parseReasonJson(judgeRaw);
    const finalText = String(j.respuesta_final || draft).trim() || '_(sin respuesta)_';
    const verdict = extractVerdict(j);

    const m = { id: uid(), role: 'assistant', content: finalText, ts: Date.now() };
    if (verdict) m.verdict = verdict;
    convo.messages.push(m);
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
  }

  async function reasonChat(opts, signal) {
    const res = await callEdge({
      action: 'chat',
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens || 4000,
      temperature: opts.temperature != null ? opts.temperature : 0.3
    }, signal);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(data.error || 'Fallo una etapa del razonamiento.', data.status || res.status, data.credits);
    }
    return String(data.text || '').trim();
  }

  function mergeCredits(base, extra) {
    if (!extra) return base;
    const b = base || {};
    return Object.assign({}, b, {
      plan: extra.plan || b.plan,
      weekly_credits: extra.weekly != null ? extra.weekly : (extra.weekly_credits != null ? extra.weekly_credits : b.weekly_credits),
      weekly_used_credits: extra.weeklyUsed != null ? extra.weeklyUsed : (extra.weekly_used_credits != null ? extra.weekly_used_credits : b.weekly_used_credits),
      weekly_remaining: extra.weeklyRemaining != null ? extra.weeklyRemaining : b.weekly_remaining,
      weekly_usage_percent: extra.weeklyUsagePercent != null ? extra.weeklyUsagePercent : b.weekly_usage_percent,
      cooldown_until: extra.cooldownUntil || extra.cooldown_until || b.cooldown_until
    });
  }

  function setBusy(on) {
    state.busy = on;
    setStatusDot(on ? 'busy' : 'idle');
    el.sendBtn.classList.toggle('stopping', on);
    el.icSend.hidden = on; el.icStop.hidden = !on;
  }

  /* ───────────────────────── UI binding ───────────────────────── */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 130) + 'px';
  }

  function openDrawer() { el.drawer.hidden = false; el.scrim.hidden = false; }
  function closeDrawer() { el.drawer.hidden = true; el.scrim.hidden = true; }

  /* ─────────────────── Configuración ─────────────────── */
  function openSettings() {
    el.settingsModal.hidden = false;
    const on = state.engine === 'os';
    setEngineToggleVisual(on);
    el.engineStatus.className = 'engine-status' + (on ? ' ok' : '');
    el.engineStatus.textContent = on ? '✅ Motor LTH OS activado' : 'Motor web (estándar)';
  }
  function closeSettings() { el.settingsModal.hidden = true; }
  function persistEngine() { try { localStorage.setItem(ENGINE_KEY, state.engine); } catch (_) {} }
  function setEngineToggleVisual(on, dot) {
    el.engineToggle.setAttribute('aria-checked', on ? 'true' : 'false');
    el.engineDot.className = 'eng-dot ' + (dot || (on ? 'on' : 'off'));
  }
  function setEngineUI(on, statusClass, statusText) {
    setEngineToggleVisual(on);
    el.engineStatus.className = 'engine-status' + (statusClass ? ' ' + statusClass : '');
    el.engineStatus.textContent = statusText;
  }
  async function toggleEngine() {
    if (state.engine === 'os') {
      state.engine = 'web'; persistEngine();
      el.enginePinEntry.hidden = true;
      stopEnginePresence();
      setEngineUI(false, '', 'Motor web (estándar)');
      renderEngineBadge();
      return;
    }
    setEngineToggleVisual(false, 'busy');
    el.enginePinEntry.hidden = true;
    el.engineStatus.className = 'engine-status';
    el.engineStatus.textContent = '🔎 Buscando tu PC con LTH OS…';
    const probe = await probeOsEngine();
    if (!probe.ok) {
      setEngineUI(false, 'warn', '⚠️ No se encontró tu PC. Enciende LTH OS y activa LTH Remote, en la misma cuenta.');
      return;
    }
    // PC en línea: pedir el PIN de 6 dígitos que se muestra en LTH IA del PC.
    el.engineStatus.className = 'engine-status';
    el.engineStatus.textContent = '🔐 Tu PC está listo. En LTH IA del PC toca "vincular móvil" y escribe aquí el código.';
    el.enginePinEntry.hidden = false;
    el.enginePinInput.value = '';
    try { el.enginePinInput.focus(); } catch (_) {}
  }

  async function connectEngineWithPin(pin) {
    el.engineStatus.className = 'engine-status';
    el.engineStatus.textContent = '⏳ Conectando con el motor…';
    const row = await sendOsCommand('engine-unlock', { pin: pin, deviceId: osDeviceId() }, 12000);
    if (row && row.status === 'done' && (row.result || {}).paired) {
      state.engine = 'os'; persistEngine();
      state.osConnected = true;
      el.enginePinEntry.hidden = true;
      setEngineUI(true, 'ok', '✅ Conectado al motor LTH OS');
      renderEngineBadge(); startEnginePresence();
      return true;
    }
    const err = (row && row.error) ? row.error : 'No se pudo conectar. Revisa el PIN.';
    el.engineStatus.className = 'engine-status warn';
    el.engineStatus.textContent = '⚠️ ' + err;
    return false;
  }

  function bindApp() {
    el.menuBtn.addEventListener('click', () => {
      if (el.drawer.hidden) { renderConvoList(); openDrawer(); } else closeDrawer();
    });
    el.scrim.addEventListener('click', closeDrawer);
    el.closeDrawerBtn.addEventListener('click', closeDrawer);
    el.newChatBtn.addEventListener('click', newConvo);
    el.newChatTop.addEventListener('click', newConvo);
    el.logoutBtn.addEventListener('click', logout);
    el.settingsBtn.addEventListener('click', () => { closeDrawer(); openSettings(); });
    el.settingsClose.addEventListener('click', closeSettings);
    el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) closeSettings(); });
    el.engineToggle.addEventListener('click', toggleEngine);
    const submitPin = async () => {
      const pin = String(el.enginePinInput.value || '').replace(/\D/g, '').slice(0, 6);
      if (pin.length !== 6) { el.engineStatus.className = 'engine-status warn'; el.engineStatus.textContent = '⚠️ El PIN debe tener 6 dígitos.'; return; }
      el.enginePinSubmit.disabled = true;
      try { await connectEngineWithPin(pin); } finally { el.enginePinSubmit.disabled = false; }
    };
    el.enginePinSubmit.addEventListener('click', submitPin);
    el.enginePinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPin(); } });
    el.creditsBtn.addEventListener('click', () => { el.creditsPanel.hidden = !el.creditsPanel.hidden; });
    document.addEventListener('click', (e) => {
      if (!el.creditsPanel.hidden && !el.creditsPanel.contains(e.target) && !el.creditsBtn.contains(e.target)) el.creditsPanel.hidden = true;
    });

    el.composer.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.busy) { if (state.abort) state.abort.abort(); return; }
      send(el.input.value);
    });
    el.reasonBtn.addEventListener('click', () => { state.reasoning = !state.reasoning; persistReason(); renderReasonBtn(); });
    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.composer.requestSubmit(); }
    });
    el.suggestions.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { el.input.value = b.textContent.replace(/…$/, ''); autoGrow(); el.input.focus(); });
    });
  }

  /* ───────────────────────── Auth UI ───────────────────────── */
  function setAuthMode(mode) {
    state.authMode = mode;
    document.querySelectorAll('[data-auth-tab]').forEach((t) => t.classList.toggle('on', t.getAttribute('data-auth-tab') === mode));
    el.authNameField.hidden = mode !== 'signup';
    el.authBtnLabel.textContent = mode === 'signup' ? 'Crear cuenta' : 'Entrar';
    el.authPassword.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
    el.authMsg.textContent = ''; el.authMsg.classList.remove('ok');
  }

  function setAuthBusy(on) {
    el.authSubmit.disabled = on;
    el.authSpinner.hidden = !on;
    el.authBtnLabel.style.opacity = on ? '.6' : '1';
  }

  function authMessage(text, ok) {
    el.authMsg.textContent = text || '';
    el.authMsg.classList.toggle('ok', !!ok);
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = String(el.authEmail.value || '').trim().toLowerCase();
    const password = String(el.authPassword.value || '');
    if (!email || !password) { authMessage('Completa correo y contraseña.'); return; }
    if (password.length < 6) { authMessage('La contraseña debe tener al menos 6 caracteres.'); return; }

    setAuthBusy(true); authMessage('');
    try {
      if (state.authMode === 'signup') {
        const name = String(el.authName.value || '').trim();
        const data = await authFetch('/signup', { email, password, data: name ? { display_name: name } : {} });
        const session = normalizeSession(data);
        if (session) { saveSession(session); await enterApp(); }
        else { authMessage('Cuenta creada. Revisa tu correo para confirmarla y luego entra.', true); setAuthMode('login'); }
      } else {
        const data = await authFetch('/token?grant_type=password', { email, password });
        const session = normalizeSession(data);
        if (!session) throw new Error('No se pudo iniciar sesion.');
        saveSession(session); await enterApp();
      }
    } catch (err) {
      let msg = (err && err.message) || 'Error.';
      if (/already registered/i.test(msg)) msg = 'Ese correo ya tiene cuenta. Entra con tu contraseña.';
      else if (/invalid login/i.test(msg)) msg = 'Correo o contraseña incorrectos.';
      else if (/email not confirmed/i.test(msg)) msg = 'Confirma tu correo antes de entrar (revisa tu bandeja).';
      authMessage(msg);
    } finally {
      setAuthBusy(false);
    }
  }

  /* ───────────────────────── Flujo app ───────────────────────── */
  async function enterApp() {
    el.authScreen.hidden = true;
    el.appScreen.hidden = false;
    setStatusDot('idle');
    // Datos de usuario
    const u = state.session && state.session.user;
    const email = (u && u.email) || '';
    const name = (u && u.user_metadata && (u.user_metadata.display_name || u.user_metadata.name)) || (email ? email.split('@')[0] : 'Usuario');
    el.userName.textContent = name;
    el.userEmail.textContent = email;
    el.userAvatar.textContent = (name[0] || 'L').toUpperCase();

    try { state.engine = localStorage.getItem(ENGINE_KEY) === 'os' ? 'os' : 'web'; } catch (_) { state.engine = 'web'; }
    try { state.reasoning = localStorage.getItem(REASON_KEY) === '1'; } catch (_) { state.reasoning = false; }
    renderReasonBtn();
    state.osConnected = null; // comprobando hasta el primer sondeo
    renderEngineBadge();
    if (state.engine === 'os') startEnginePresence();
    loadConvos();
    state.activeId = state.convos[0] ? state.convos[0].id : null;
    renderConvoList(); renderMessages();
    el.input.focus();

    await fetchStatus();
    syncPull();
  }

  function logout() {
    const token = state.session && state.session.access_token;
    if (token) { fetch(AUTH_URL + '/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }).catch(() => {}); }
    clearSession();
    stopEnginePresence();
    state.convos = []; state.activeId = null; state.credits = null;
    if (el.engineBadge) el.engineBadge.hidden = true;
    closeDrawer();
    el.appScreen.hidden = true;
    el.authScreen.hidden = false;
    el.authPassword.value = '';
    setAuthMode('login');
  }

  /* ───────────────────────── Init ───────────────────────── */
  function cache() {
    el.authScreen = $('#authScreen'); el.appScreen = $('#appScreen');
    el.authForm = $('#authForm'); el.authEmail = $('#authEmail'); el.authPassword = $('#authPassword');
    el.authName = $('#authName'); el.authNameField = $('#authNameField');
    el.authSubmit = $('#authSubmit'); el.authBtnLabel = el.authSubmit.querySelector('.btn-label');
    el.authSpinner = el.authSubmit.querySelector('.btn-spinner'); el.authMsg = $('#authMsg');
    el.menuBtn = $('#menuBtn'); el.statusDot = $('#statusDot'); el.modelLabel = $('#modelLabel'); el.engineBadge = $('#engineBadge');
    el.creditsBtn = $('#creditsBtn'); el.planTag = $('#planTag');
    el.usageFill = $('#usageFill'); el.usageVal = $('#usageVal'); el.usageLabel = $('#usageLabel');
    el.newChatTop = $('#newChatTop');
    el.creditsPanel = $('#creditsPanel'); el.cpPlan = $('#cpPlan');
    el.cpWeek = $('#cpWeek'); el.cpWeekTxt = $('#cpWeekTxt'); el.cpMonth = $('#cpMonth'); el.cpMonthTxt = $('#cpMonthTxt');
    el.cpWindow = $('#cpWindow'); el.cpWindowTxt = $('#cpWindowTxt'); el.cpNote = $('#cpNote');
    el.drawer = $('#drawer'); el.scrim = $('#scrim'); el.convoList = $('#convoList');
    el.newChatBtn = $('#newChatBtn'); el.closeDrawerBtn = $('#closeDrawerBtn'); el.logoutBtn = $('#logoutBtn');
    el.settingsBtn = $('#settingsBtn'); el.settingsModal = $('#settingsModal'); el.settingsClose = $('#settingsClose');
    el.engineToggle = $('#engineToggle'); el.engineStatus = $('#engineStatus'); el.engineDot = $('#engineDot');
    el.enginePinEntry = $('#enginePinEntry'); el.enginePinInput = $('#enginePinInput'); el.enginePinSubmit = $('#enginePinSubmit');
    el.userName = $('#userName'); el.userEmail = $('#userEmail'); el.userAvatar = $('#userAvatar');
    el.messages = $('#messages'); el.welcome = $('#welcome'); el.suggestions = $('#suggestions');
    el.composer = $('#composer'); el.input = $('#input'); el.sendBtn = $('#sendBtn'); el.reasonBtn = $('#reasonBtn');
    el.icSend = el.sendBtn.querySelector('.ic-send'); el.icStop = el.sendBtn.querySelector('.ic-stop');
  }

  async function init() {
    cache();
    if (!SB_URL || !SB_KEY) { authMessage('Falta configurar Supabase en config.js.'); return; }
    document.querySelectorAll('[data-auth-tab]').forEach((t) => t.addEventListener('click', () => setAuthMode(t.getAttribute('data-auth-tab'))));
    el.authForm.addEventListener('submit', handleAuthSubmit);
    bindApp();
    setAuthMode('login');

    const stored = loadSession();
    if (stored && stored.access_token) {
      state.session = stored;
      const token = await ensureToken();
      if (token) { await enterApp(); }
      else { clearSession(); }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
