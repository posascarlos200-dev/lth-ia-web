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
  const INVITES = window.LTHInviteApi;
  const SB_URL = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const SB_KEY = String(CFG.SUPABASE_PUBLISHABLE_KEY || '');
  const FN_URL = SB_URL + (CFG.FUNCTION_PATH || '/functions/v1/lth-ia-cloud');
  const INVITE_FN_URL = SB_URL + (CFG.INVITE_FUNCTION_PATH || '/functions/v1/lth-ia-invites');
  const REST_URL = SB_URL + '/rest/v1/ia_conversations';
  const AUTH_URL = SB_URL + '/auth/v1';

  const SESSION_KEY = 'lth_ia_web_session_v1';
  const CONVO_KEY = 'lth_ia_web_convos_v1';
  const TOMB_KEY = 'lth_ia_web_tombstones_v1';
  const HISTORY_LIMIT = 18;
  const BRAIN_VERSION = 1;
  const BRAIN_MIN_MESSAGES = 4;
  const BRAIN_UPDATE_INTERVAL = 2;
  const BRAIN_UPDATE_MODEL = 'google/gemini-2.5-flash-lite';
  const FREE_RESEARCH_TIMEOUT_MS = 4500;
  const FREE_RESEARCH_MAX_SOURCES = 3;
  const LOCAL_MEMORY_DB_NAME = 'lth_ia_web_local_memory_v1';
  const LOCAL_MEMORY_DB_VERSION = 1;
  const LOCAL_MEMORY_STORE = 'conversations';
  const LOCAL_RECALL_MAX_SNIPPETS = 4;
  const LOCAL_RECALL_RECENT_SKIP = 8;

  const SYSTEM_PROMPT = [
    'Eres LTH IA, tambien llamada Mady: la asistente oficial del ecosistema LTH OS, hablando desde la web movil del usuario.',
    'Tu tono es cercano, claro y resolutivo. Respondes en espanol salvo que el usuario use otro idioma.',
    'Usa Markdown simple cuando ayude: **negritas**, listas, y bloques de codigo con ``` para codigo.',
    'Se concisa por defecto; extiende solo cuando el usuario lo pida o el tema lo exija.',
    'No inventes datos; si no estas segura, dilo. Eres parte de LTH OS, un sistema operativo de apps creado por el equipo LTH.'
  ].join(' ');

  // Motor de imagen: el MISMO modelo/ruta que usa LTH IA en el OS (edge compartido).
  const MEDIA_REST_URL = SB_URL + '/rest/v1/ia_media';
  const PROGRAM_REST_URL = SB_URL + '/rest/v1/program_artifacts';
  const FEEDBACK_REST_URL = SB_URL + '/rest/v1/ai_response_feedback';
  const IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
  const IMAGE_SYSTEM_PROMPT = 'Eres Mady, la asistente de LTH OS. Genera directamente la imagen que describe el usuario y acompanala con una frase breve en espanol. La imagen debe tratar EXACTAMENTE lo pedido; no agregues marcas, textos ni elementos no solicitados (nunca generes productos LTH si no se piden). Si el usuario pide texto dentro de la imagen, respetalo exactamente.';
  const PDF_SYSTEM_PROMPT = 'Eres Mady, la asistente de LTH OS. El usuario quiere un documento que se exportara a PDF. Antes de redactar, corrige los errores reconocidos durante la conversacion (citas biblicas, datos, cifras): NO transcribas la conversacion cruda, entrega la version corregida, limpia y ordenada. Redacta el documento COMPLETO en espanol, bien estructurado en Markdown simple: una primera linea con el titulo usando "# Titulo", luego secciones con "## Subtitulo", parrafos claros y listas con "- " cuando ayude. No uses tablas ni bloques de codigo ni HTML. Entrega solo el contenido del documento, sin preambulos como "aqui tienes" ni despedidas.';

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
    '1b) Si la categoria es "codigo" y aun no esta claro QUE construir (tipo de proyecto/pagina, secciones, estilo o contenido), haz UNA sola ronda de aclaracion (need_clarification=true) que reuna TODO lo necesario: para cada decision ofrece 2-3 opciones donde la PRIMERA va marcada "(recomendada)", y cierra invitando a "elige un numero o escribe lo tuyo". No abras varias rondas; con eso debe bastar para tener el brief completo.',
    '2) Si esta clara, reescribe la peticion en "improved_prompt": instrucciones limpias, completas y especificas para el especialista (objetivo, contexto relevante del chat, formato esperado y restricciones). Para "codigo", el improved_prompt debe quedar como un BRIEF de proyecto: tipo de pagina, secciones concretas, paleta/estilo, contenido de ejemplo y cualquier interaccion pedida.',
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

  // Razonamiento -> categoria "codigo": build especializado en 3 agentes (estructura -> css -> pulido).
  // El pulido reemplaza al juez. Tokens altos para escribir codigo extenso (x3).
  const CODE_STRUCTURE_PROMPT = [
    'Eres el AGENTE DE ESTRUCTURA del build de codigo de Mady (modo razonamiento).',
    'Recibes un BRIEF claro del proyecto. Entrega SOLO la ESTRUCTURA HTML semantica y COMPLETA del proyecto: todas las secciones reales pedidas, con contenido de ejemplo realista (nada de "lorem" vacio ni placeholders sin sentido).',
    'No escribas CSS (ni estilos inline) ni JS, salvo lo imprescindible para el esqueleto. Usa clases con nombres claros y consistentes que el agente de CSS pueda estilar.',
    'Piensa la jerarquia completa (header, nav, hero, secciones de contenido, footer, etc. segun el proyecto). Si el proyecto necesita un control de tema/modo oscuro, incluye un boton con id="theme-toggle". Devuelve el HTML en UN bloque ```html y nada de texto fuera del codigo.'
  ].join('\n');
  const CODE_CSS_PROMPT = [
    'Eres el AGENTE DE CSS del build de codigo de Mady.',
    'Recibes el HTML de estructura. Escribe el CSS COMPLETO, moderno y responsive para ESE HTML: mobile-first, variables de color, buena tipografia, espaciados consistentes, grid/flex, estados hover/focus y animaciones sutiles. Cubre TODAS las clases y secciones del HTML; no dejes nada sin estilar.',
    'No modifiques el HTML; estila por las clases existentes. Devuelve SOLO el CSS en UN bloque ```css, sin explicaciones.',
    'TEMA/MODO OSCURO: define los estilos del tema oscuro con selectores [data-theme="dark"] sobre <html> (ej. [data-theme="dark"] body { ... }, [data-theme="dark"] .card { ... }). NO inventes clases nuevas para el tema; usa siempre [data-theme="dark"] para que coincida con el JS.'
  ].join('\n');
  const CODE_POLISH_PROMPT = [
    'Eres el AGENTE DE PULIDO Y QA del build de codigo de Mady (ultimo paso; presentas al usuario).',
    'Recibes el HTML de estructura y el CSS. Integra TODO en UN SOLO documento HTML completo y autocontenido (<!doctype html> ... </html>): mete el CSS en <style> y agrega el JS necesario para que funcione (interacciones, navegacion, menus, lo que el proyecto requiera).',
    'Revisa y corrige antes de entregar: enlaces o secciones rotas, accesibilidad basica, responsive en movil, consistencia visual y que NO falte nada del brief. El resultado debe abrir y verse bien tal cual, sin pasos extra.',
    'Devuelve el documento final en UN bloque ```html y, debajo, 2-3 lineas en espanol de lo que incluiste y como usarlo. No transcribas el proceso ni menciones los agentes.'
  ].join('\n');
  // Agente de interactividad: SOLO JavaScript (no reescribe HTML ni CSS). El documento
  // final se ensambla en codigo (estructura + CSS + JS), no lo reconstruye un modelo.
  const CODE_JS_PROMPT = [
    'Eres el AGENTE DE INTERACTIVIDAD (JavaScript) del build de Mady.',
    'Recibes el HTML de estructura (y un extracto del CSS ya aplicado). Escribe SOLO el JavaScript que la pagina necesita para funcionar: menus, navegacion, tabs, sliders, modales, formularios, scroll suave, lo que pida el proyecto. Usa los id/clases que YA existen en el HTML.',
    'NO reescribas el HTML ni el CSS. NO devuelvas un documento completo. Si la pagina es estatica y no necesita JS, devuelve un bloque con un comentario breve.',
    'TEMA/MODO OSCURO: el boton de tema (id="theme-toggle" u otro id que veas en el HTML) debe alternar SIEMPRE el atributo en <html>: document.documentElement.dataset.theme = (document.documentElement.dataset.theme === "dark" ? "" : "dark"). Asi coincide con el CSS [data-theme="dark"]. Engancha el listener al cargar (DOMContentLoaded). Cada control interactivo debe quedar realmente funcional.',
    'Devuelve SOLO el JavaScript en UN bloque ```js, sin explicaciones ni HTML.'
  ].join('\n');

  // Asistente de la herramienta "Programar": guia al usuario UNA decision a la vez con
  // tarjetas presionables (max 3, la 1a recomendada) o texto propio, hasta tener un plan.
  const PROGRAM_WIZARD_PROMPT = [
    'Eres la misma IA del modo Programar de Mady, en su fase breve de preparacion. Tu objetivo es convertir la idea del usuario en un PROMPT MAESTRO preciso para generar un unico HTML excelente.',
    'Recibes un JSON con { request: pedido inicial, answers: respuestas confirmadas, max_questions: 3, remaining_questions }.',
    'Tu trabajo en cada paso:',
    '- Haz como maximo 3 preguntas en total y solo si cambian materialmente el resultado: 1) objetivo/contenido, 2) estilo visual, 3) interacciones. Omite lo que ya este claro.',
    '- Devuelve UNA pregunta breve con 2-3 opciones concretas. La PRIMERA debe ser tu recomendacion profesional para este proyecto, no una opcion generica. Incluye description con una razon corta y util.',
    '- No preguntes por framework: el resultado siempre sera un unico HTML autocontenido con CSS y JS internos.',
    '- Cuando ya haya suficiente contexto o remaining_questions sea 0, devuelve el PROMPT MAESTRO final. Debe preservar literalmente las decisiones del usuario y completar solo detalles razonables.',
    'Devuelve SOLO JSON valido, sin texto fuera del JSON. Dos formatos:',
    'Para preguntar: { "phase": "ask", "question": "texto breve", "options": [{"label":"Opcion concreta","value":"valor claro","description":"por que conviene","recommended":true},{"label":"...","value":"...","description":"..."}], "allow_custom": true }',
    'Para finalizar: { "phase": "plan", "plan": "PROMPT MAESTRO con objetivo, publico, contenido y secciones en orden, direccion visual/paleta, responsive movil, interacciones exactas, accesibilidad y criterios de terminado. Indica que la salida sera un solo HTML autocontenido." }',
    'Maximo 3 opciones por pregunta. Las opciones deben ser distintas y concretas (no "si/no" vagos).'
  ].join('\n');

  const PROGRAM_CODER_PROMPT = [
    'Eres la UNICA IA programadora del modo Programar de Mady. Construyes una pagina web completa en un solo archivo HTML autocontenido.',
    'Cumple exactamente el pedido del usuario. Antes de escribir, organiza internamente la estructura, el diseno y las interacciones; no muestres ese razonamiento.',
    'El documento debe empezar con <!DOCTYPE html>, incluir todo el CSS dentro de <style> y todo el JavaScript dentro de <script>. No crees archivos separados.',
    'NAVEGACION DE UNA SOLA PAGINA (obligatoria): cada opcion del menu apunta con hash a una seccion real que EXISTE en la pagina; cada seccion lleva su id correspondiente. Ej: <a href="#inicio">Inicio</a> ... <section id="inicio">. Nunca uses href="/", "/login", "/home", "/auth", "/dashboard", rutas como /inicio, index.html ni enlaces relativos para navegar dentro de la pagina.',
    'BOTONES SEGUROS: todo boton que no envie un formulario es <button type="button">. Si un boton lleva a una seccion (ej. "Explorar Ahora"), usa scroll interno: onclick="document.querySelector(\'#top-comidas\').scrollIntoView({behavior:\'smooth\'})". NUNCA navegues con location.href, location.assign, location.replace ni window.location: eso sacaria al usuario de la pagina.',
    'Entrega contenido realista y completo, diseno responsive, accesibilidad basica y controles funcionales. No uses dependencias externas que requieran claves.',
    'Devuelve SOLO un bloque ```html con el documento completo. No agregues explicaciones fuera del bloque.'
  ].join('\n');

  const PROGRAM_PATCH_PROMPT = [
    'Eres la UNICA IA editora de una pagina guardada como un solo HTML.',
    'Este chat representa UN SOLO PROYECTO persistente. Cada peticion modifica la version actual; nunca empieces otro proyecto ni reemplaces la pagina por una distinta. Si el usuario pide otro proyecto, devuelve operations vacio y explica en summary que debe abrir un chat nuevo.',
    'Antes de responder, razona internamente sobre la intencion, localiza los elementos y estados relacionados y revisa sus dependencias en HTML, CSS y JS. Ejemplo: "mejora visualmente el logo de modo nocturno" exige encontrar el logo y las reglas [data-theme="dark"] o equivalentes, y modificar solo lo necesario para ese estado.',
    'Aplica UNICAMENTE el cambio pedido. Conserva byte por byte todo lo que no necesita cambiar: no redisenes, no limpies, no reformatees y no reconstruyas el documento.',
    'Responde SOLO JSON valido con esta forma: {"summary":"resumen breve","operations":[{"search":"texto exacto existente","replace":"texto nuevo"}]}.',
    'Cada search debe ser una cadena exacta copiada del HTML actual y aparecer UNA sola vez. Incluye suficiente contexto para que sea unica.',
    'Usa la menor cantidad de operaciones y el menor texto posible. Para insertar, reemplaza un cierre o fragmento cercano por ese mismo fragmento mas la insercion.',
    'No uses markdown ni bloques de codigo. Nunca devuelvas el HTML completo. Si el pedido no requiere cambios, devuelve operations vacio.'
  ].join('\n');

  // Reescritura COMPLETA: para cambios grandes que el parche quirurgico no puede hacer
  // (rediseno, reestructura, varias secciones). Devuelve el HTML entero actualizado.
  const PROGRAM_REWRITE_PROMPT = [
    'Eres la UNICA IA editora del modo Programar de Mady. Recibes una pagina web (un solo HTML autocontenido) y un CAMBIO pedido por el usuario.',
    'Aplica el cambio pedido, por grande que sea (rediseno, reestructura, nuevas secciones). Conserva lo que el usuario NO pidio cambiar: el contenido, estilo y funcionalidad que ya existian y siguen teniendo sentido.',
    'Devuelve el DOCUMENTO HTML COMPLETO y actualizado: empieza con <!DOCTYPE html>, con TODO el CSS dentro de <style> y TODO el JavaScript dentro de <script>. Un solo archivo, sin dependencias externas que requieran clave.',
    'NAVEGACION SEGURA (obligatoria): el menu apunta con href="#seccion" a secciones que existen y llevan su id; los botones son <button type="button"> con scroll interno; NUNCA uses href="/", "/login", "/home", location.href ni window.location para navegar.',
    'Devuelve SOLO un bloque ```html con el documento completo. Nada de explicaciones fuera del bloque.'
  ].join('\n');

  // Motor LTH OS (PC): se enruta por la cola remote_commands (accion ia-ask),
  // igual que LTH Remote. El Mady completo del PC responde.
  const REMOTE_CMD_URL = SB_URL + '/rest/v1/remote_commands';
  const ENGINE_KEY = 'lth_ia_web_engine_v1';
  const OSDEV_KEY = 'lth_ia_web_osdevice_v1';
  const REASON_KEY = 'lth_ia_web_reason_v1';
  const PROGRAM_KEY = 'lth_ia_web_program_v1';
  const THEME_KEY = 'lth_ia_web_theme_v1';
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
    invite: null,
    inviteTimer: null,
    engine: 'web',
    osConnected: null,   // null = comprobando, true = conectado, false = sin conexion
    presenceTimer: null,
    reasoning: false,
    reasonModels: null,   // config de modelos del razonamiento por etapa (editable en admin)
    createMode: false,    // "Crear algo": fuerza generar HTML/CSS/JS visualizable
    programMode: false,   // herramienta "Programar": el siguiente envio abre el asistente
    program: null,        // sesion activa del asistente { active, convo, request, answers, plan, busy }
    programEdit: null,    // edicion en curso de una pagina ya hecha { doc, convo }
    manualModel: 'auto'   // 'auto' = ruteo automatico; o un id de MANUAL_MODELS
  };

  // Selector de modelo manual (barra de modelos, igual que en LTH OS). 'auto' deja
  // que el router elija. Los premium requieren plan de pago (el server tambien lo valida).
  const MANUAL_MODELS = {
    free: { label: 'Mady Canont Free' },
    auto: { label: 'Auto' },
    flashlite: { label: 'Flash Lite', model: 'google/gemini-2.5-flash-lite', maxTokens: 4000, temperature: 0.2, reasoning: { enabled: true, effort: 'minimal', exclude: true } },
    sonnet: { label: 'Sonnet 4.6', model: 'anthropic/claude-sonnet-4.6', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'high', exclude: true }, premium: true },
    gpt55: { label: 'GPT 5.5', model: 'openai/gpt-5.5', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'high', exclude: true }, premium: true },
    glm5: { label: 'GLM 5', model: 'z-ai/glm-5', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'medium', exclude: true }, premium: true },
    opus: { label: 'Opus 4.7', model: 'anthropic/claude-opus-4.7', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'high', exclude: true }, premium: true },
    fable: { label: 'Fable 5', model: 'anthropic/claude-fable-5', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'high', exclude: true }, premium: true },
    image: { label: 'Imagen', image: true, premium: true }
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

  // Visualizador inteligente: arma un documento HTML renderizable a partir de los bloques
  // de codigo del mensaje. Funciona si la IA da un HTML completo (<!doctype/<html>) o si da
  // fragmentos sueltos de html + css + js (los combina en un solo documento).
  function buildPreviewDoc(src) {
    const text = String(src || '');
    const fences = [];
    const rx = /```(\w+)?\n?([\s\S]*?)```/g;
    let m;
    while ((m = rx.exec(text))) fences.push({ lang: String(m[1] || '').toLowerCase(), code: String(m[2] || '').replace(/\n$/, '') });
    if (!fences.length) return null;
    let htmlBlock = '', css = '', js = '', isFullDoc = false;
    const htmlTag = /<(div|section|main|article|header|footer|nav|button|h[1-6]|p|ul|ol|li|form|input|textarea|select|canvas|svg|img|span|table|a|body|head|style|script)[\s>/]/i;
    for (const f of fences) {
      const code = f.code;
      const low = code.toLowerCase();
      const looksFull = low.includes('<!doctype') || /<html[\s>]/.test(low);
      if (f.lang === 'css') { css += code + '\n'; continue; }
      if (f.lang === 'js' || f.lang === 'javascript') { js += code + '\n'; continue; }
      if (f.lang === 'html' || f.lang === 'markup' || f.lang === 'xml' || looksFull || (!f.lang && htmlTag.test(code))) {
        if (!htmlBlock || (looksFull && !isFullDoc)) { htmlBlock = code; isFullDoc = looksFull; }
      }
    }
    if (!htmlBlock) return null;
    if (isFullDoc) {
      let doc = htmlBlock;
      if (css && !/<style/i.test(doc)) doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, '<style>' + css + '</style></head>') : ('<style>' + css + '</style>' + doc);
      if (js && !/<script/i.test(doc)) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, '<script>' + js + '</script></body>') : (doc + '<script>' + js + '</script>');
      return doc;
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body>' + htmlBlock + '<script>' + js + '</script></body></html>';
  }

  // El iframe de la vista previa es sandbox SIN allow-same-origin: ahi localStorage/
  // sessionStorage LANZAN error y rompen todo el script (ej. el toggle de modo oscuro que
  // guarda el tema). Inyectamos un storage falso (en memoria) al inicio para que no truene.
  function withPreviewShim(doc) {
    const shim = '<script>(function(){function mk(){var s={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}}var bad=false;try{window.localStorage.getItem("__t")}catch(e){bad=true}if(bad){try{Object.defineProperty(window,"localStorage",{value:mk(),configurable:true});Object.defineProperty(window,"sessionStorage",{value:mk(),configurable:true})}catch(_){try{window.localStorage=mk();window.sessionStorage=mk()}catch(__){}}}})();<\/script>';
    // Un HTML autocontenido no debe escapar hacia las rutas de LTH IA. Por ejemplo,
    // href="/" antes cargaba el login dentro del visor. Los hashes siguen funcionando;
    // las rutas internas se convierten en scroll local y los enlaces externos abren aparte.
    const navigationGuard = '<script>(function(){function localTarget(raw){var clean=String(raw||"").split("?")[0].split("#")[0].replace(/^\\.\\//,"").replace(/^\\/+|\\/+$/g,"");var name=clean.split("/").pop().replace(/\\.html?$/i,"");return name&&document.getElementById(name)}function internal(raw){if(!raw||raw==="#")return true;if(raw.charAt(0)==="#")return false;if(/^(mailto:|tel:|sms:|javascript:)/i.test(raw))return false;try{var base=new URL(document.baseURI);var url=new URL(raw,base);return url.origin===base.origin}catch(_){return !/^[a-z][a-z0-9+.-]*:/i.test(raw)}}function scrollTo(raw){var t=localTarget(raw);if(t){t.scrollIntoView({behavior:"smooth",block:"start"})}else{window.scrollTo({top:0,behavior:"smooth"})}}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var raw=String(a.getAttribute("href")||"").trim();if(raw.charAt(0)==="#"){if(raw==="#"){e.preventDefault();window.scrollTo({top:0,behavior:"smooth"})}return}if(internal(raw)){e.preventDefault();scrollTo(raw);return}if(/^https?:/i.test(raw)){a.target="_blank";a.rel="noopener noreferrer"}},true);document.addEventListener("submit",function(e){var form=e.target;if(!form||form.tagName!=="FORM")return;var action=String(form.getAttribute("action")||"").trim();if(!action||internal(action))e.preventDefault()},true);try{var L=window.location,oa=L.assign&&L.assign.bind(L),orp=L.replace&&L.replace.bind(L);if(oa)L.assign=function(u){if(internal(String(u))){scrollTo(String(u))}else{oa(u)}};if(orp)L.replace=function(u){if(internal(String(u))){scrollTo(String(u))}else{orp(u)}}}catch(_){}try{var ow=window.open;window.open=function(u){if(u!=null&&internal(String(u))){scrollTo(String(u));return null}return ow.apply(window,arguments)}}catch(_){}})();<\/script>';
    const injected = shim + navigationGuard;
    const d = String(doc || '');
    if (/<head[^>]*>/i.test(d)) return d.replace(/<head[^>]*>/i, (mm) => mm + injected);
    if (/<html[^>]*>/i.test(d)) return d.replace(/<html[^>]*>/i, (mm) => mm + '<head>' + injected + '</head>');
    return injected + d;
  }

  // Bloque de Vista previa (iframe + barra de acciones) a partir de un documento HTML.
  function buildPreviewBlockHtml(doc) {
    if (!doc || !String(doc).trim()) return '';
    const code = escapeHtml(String(doc));
    return '<div class="code-preview">'
      + '<div class="code-preview-launch">'
      + '<button class="code-preview-btn" type="button" data-preview-toggle="1">'
      +   '<span class="cpl-ic">⛶</span>'
      +   '<span class="cpl-tx"><span class="cpl-label">Abrir página</span><span class="cpl-sub">Vista previa interactiva</span></span>'
      +   '<span class="cpl-go">↗</span>'
      + '</button>'
      + '<button class="code-preview-codebtn" type="button" data-preview-code="1" title="Ver y copiar el código"><span class="cpc-ic">&lt;/&gt;</span> Código</button>'
      + '</div>'
      + '<div class="code-preview-frame" hidden>'
      + '<div class="code-preview-bar"><span class="code-preview-title">Vista de la página</span>'
      + '<button class="code-preview-fs" type="button" data-preview-download="single" title="Descargar como un solo archivo HTML">⬇ HTML</button>'
      + '<button class="code-preview-fs" type="button" data-preview-edit="1" title="Editar esta página">✎ Editar</button><button class="code-preview-fs code-preview-close" type="button" data-preview-close="1" title="Volver al chat">← Volver</button></div>'
      + '<iframe class="code-preview-iframe" sandbox="allow-scripts allow-modals allow-popups" loading="lazy" data-doc="' + previewAttr(doc) + '" src="' + previewDataUrl(withPreviewShim(doc)) + '"></iframe></div>'
      + '<div class="code-preview-code" hidden>'
      + '<div class="code-preview-bar"><span class="code-preview-title">Código HTML</span>'
      + '<button class="code-preview-fs" type="button" data-preview-copy="1" title="Copiar el código">⧉ Copiar</button>'
      + '<button class="code-preview-fs code-preview-close" type="button" data-preview-codeclose="1" title="Cerrar el código">← Volver</button></div>'
      + '<pre class="code-preview-pre"><code>' + code + '</code></pre></div>'
      + '</div>';
  }

  // Copia texto al portapapeles con feedback en el boton; cae a execCommand si hace falta.
  function copyTextToClipboard(text, btn) {
    const value = String(text == null ? '' : text);
    const done = () => {
      if (!btn) return;
      const original = btn.innerHTML;
      btn.innerHTML = '✓ Copiado';
      setTimeout(() => { btn.innerHTML = original; }, 1400);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); done();
      } catch (_) {}
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done).catch(fallback);
      } else { fallback(); }
    } catch (_) { fallback(); }
  }

  function previewAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // El visor carga la pagina como data: URL (no srcdoc). Asi el DOCUMENTO de la pagina
  // generada es la propia data: URL: cualquier navegacion a una ruta absoluta de la app
  // (href="/" o location.href="/login") resuelve contra la data: URL -> falla sin cargar
  // nada (NUNCA el login de LTH IA). Los #hash siguen funcionando (misma data: URL).
  function previewDataUrl(html) {
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(String(html == null ? '' : html));
  }

  // Markdown ligero y seguro (escapa primero, luego aplica formato).
  function renderMarkdown(src, opts) {
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
    let out = html || '<p></p>';
    if (opts && opts.preview) {
      const doc = buildPreviewDoc(src);
      if (doc) out += buildPreviewBlockHtml(doc);
    }
    return out;
  }

  /* ─────────── Descarga del resultado (1 archivo o .zip de 3) ─────────── */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000);
  }
  function downloadTextFile(text, filename, mime) {
    downloadBlob(new Blob([String(text || '')], { type: mime || 'text/plain;charset=utf-8' }), filename);
  }

  // Separa un documento autocontenido en index.html + style.css + script.js (con enlaces).
  function splitProgramDocParts(doc) {
    const src = String(doc || '');
    let css = ''; let js = ''; let m;
    const styleRx = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    while ((m = styleRx.exec(src))) css += (m[1] || '').trim() + '\n';
    const scriptRx = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = scriptRx.exec(src))) js += (m[1] || '').trim() + '\n';
    let html = src.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
    if (css.trim()) {
      const link = '<link rel="stylesheet" href="style.css">';
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, '  ' + link + '\n</head>') : (link + '\n' + html);
    }
    if (js.trim()) {
      const ref = '<script src="script.js"></script>';
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, '  ' + ref + '\n</body>') : (html + '\n' + ref);
    }
    return { html: html.replace(/\n{3,}/g, '\n\n').trim(), css: css.trim(), js: js.trim() };
  }

  // ZIP minimo (metodo store, sin compresion) — dependency-free.
  function crc32(bytes) {
    let table = crc32._t;
    if (!table) {
      table = crc32._t = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZipBlob(files) {
    const enc = new TextEncoder();
    const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const parts = []; const central = []; let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = enc.encode(String(f.content || ''));
      const crc = crc32(data);
      const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
      parts.push(new Uint8Array(local), nameBytes, data);
      const cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(cen), nameBytes);
      offset += local.length + nameBytes.length + data.length;
    }
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0));
    return new Blob(parts.concat(central, [new Uint8Array(end)]), { type: 'application/zip' });
  }

  function downloadPreviewDoc(doc, mode) {
    const d = String(doc || '');
    if (!d.trim()) return;
    if (mode === 'single') { downloadTextFile(d, 'pagina.html', 'text/html;charset=utf-8'); return; }
    const parts = splitProgramDocParts(d);
    const files = [{ name: 'index.html', content: parts.html }];
    if (parts.css) files.push({ name: 'style.css', content: parts.css });
    if (parts.js) files.push({ name: 'script.js', content: parts.js });
    downloadBlob(makeZipBlob(files), 'pagina.zip');
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

  function stageErrorMessage(opts, data, res) {
    const stageLabel = String(opts && opts.stageLabel || '').trim();
    const status = Number((data && data.status) || (res && res.status) || 0) || 0;
    const detail = String(data && data.error || '').trim();
    const base = stageLabel ? ('Fallo en ' + stageLabel + '.') : 'Fallo una etapa del razonamiento.';
    if (status === 546) return base + ' Se agoto el tiempo de espera del modelo.';
    if (detail) return base + ' ' + detail;
    return base;
  }

  function renderProgramPolishLive(progress) {
    const p = progress || {};
    const parts = [reasonStageHtml('code_polish')];
    const status = p.text
      ? 'Recibiendo salida parcial del modelo...'
      : (p.sawReasoning ? 'El modelo sigue procesando; aun no termina.' : 'Conectando con el modelo de pulido...');
    parts.push('<div style="margin-top:10px;padding:10px 12px;border:1px solid rgba(84,255,220,.16);border-radius:12px;background:rgba(6,23,20,.45);font-size:12px;line-height:1.45;color:rgba(212,255,246,.82)"><strong style="color:#7fffe0">Actividad en vivo</strong><div style="margin-top:6px">' + escapeHtml(status) + '</div><div style="margin-top:6px;color:rgba(212,255,246,.58)">Eventos recibidos: ' + Number(p.events || 0) + '</div></div>');
    if (p.text) parts.push('<div style="margin-top:12px">' + renderMarkdown(p.text, { preview: true }) + '</div>');
    return parts.join('');
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
        // En el plan free se muestra una marca propia, no el nombre del modelo real.
        const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
        if (plan === 'free') state.modelLabel = 'Mady Canont Free';
        renderCredits();
        renderModelBar();
        void fetchReasonStatus();
      }
    } catch (_) {}
  }

  // Envia el historial y procesa el stream SSE. onDelta(text), devuelve {text, credits}.
  // routeOpts opcional = modelo/params elegidos por el auto-router.
  async function streamChat(convo, query, onDelta, signal, routeOpts) {
    const payload = {
      action: 'stream',
      system: composeSystemWithMemory((routeOpts && routeOpts.system) || SYSTEM_PROMPT, convo, query),
      messages: buildCloudMessages(convo, 'chat')
    };
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


  const brainUpdatePending = new Set();
  const CRISIS_RESPONSE_TEXT = [
    'No puedo ayudar a lastimarte ni a planear suicidio.',
    'Si el peligro es inmediato o crees que podrias actuar hoy, llama al 911 ahora mismo o ve a la sala de emergencias mas cercana.',
    'Si estas en Estados Unidos o Canada, llama o envia un mensaje al 988 ahora mismo para apoyo en crisis.',
    'Si estas fuera de Estados Unidos, contacta ahora mismo al numero de emergencias de tu pais o a una linea local de crisis.',
    'No te quedes solo: escribe o llama en este momento a una persona de confianza y dile exactamente: "Estoy en riesgo y necesito que te quedes conmigo ahora".'
  ].join('\n\n');

  function clipText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, Math.max(1, Number(max) || 0));
  }

  function normalizeWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeNameValue(value, maxWords) {
    return clipText(String(value || '').replace(/[^A-Za-z'\-\s]/g, ' '), 120)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, maxWords || 4)
      .join(' ');
  }

  function uniqueList(values, maxItems, itemMax) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(values) ? values : [];
    for (const item of list) {
      const clean = clipText(item, itemMax || 160);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
      if (out.length >= (maxItems || 8)) break;
    }
    return out;
  }

  function normalizeArtifact(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = clipText(raw.kind || raw.type, 24);
    const id = clipText(raw.id, 120);
    const title = clipText(raw.title || raw.name, 160);
    const note = clipText(raw.note || raw.summary, 240);
    if (!kind && !id && !title && !note) return null;
    return { kind: kind || 'asset', id: id || '', title: title || 'Archivo', note: note || '' };
  }

  const ENTITY_TYPES = new Set(['persona', 'meta', 'archivo', 'preferencia', 'lugar', 'fecha', 'organizacion']);
  const ENTITY_LIMIT = 12;

  function normalizeEntity(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = clipText(String(raw.type || '').toLowerCase(), 20);
    const name = clipText(raw.name || raw.value, 80);
    if (!name || !ENTITY_TYPES.has(type)) return null;
    return { type, name, note: clipText(raw.note, 160) || '', updated_at: Math.max(0, Number(raw.updated_at || Date.now()) || Date.now()) };
  }

  function normalizeEntities(list) {
    const sorted = (Array.isArray(list) ? list : []).map(normalizeEntity).filter(Boolean)
      .sort((a, b) => (Number(b.updated_at || 0) - Number(a.updated_at || 0)));
    const out = [];
    const seen = new Set();
    for (const ent of sorted) {
      const key = ent.type + '|' + ent.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ent);
      if (out.length >= ENTITY_LIMIT) break;
    }
    return out;
  }

  function normalizeBrain(raw, seedSummary) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      version: BRAIN_VERSION,
      running_summary: clipText(source.running_summary || seedSummary || '', 1100),
      user_goal: clipText(source.user_goal, 240),
      active_task: clipText(source.active_task, 240),
      last_known_state: clipText(source.last_known_state, 240),
      important_rules: uniqueList(source.important_rules, 8, 160),
      decisions: uniqueList(source.decisions, 8, 160),
      user_profile: {
        name_for_this_chat: clipText(source.user_profile && source.user_profile.name_for_this_chat, 80),
        full_name: clipText(source.user_profile && source.user_profile.full_name, 120)
      },
      preferences: uniqueList(source.preferences, 8, 160),
      commitments: uniqueList(source.commitments, 8, 220),
      entities: normalizeEntities(source.entities),
      conflicts: uniqueList(source.conflicts, 4, 200),
      current_artifact: normalizeArtifact(source.current_artifact),
      // Capa 4: entidad activa (anti-deriva) y estudio biblico activo.
      active_entity: source.active_entity && typeof source.active_entity === 'object' && source.active_entity.name ? {
        name: clipText(source.active_entity.name, 80),
        kind: clipText(source.active_entity.kind, 40),
        updated_at: Math.max(0, Number(source.active_entity.updated_at || 0) || 0)
      } : null,
      active_study: source.active_study && typeof source.active_study === 'object' && source.active_study.book ? {
        book: clipText(source.active_study.book, 60),
        chapter: clipText(source.active_study.chapter, 12),
        verses: clipText(source.active_study.verses, 24),
        version: clipText(source.active_study.version, 40),
        focus: clipText(source.active_study.focus, 80)
      } : null,
      creator_mode: source.creator_mode === true,
      updated_at: Math.max(0, Number(source.updated_at || Date.now()) || Date.now()),
      covered_count: Math.max(0, Number(source.covered_count || 0) || 0)
    };
  }

  function hasMeaningfulBrain(brain) {
    const b = normalizeBrain(brain);
    return !!(b.running_summary || b.user_goal || b.active_task || b.last_known_state || b.important_rules.length || b.decisions.length || b.preferences.length || b.commitments.length || b.entities.length || b.user_profile.name_for_this_chat || b.user_profile.full_name || b.current_artifact);
  }

  function labeledEntryValue(list, label) {
    const lower = String(label || '').toLowerCase() + ':';
    for (const item of Array.isArray(list) ? list : []) {
      const s = String(item || '');
      if (s.toLowerCase().startsWith(lower)) return s.slice(s.indexOf(':') + 1).trim();
    }
    return '';
  }

  function scalarConflict(label, valueA, valueB) {
    const a = normalizeWhitespace(valueA);
    const b = normalizeWhitespace(valueB);
    if (!a || !b || normalizeForSearch(a) === normalizeForSearch(b)) return '';
    return label + ': hay dos versiones ("' + clipText(a, 70) + '" vs "' + clipText(b, 70) + '")';
  }

  // Detecta contradicciones entre dos versiones del brain (p.ej. memoria local vs servidor)
  // para que Mady pregunte en vez de asumir un dato. Compara los campos canonicos del usuario.
  function detectBrainConflicts(brainA, brainB) {
    const a = normalizeBrain(brainA);
    const b = normalizeBrain(brainB);
    const out = [];
    const nameConflict = scalarConflict('Nombre', a.user_profile.full_name, b.user_profile.full_name);
    if (nameConflict) out.push(nameConflict);
    const goalConflict = scalarConflict('Objetivo', a.user_goal, b.user_goal);
    if (goalConflict) out.push(goalConflict);
    const coffeeConflict = scalarConflict('Cafe', labeledEntryValue(a.preferences, 'Cafe'), labeledEntryValue(b.preferences, 'Cafe'));
    if (coffeeConflict) out.push(coffeeConflict);
    return uniqueList(out, 4, 200);
  }

  function mergeBrain(localBrain, remoteBrain) {
    const local = normalizeBrain(localBrain);
    const remote = normalizeBrain(remoteBrain);
    if (!hasMeaningfulBrain(remote)) return local;
    if (!hasMeaningfulBrain(local)) return remote;
    const remoteWins = Number(remote.updated_at || 0) >= Number(local.updated_at || 0);
    const primary = remoteWins ? remote : local;
    const secondary = remoteWins ? local : remote;
    const conflicts = uniqueList(detectBrainConflicts(primary, secondary).concat(primary.conflicts, secondary.conflicts), 4, 200);
    return normalizeBrain({
      running_summary: primary.running_summary || secondary.running_summary,
      user_goal: primary.user_goal || secondary.user_goal,
      active_task: primary.active_task || secondary.active_task,
      last_known_state: primary.last_known_state || secondary.last_known_state,
      important_rules: primary.important_rules.concat(secondary.important_rules),
      decisions: primary.decisions.concat(secondary.decisions),
      user_profile: {
        name_for_this_chat: primary.user_profile.name_for_this_chat || secondary.user_profile.name_for_this_chat,
        full_name: primary.user_profile.full_name || secondary.user_profile.full_name
      },
      preferences: primary.preferences.concat(secondary.preferences),
      commitments: primary.commitments.concat(secondary.commitments),
      entities: primary.entities.concat(secondary.entities),
      conflicts: conflicts,
      current_artifact: primary.current_artifact || secondary.current_artifact,
      active_entity: primary.active_entity || secondary.active_entity,
      active_study: primary.active_study || secondary.active_study,
      creator_mode: primary.creator_mode || secondary.creator_mode,
      updated_at: Math.max(Number(primary.updated_at || 0), Number(secondary.updated_at || 0)),
      covered_count: Math.max(Number(primary.covered_count || 0), Number(secondary.covered_count || 0))
    });
  }

  function normalizeStoredMessage(message) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
    const content = String(message.content || '');
    if (!content.trim()) return null;
    const next = { id: message.id || uid(), role: message.role, content: content, ts: Number(message.ts) || Date.now() };
    if (Array.isArray(message.media) && message.media.length) next.media = message.media;
    if (message.verdict) next.verdict = message.verdict;
    if (message._feedback) next._feedback = message._feedback;
    if (message.programDoc && String(message.programDoc).trim()) next.programDoc = String(message.programDoc);
    return next;
  }

  function normalizeConvo(convo) {
    if (!convo || !convo.id) return null;
    convo.title = clipText(convo.title || 'Chat', 160) || 'Chat';
    convo.messages = (Array.isArray(convo.messages) ? convo.messages : []).map(normalizeStoredMessage).filter(Boolean);
    convo.created = convo.created || new Date().toISOString();
    convo.updated = Number(convo.updated || Date.now()) || Date.now();
    convo.brain = normalizeBrain(convo.brain, convo.memory && convo.memory.summary);
    // Modo del chat: una vez que se usa Programar/Razonar/Crear, el chat queda dedicado a
    // ese modo (no se mezcla). 'auto' = chat normal.
    convo.mode = ['program', 'reason', 'create'].includes(convo.mode) ? convo.mode : 'auto';
    return convo;
  }

  function ensureConvoBrain(convo) {
    if (!convo) return normalizeBrain();
    convo.brain = normalizeBrain(convo.brain, convo.memory && convo.memory.summary);
    return convo.brain;
  }

  function upsertLabeledEntry(list, label, value, maxItems, itemMax) {
    const cleanLabel = clipText(label, 40);
    const cleanValue = clipText(value, itemMax || 160);
    if (!cleanLabel || !cleanValue) return uniqueList(list, maxItems || 8, itemMax || 160);
    const cleanItem = cleanLabel + ': ' + cleanValue;
    const base = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!String(item || '').toLowerCase().startsWith(cleanLabel.toLowerCase() + ':')) base.push(item);
    }
    base.unshift(cleanItem);
    return uniqueList(base, maxItems || 8, itemMax || 160);
  }

  function extractNameInfo(text) {
    const raw = String(text || '');
    const patterns = [/\bme llamo\s+([A-Za-z?-?'?\-]+(?:\s+[A-Za-z?-?'?\-]+){0,3})/i, /\bmi nombre es\s+([A-Za-z?-?'?\-]+(?:\s+[A-Za-z?-?'?\-]+){0,3})/i, /\bsoy\s+([A-Z??????][A-Za-z?-?'?\-]+(?:\s+[A-Z??????][A-Za-z?-?'?\-]+){0,2})\b/];
    let full = '';
    for (const rx of patterns) {
      const match = raw.match(rx);
      if (match) { full = normalizeNameValue(match[1], 4); break; }
    }
    const lastName = raw.match(/\bmi apellido es\s+([A-Za-z?-?'?\-]+(?:\s+[A-Za-z?-?'?\-]+){0,1})/i);
    if (lastName) {
      const suffix = normalizeNameValue(lastName[1], 2);
      full = normalizeNameValue((full ? (full + ' ') : '') + suffix, 4);
    }
    if (!full) return null;
    const parts = full.split(/\s+/).filter(Boolean);
    return { full_name: full, name_for_this_chat: parts[0] || full };
  }

  function extractPreferenceEntries(text) {
    const raw = normalizeWhitespace(text);
    const out = [];
    const coffee = raw.match(/\b(?:tomo|prefiero|quiero|me gusta)\s+el\s+caf[e?]\s+([^.!?]{1,80})/i) || raw.match(/\bcaf[e?]\s+(sin az[u?]car|con az[u?]car|negro|con leche|descafeinado)\b/i);
    if (coffee) out.push({ label: 'Cafe', value: clipText(('cafe ' + (coffee[1] || '')).replace(/\s+/g, ' '), 120) });
    const pref = raw.match(/\b(?:prefiero|me gusta|uso siempre)\s+([^.!?]{4,100})/i);
    if (pref && !/caf[e?]/i.test(pref[1])) out.push({ label: 'Preferencia', value: clipText(pref[1], 120) });
    return out;
  }

  function extractCommitments(text) {
    const raw = String(text || '');
    const sentences = raw.split(/[.!?\n]+/).map((item) => normalizeWhitespace(item)).filter(Boolean);
    const out = [];
    for (const sentence of sentences) {
      const hasReminder = /\b(recuerdame|recuerdame que|agenda|anota|tengo|acordamos|quedamos)\b/i.test(sentence);
      const hasTime = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(sentence);
      const hasDay = /\b(hoy|manana|ma?ana|tarde|noche|lunes|martes|miercoles|mi?rcoles|jueves|viernes|sabado|s?bado|domingo)\b/i.test(sentence);
      if (hasReminder && (hasTime || hasDay)) out.push(clipText(sentence, 220));
    }
    return uniqueList(out, 8, 220);
  }

  function extractGoal(text) {
    const raw = normalizeWhitespace(text);
    const match = raw.match(/\b(quiero|necesito|estoy buscando|mi meta es)\s+([^.!?]{4,140})/i);
    if (!match) return '';
    return clipText(match[1] + ' ' + match[2], 180);
  }

  function extractRule(text) {
    const raw = normalizeWhitespace(text);
    if (!/\bsiempre\b|\bnunca\b/i.test(raw)) return '';
    return clipText(raw, 160);
  }

  function extractDecision(text) {
    const raw = normalizeWhitespace(text);
    const match = raw.match(/\b(?:decidimos|queda decidido|sera|ser[a?])\s+([^.!?]{4,120})/i);
    if (!match) return '';
    return clipText(match[0], 160);
  }

  // Recuerdos por entidad: persona / lugar / organizacion detectados de forma determinista.
  // meta y archivo se agregan desde el objetivo y el artefacto en sus propios flujos.
  function extractEntities(text) {
    const raw = normalizeWhitespace(text);
    if (!raw) return [];
    const now = Date.now();
    const out = [];
    // Nombres deben iniciar en mayuscula (sin flag 'i') para evitar capturar palabras comunes
    // como "muy" en "mi jefe es muy bueno". Las palabras clave toleran mayuscula inicial de frase.
    const nameToken = '([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúÑñ]+(?:\\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúÑñ]+)?)';
    const relation = raw.match(new RegExp('\\b[Mm]i\\s+(esposa|esposo|marido|mujer|novia|novio|pareja|hija|hijo|madre|padre|mama|mam[aá]|papa|pap[aá]|hermana|hermano|jefa|jefe|amiga|amigo|perro|perra|gato|gata|abuela|abuelo|maestra|maestro|doctor|doctora)\\s+(?:se\\s+llama|es|llamad[oa])\\s+' + nameToken));
    if (relation) out.push({ type: 'persona', name: clipText(relation[2], 80), note: relation[1].toLowerCase(), updated_at: now });
    const place = raw.match(new RegExp('\\b(?:[Vv]ivo en|[Ss]oy de|radico en|me mud[eé] a|trabajo en)\\s+' + nameToken));
    if (place) out.push({ type: 'lugar', name: clipText(place[1], 80), note: 'lugar del usuario', updated_at: now });
    return out;
  }

  function extractBrainFromUserMessage(brainInput, text) {
    const brain = normalizeBrain(brainInput);
    const raw = normalizeWhitespace(text);
    if (!raw) return brain;
    const nameInfo = extractNameInfo(raw);
    if (nameInfo) {
      brain.user_profile.name_for_this_chat = clipText(nameInfo.name_for_this_chat, 80);
      brain.user_profile.full_name = clipText(nameInfo.full_name, 120);
    }
    for (const pref of extractPreferenceEntries(raw)) brain.preferences = upsertLabeledEntry(brain.preferences, pref.label, pref.value, 8, 160);
    for (const item of extractCommitments(raw)) brain.commitments = uniqueList([item].concat(brain.commitments), 8, 220);
    for (const ent of extractEntities(raw)) brain.entities = normalizeEntities([ent].concat(brain.entities));
    const goal = extractGoal(raw);
    if (goal) {
      brain.user_goal = clipText(goal, 240);
      brain.entities = normalizeEntities([{ type: 'meta', name: clipText(goal, 80), note: 'objetivo del usuario', updated_at: Date.now() }].concat(brain.entities));
    }
    const rule = extractRule(raw);
    if (rule) brain.important_rules = uniqueList([rule].concat(brain.important_rules), 8, 160);
    const decision = extractDecision(raw);
    if (decision) brain.decisions = uniqueList([decision].concat(brain.decisions), 8, 160);
    brain.active_task = clipText('Responder la peticion actual del usuario.', 240);
    brain.last_known_state = clipText('Ultimo mensaje del usuario: ' + raw, 240);
    if (!brain.running_summary && (brain.user_goal || brain.preferences.length || brain.commitments.length || brain.user_profile.full_name)) brain.running_summary = clipText('El chat ya tiene datos importantes del usuario guardados para mantener continuidad entre respuestas.', 320);
    brain.updated_at = Date.now();
    return brain;
  }

  function buildBrainContextBlock(input, query) {
    const brain = input && input.brain ? normalizeBrain(input.brain) : normalizeBrain(input);
    const lines = [];
    if (brain.user_profile.full_name || brain.user_profile.name_for_this_chat) lines.push('- Identidad del usuario: ' + (brain.user_profile.full_name || brain.user_profile.name_for_this_chat));
    if (brain.preferences.length) lines.push('- Preferencias recordadas: ' + brain.preferences.join(' | '));
    if (brain.commitments.length) lines.push('- Compromisos y agenda: ' + brain.commitments.join(' | '));
    if (brain.entities && brain.entities.length) lines.push('- Entidades recordadas: ' + brain.entities.map((e) => e.type + ':' + e.name + (e.note ? ' (' + e.note + ')' : '')).join(' | '));
    if (brain.user_goal) lines.push('- Objetivo actual del usuario: ' + brain.user_goal);
    if (brain.active_task) lines.push('- Tarea activa: ' + brain.active_task);
    if (brain.current_artifact) lines.push('- Artefacto actual: ' + brain.current_artifact.kind + ' "' + clipText(brain.current_artifact.title, 120) + '"' + (brain.current_artifact.note ? ' | nota: ' + clipText(brain.current_artifact.note, 200) : ''));
    if (brain.last_known_state) lines.push('- Ultimo estado conocido: ' + brain.last_known_state);
    if (brain.active_entity) lines.push('- ENTIDAD ACTIVA (manten este referente si el usuario corrige o pregunta "de ese", "y el otro", sin nombrar otra): ' + brain.active_entity.name + (brain.active_entity.kind ? ' (' + brain.active_entity.kind + ')' : ''));
    if (brain.active_study) lines.push('- ESTUDIO BIBLICO ACTIVO (no vuelvas a preguntar que pasaje lee): ' + brain.active_study.book + ' ' + (brain.active_study.chapter || '') + (brain.active_study.verses ? ':' + brain.active_study.verses : '') + (brain.active_study.version ? ' | version ' + brain.active_study.version : '') + (brain.active_study.focus ? ' | enfoque ' + brain.active_study.focus : ''));
    if (brain.creator_mode) lines.push('- MODO CREADOR ACTIVO: el usuario es el creador/desarrollador. Responde en tono tecnico de diagnostico (bug report), sin adulacion.');
    if (brain.important_rules.length) lines.push('- Reglas del usuario: ' + brain.important_rules.join(' | '));
    if (brain.decisions.length) lines.push('- Decisiones ya tomadas: ' + brain.decisions.join(' | '));
    if (brain.running_summary) lines.push('- Resumen acumulado: ' + clipText(brain.running_summary, 600));
    if (brain.conflicts && brain.conflicts.length) lines.push('- CONTRADICCIONES SIN RESOLVER (no asumas ninguna version; pregunta brevemente cual es la correcta): ' + brain.conflicts.join(' | '));
    if (query) lines.push('- Mensaje actual: ' + clipText(query, 220));
    if (!lines.length) return '';
    return 'MEMORIA DEL CHAT (interna; debes respetarla y no inventar datos fuera de ella):\n' + lines.join('\n') + '\nSi falta un dato importante o ves una posible contradiccion, pide aclaracion breve antes de inventar.';
  }

  function inferTranslationLanguage(text) {
    const raw = normalizeWhitespace(text).toLowerCase();
    const patterns = [
      { rx: /\b(?:al?|a) ingles\b|\bto english\b/, value: 'ingles' },
      { rx: /\b(?:al?|a) espanol\b|\b(?:al?|a) espa[nñ]ol\b|\bto spanish\b/, value: 'espanol' },
      { rx: /\b(?:al?|a) portugues\b|\b(?:al?|a) portugu[eê]s\b/, value: 'portugues' },
      { rx: /\b(?:al?|a) frances\b|\b(?:al?|a) franc[eé]s\b|\bto french\b/, value: 'frances' },
      { rx: /\b(?:al?|a) italiano\b|\bto italian\b/, value: 'italiano' },
      { rx: /\b(?:al?|a) aleman\b|\b(?:al?|a) alem[aá]n\b|\bto german\b/, value: 'aleman' }
    ];
    const hit = patterns.find((item) => item.rx.test(raw));
    return hit ? hit.value : '';
  }

  function inferRewriteTone(text) {
    const raw = normalizeWhitespace(text).toLowerCase();
    if (/\bformal\b/.test(raw)) return 'formal';
    if (/\bprofesional\b|\bejecutiv[oa]\b/.test(raw)) return 'profesional';
    if (/\bamable\b|\bcercan[oa]\b/.test(raw)) return 'amable';
    if (/\bcorto\b|\bbreve\b|\bconcis[oa]\b/.test(raw)) return 'breve';
    return 'claro y natural';
  }

  function hasRecentRichContext(convo) {
    const normalized = normalizeConvo(convo);
    const recent = normalized && Array.isArray(normalized.messages) ? normalized.messages.slice(-3) : [];
    return recent.some((msg) => String(msg && msg.content || '').trim().length >= 80);
  }

  function detectFreeSkillIntent(text, convoInput) {
    const raw = normalizeWhitespace(text);
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const definitions = [
      { kind: 'translate', label: 'traduccion fiel', tier: 'standard', match: /\b(traduce|traducelo|traducir|traduccion|translate)\b/ },
      { kind: 'rewrite', label: 'reescritura y mejora', tier: 'standard', match: /\b(corrige|corrigelo|mejora|mejoralo|reescribe|redacta mejor|hazlo mas formal|hazlo m[aá]s formal|pul[eé]lo)\b/ },
      { kind: 'summarize', label: 'resumen y sintesis', tier: 'files', match: /\b(resume|resumelo|resumir|resumen|sintetiza|sintesis|puntos clave)\b/ },
      { kind: 'compare', label: 'comparacion guiada', tier: 'standard', match: /\b(compara|comparacion|comparaci[oó]n|diferencias?|ventajas?|desventajas?)\b|\bvs\b|\bversus\b/ },
      { kind: 'extract', label: 'extraccion de puntos accionables', tier: 'files', match: /\b(extrae|saca|lista|checklist|to do|todo list|acciones clave|tareas clave)\b/ },
      { kind: 'plan', label: 'plan paso a paso', tier: 'standard', match: /\b(plan|pasos|roadmap|guia|gu[ií]a|como empiezo|c[oó]mo empiezo|estrategia|orden recomendado)\b/ },
      { kind: 'decide', label: 'recomendacion y decision', tier: 'standard', match: /\b(recomienda|cu[aá]l conviene|que me recomiendas|qu[eé] me recomiendas|vale la pena|me conviene|elijo|escojo)\b/ },
      { kind: 'troubleshoot', label: 'diagnostico y solucion', tier: 'code', match: /\b(no funciona|error|falla|bug|arregla|soluciona|diagnostica|diagnosticar|por que falla|por qu[eé] falla)\b/ },
      { kind: 'explain', label: 'explicacion guiada', tier: 'standard', match: /\b(explica|explicame|qu[eé] significa|que significa|c[oó]mo funciona|como funciona|ens[eé]name|ensename)\b/ }
    ];
    const found = definitions.find((item) => item.match.test(lower));
    if (!found) return null;
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    const hasInlinePayload = /\n/.test(String(text || '')) || /:\s*[\s\S]{16,}$/.test(String(text || '')) || /["'][^"']{16,}["']/.test(raw);
    const hasVsPair = /\bvs\b|\bversus\b|\bentre\b/.test(lower);
    return {
      kind: found.kind,
      label: found.label,
      tier: found.tier,
      wordCount,
      hasInlinePayload,
      hasRecentContext: hasRecentRichContext(convoInput),
      targetLanguage: found.kind === 'translate' ? inferTranslationLanguage(raw) : '',
      rewriteTone: found.kind === 'rewrite' ? inferRewriteTone(raw) : '',
      hasVsPair,
      dependsOnSource: ['translate', 'rewrite', 'summarize', 'extract'].includes(found.kind)
    };
  }

  function buildFreeSkillClarification(skill) {
    if (!skill) return '';
    if (skill.kind === 'compare' && skill.wordCount <= 6 && !skill.hasVsPair) {
      return 'Puedo compararlo, pero necesito que me digas cuales son las dos opciones exactas que quieres poner frente a frente.';
    }
    if (skill.kind === 'translate' && skill.wordCount <= 7 && (!skill.hasInlinePayload && !skill.hasRecentContext)) {
      return 'Puedo traducirlo, pero pegame aqui el texto exacto y dime a que idioma lo quieres llevar.';
    }
    if (skill.dependsOnSource && skill.wordCount <= 7 && !skill.hasInlinePayload && !skill.hasRecentContext) {
      const map = {
        rewrite: 'Puedo mejorarlo o corregirlo, pero necesito que pegues aqui el texto exacto.',
        summarize: 'Puedo resumirlo, pero necesito que pegues aqui el texto, nota o contenido que quieres resumir.',
        extract: 'Puedo sacar los puntos clave, pero necesito el texto o contenido base para trabajar.'
      };
      return map[skill.kind] || '';
    }
    return '';
  }

  function buildFreeSkillSystem(baseSystem, skill) {
    if (!skill) return baseSystem;
    const rules = ['HABILIDAD ACTIVA PARA ESTE TURNO: ' + skill.label + '.'];
    if (skill.kind === 'summarize') {
      rules.push('Responde con una sintesis fiel: primero 1-2 lineas de resumen y luego 3-6 puntos clave si aportan valor.');
      rules.push('No agregues informacion que no este en el texto o en el contexto reciente del chat.');
    } else if (skill.kind === 'rewrite') {
      rules.push('Devuelve directamente la version mejorada del texto, sin prefacios ni explicaciones extra, salvo que el usuario pida comentarios.');
      rules.push('Conserva significado, nombres, cifras, fechas y restricciones.');
      rules.push('Tono preferido: ' + (skill.rewriteTone || 'claro y natural') + '.');
    } else if (skill.kind === 'translate') {
      rules.push('Traduce con fidelidad y conserva nombres propios, cifras, fechas y formato util.');
      rules.push('Idioma objetivo preferido: ' + (skill.targetLanguage || 'el que indique el usuario; si no es obvio, pregunta una sola vez de forma breve') + '.');
    } else if (skill.kind === 'compare') {
      rules.push('Organiza la respuesta como: opcion A, opcion B, diferencias clave y recomendacion final.');
      rules.push('Si una conclusion depende de un supuesto, dilo explicitamente.');
    } else if (skill.kind === 'extract') {
      rules.push('Extrae solo los puntos accionables o claves realmente presentes en el contenido.');
      rules.push('Entregalos en lista limpia y priorizada si aplica.');
    } else if (skill.kind === 'plan') {
      rules.push('Responde con pasos numerados, en orden practico, y cierra con el primer paso accionable que deberia hacer el usuario hoy.');
    } else if (skill.kind === 'decide') {
      rules.push('Da una recomendacion clara al inicio y luego 2-4 razones concretas.');
      rules.push('Si faltan datos clave para decidir bien, dilo sin inventar.');
    } else if (skill.kind === 'troubleshoot') {
      rules.push('Responde con: problema probable, que revisar primero, pasos de diagnostico y arreglo sugerido.');
      rules.push('Si faltan datos tecnicos minimos, pide solo los imprescindibles.');
    } else if (skill.kind === 'explain') {
      rules.push('Explica de lo simple a lo concreto y usa un ejemplo breve si ayuda.');
      rules.push('Evita jerga innecesaria y deja clara la idea principal temprano.');
    }
    rules.push('Adapta el formato de salida a la habilidad activa y evita respuestas genericas.');
    return baseSystem + '\n\n' + rules.join('\n');
  }


  function inferResearchLanguage(text) {
    const raw = normalizeWhitespace(text);
    if (!raw) return 'es';
    const englishHints = /\b(the|what|who|when|where|history|about|explain|today|latest|price|news)\b/i;
    return englishHints.test(raw) ? 'en' : 'es';
  }

  function normalizeResearchQuery(text) {
    const raw = normalizeWhitespace(text);
    if (!raw) return '';
    let cleaned = raw
      .replace(/^por favor\s+/i, '')
      .replace(/^(investiga|busca|averigua|dime|explica(?:me)?|cuentame|cu[eé]ntame|resumeme|res[uú]meme|quiero saber|necesito saber)\s+/i, '')
      .replace(/^(qu[eé] es|que es|quien es|qui[eé]n es|que fue|qu[eé] fue|quien fue|qui[eé]n fue|que sabes de|qu[eé] sabes de)\s+/i, '')
      .replace(/\?+$/g, '')
      .trim();
    return clipText(cleaned || raw, 140);
  }

  function detectFreeResearchIntent(text) {
    const raw = normalizeWhitespace(text);
    if (!raw) return { matched: false, query: '', freshness: 'stable', lang: 'es' };
    const lower = raw.toLowerCase();
    const stable = /\b(investiga|busca|averigua|qu[eé] es|que es|quien es|qui[eé]n es|quien fue|qui[eé]n fue|historia de|origen de|datos de|informacion sobre|informaci[oó]n sobre|explica|explicame|expl[ií]came)\b/;
    const volatile = /\b(hoy|actual|actuales|actualizada|actualizado|reciente|recientes|ultimas|últimas|ultimos|últimos|noticia|noticias|precio|precios|cotizacion|cotizaci[oó]n|resultado|resultados|marcador|version mas nueva|versi[oó]n m[aá]s nueva|ultimo lanzamiento|último lanzamiento)\b/;
    const entityShape = /\b([A-Z][a-z]+\s+[A-Z][a-z]+|bitcoin|tesla|openai|microsoft|google|claude|gemini|wikipedia)\b/;
    const matched = stable.test(lower) || volatile.test(lower) || (entityShape.test(raw) && /\?$/.test(raw));
    return {
      matched,
      query: normalizeResearchQuery(raw),
      freshness: volatile.test(lower) ? 'volatile' : 'stable',
      lang: inferResearchLanguage(raw)
    };
  }

  function stripHtmlTags(value) {
    return normalizeWhitespace(String(value == null ? '' : value).replace(/<[^>]+>/g, ' '));
  }

  function buildFreeResearchContextBlock(research) {
    if (!research || !Array.isArray(research.sources) || !research.sources.length) return '';
    const lines = [
      'INVESTIGACION FREE (fuentes publicas recuperadas por la web; usalas antes de responder):',
      '- Consulta del usuario normalizada: ' + clipText(research.query || '', 140)
    ];
    if (research.freshness === 'volatile') {
      lines.push('- Advertencia: esta consulta parece sensible al tiempo. No afirmes precios, noticias o hechos de ultimo minuto como confirmados si las fuentes no lo muestran claramente.');
    }
    research.sources.slice(0, FREE_RESEARCH_MAX_SOURCES).forEach((item, index) => {
      lines.push('- Fuente ' + (index + 1) + ': ' + clipText(item.title || 'Fuente', 120) + ' | ' + clipText(item.source || 'web', 40) + ' | ' + clipText(item.url || '', 220));
      lines.push('  Resumen: ' + clipText(item.summary || '', 420));
    });
    lines.push('Reglas: responde usando primero estas fuentes, separa hechos confirmados de inferencias y cita las URLs al final cuando uses datos de ellas. Si falta verificacion, dilo claramente.');
    return lines.join('\n');
  }

  function buildFreeResearchSystem(baseSystem, research) {
    const block = buildFreeResearchContextBlock(research);
    return block ? (baseSystem + '\n\n' + block) : baseSystem;
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs, outerSignal) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs || FREE_RESEARCH_TIMEOUT_MS) : null;
    const signal = ctrl ? ctrl.signal : outerSignal;
    if (outerSignal && ctrl) {
      if (outerSignal.aborted) { if (timer) clearTimeout(timer); throw new Error('aborted'); }
      outerSignal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
    }
    try {
      const res = await fetch(url, Object.assign({}, options || {}, { signal }));
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function searchWikipedia(query, lang, signal) {
    const url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&utf8=1&format=json&origin=*';
    const data = await fetchJsonWithTimeout(url, { headers: { Accept: 'application/json' } }, FREE_RESEARCH_TIMEOUT_MS, signal).catch(() => null);
    const rows = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
    return rows.slice(0, FREE_RESEARCH_MAX_SOURCES).map((item) => ({
      title: String(item.title || '').trim(),
      snippet: stripHtmlTags(item.snippet || ''),
      lang
    })).filter((item) => item.title);
  }

  async function fetchWikipediaSummary(title, lang, signal) {
    const url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(title || '').replace(/\s+/g, '_'));
    const data = await fetchJsonWithTimeout(url, { headers: { Accept: 'application/json' } }, FREE_RESEARCH_TIMEOUT_MS, signal).catch(() => null);
    if (!data) return null;
    const summary = clipText(data.extract || '', 420);
    const pageUrl = data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page ? data.content_urls.desktop.page : ('https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(String(title || '').replace(/\s+/g, '_')));
    if (!summary) return null;
    return {
      title: String(data.title || title || '').trim(),
      summary,
      url: pageUrl,
      source: 'Wikipedia ' + lang.toUpperCase(),
      lang
    };
  }

  async function collectWikipedia(intent, languages, signal) {
    const sources = [];
    const seen = new Set();
    for (const lang of languages) {
      const hits = await searchWikipedia(intent.query, lang, signal).catch(() => []);
      for (const hit of hits) {
        const key = (hit.title || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const summary = await fetchWikipediaSummary(hit.title, lang, signal).catch(() => null);
        if (summary) {
          sources.push(summary);
        } else if (hit.snippet) {
          sources.push({
            title: hit.title,
            summary: clipText(hit.snippet, 260),
            url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(String(hit.title || '').replace(/\s+/g, '_')),
            source: 'Wikipedia ' + lang.toUpperCase(),
            lang
          });
        }
        if (sources.length >= FREE_RESEARCH_MAX_SOURCES) break;
      }
      if (sources.length >= FREE_RESEARCH_MAX_SOURCES) break;
    }
    return sources;
  }

  // Segunda fuente gratuita: DuckDuckGo Instant Answer (abstract + temas relacionados).
  // Complementa a Wikipedia para definiciones y entidades. Falla suave (CORS/red) sin romper.
  function parseDuckDuckGoResults(data, query) {
    if (!data || typeof data !== 'object') return [];
    const out = [];
    const abstract = clipText(stripHtmlTags(data.AbstractText || data.Abstract || ''), 420);
    if (abstract) {
      out.push({
        title: clipText(stripHtmlTags(data.Heading || query || 'Resultado'), 120),
        summary: abstract,
        url: clipText(data.AbstractURL || '', 220),
        source: 'DuckDuckGo'
      });
    }
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const topic of related) {
      if (out.length >= FREE_RESEARCH_MAX_SOURCES) break;
      const text = topic && topic.Text ? stripHtmlTags(topic.Text) : '';
      if (!text) continue;
      out.push({
        title: clipText(text.split(' - ')[0] || text, 120),
        summary: clipText(text, 300),
        url: clipText(topic.FirstURL || '', 220),
        source: 'DuckDuckGo'
      });
    }
    return out.filter((item) => item.summary);
  }

  async function searchDuckDuckGo(query, signal) {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1&t=lthia';
    const data = await fetchJsonWithTimeout(url, { headers: { Accept: 'application/json' } }, FREE_RESEARCH_TIMEOUT_MS, signal).catch(() => null);
    return parseDuckDuckGoResults(data, query);
  }

  async function runFreeResearch(text, signal) {
    const intent = detectFreeResearchIntent(text);
    if (!intent.matched || !intent.query) return null;
    const languages = intent.lang === 'en' ? ['en', 'es'] : ['es', 'en'];
    // Wikipedia primero (resumenes mas ricos), DuckDuckGo en paralelo para ampliar cobertura.
    const settled = await Promise.allSettled([
      collectWikipedia(intent, languages, signal),
      searchDuckDuckGo(intent.query, signal)
    ]);
    const sources = [];
    const seen = new Set();
    for (const res of settled) {
      const list = res.status === 'fulfilled' && Array.isArray(res.value) ? res.value : [];
      for (const item of list) {
        if (!item || !item.summary) continue;
        const key = normalizeForSearch(item.title) + '|' + normalizeForSearch(item.url);
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(item);
        if (sources.length >= FREE_RESEARCH_MAX_SOURCES) break;
      }
      if (sources.length >= FREE_RESEARCH_MAX_SOURCES) break;
    }
    if (!sources.length) return null;
    return { query: intent.query, freshness: intent.freshness, lang: intent.lang, sources };
  }

  // Capa 3: fecha real del sistema en TODO prompt (no solo web). El modelo no debe
  // asumir el ano desde su entrenamiento ni tratar el presente como futuro.
  function buildTemporalSystemBlock() {
    const now = new Date();
    let iso = '';
    let weekday = '';
    try {
      iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      weekday = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Chicago', weekday: 'long' }).format(now);
    } catch (_) {
      iso = now.toISOString().slice(0, 10);
    }
    return [
      'FECHA Y HORA (usala como verdad; NO asumas el ano desde tu entrenamiento):',
      '- Hoy es ' + iso + (weekday ? ' (' + weekday + ')' : '') + '. Zona horaria del usuario: America/Chicago.',
      '- Interpreta "hoy", "actual", "ahora", "este ano", "ultimo" y fechas relativas con esta fecha.',
      '- Trata cualquier evento anterior a hoy como pasado, nunca como futuro.'
    ].join('\n');
  }

  // Capa 5 (base): honestidad sobre verificacion + manejo de correccion del usuario.
  // Aplica a todos los tiers; es texto, no cambia ruteo ni costo.
  const VERIFY_GUARD_BLOCK = [
    'HONESTIDAD Y CORRECCION:',
    '- No digas "he investigado", "verifique", "segun mis datos verificados" ni "datos confirmados" salvo que en ESTE turno tengas resultados reales de busqueda web. Si no, di claramente: "no pude verificarlo en este entorno".',
    '- No te contradigas sobre tus capacidades entre turnos.',
    '- Si el usuario corrige ("incorrecto", "estas mal", "eso fue el ano pasado", "sigue fallando"): no defiendas tu respuesta anterior, asumela como posiblemente desactualizada y corrige solo ese dato.',
    '- Manten la MISMA entidad/tema del turno anterior al corregir; no cambies de pais, persona o tema salvo que el usuario lo pida. No le pidas al usuario el dato que tu deberias verificar.',
    '- Distingue cargo ACTUAL en funciones de electo o anterior.'
  ].join('\n');

  function composeSystemWithMemory(baseSystem, convo, query) {
    const blocks = [];
    blocks.push(buildTemporalSystemBlock());
    blocks.push(VERIFY_GUARD_BLOCK);
    const brainBlock = buildBrainContextBlock(convo, query);
    const deviceBlock = buildDeviceMemoryRecallBlock(convo, query);
    if (brainBlock) blocks.push(brainBlock);
    if (deviceBlock) blocks.push(deviceBlock);
    return blocks.length ? (baseSystem + '\n\n' + blocks.join('\n\n')) : baseSystem;
  }

  function buildCloudMessages(convo, purpose) {
    const normalized = normalizeConvo(convo);
    const messages = normalized ? normalized.messages : [];
    let sliceSize = 12;
    if (purpose === 'router') sliceSize = 4;
    else if (purpose === 'pdf') sliceSize = 8;
    else if (purpose === 'reasoning') sliceSize = 10;
    else if (purpose === 'memory') sliceSize = normalized && normalized.brain && normalized.brain.running_summary ? 8 : 12;
    else if (normalized && normalized.brain && normalized.brain.running_summary) sliceSize = 8;
    return messages.slice(-sliceSize).map((m) => ({ role: m.role, content: m.content }));
  }

  function detectCrisisIntent(text) {
    const raw = normalizeWhitespace(text).toLowerCase();
    const patterns = [/\bme quiero matar\b/, /\bquiero suicidarme\b/, /\bquitarme la vida\b/, /\bno quiero vivir\b/, /\bquiero morir\b/, /\bhacerme dano\b/, /\bautolesion/, /\bsuicid/, /\bkill myself\b/, /\bend my life\b/, /\bself harm\b/];
    const hit = patterns.find((rx) => rx.test(raw));
    return { matched: !!hit, pattern: hit ? String(hit) : '', response: CRISIS_RESPONSE_TEXT };
  }

  function markAssistantTurn(convo, text, sourceLabel) {
    const brain = ensureConvoBrain(convo);
    brain.active_task = 'Esperando el siguiente mensaje del usuario.';
    brain.last_known_state = clipText(sourceLabel + ': ' + String(text || ''), 240);
    if (!brain.running_summary) brain.running_summary = clipText(String(text || ''), 320);
    brain.updated_at = Date.now();
    return brain;
  }

  function rememberCurrentArtifact(convo, artifact, stateText) {
    const brain = ensureConvoBrain(convo);
    brain.current_artifact = normalizeArtifact(artifact);
    brain.active_task = 'Dar seguimiento al ultimo archivo generado.';
    brain.last_known_state = clipText(stateText, 240);
    if (!brain.user_goal) brain.user_goal = clipText('Continuar con el archivo actual del chat.', 240);
    if (brain.current_artifact) brain.entities = normalizeEntities([{ type: 'archivo', name: clipText(brain.current_artifact.title || brain.current_artifact.kind, 80), note: brain.current_artifact.kind, updated_at: Date.now() }].concat(brain.entities));
    brain.updated_at = Date.now();
    return brain.current_artifact;
  }

  function markCrisisGuard(convo) {
    const brain = ensureConvoBrain(convo);
    brain.active_task = 'Dar apoyo de crisis con respuesta fija.';
    brain.last_known_state = 'Se activo el guard de crisis en la web.';
    brain.updated_at = Date.now();
    return brain;
  }

  function parseLooseJson(raw) {
    try { return JSON.parse(raw); } catch (_) {}
    try {
      const match = String(raw || '').match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    } catch (_) {
      return {};
    }
  }

  async function maybeUpdateConvoBrain(convo) {
    if (!convo || !convo.id || brainUpdatePending.has(convo.id)) return;
    const brain = ensureConvoBrain(convo);
    const messages = (convo.messages || []).filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && String(msg.content || '').trim());
    const covered = Math.max(0, Number(brain.covered_count || 0) || 0);
    if (messages.length < BRAIN_MIN_MESSAGES || (messages.length - covered) < BRAIN_UPDATE_INTERVAL) return;

    brainUpdatePending.add(convo.id);
    try {
      const recent = buildCloudMessages(convo, 'memory').map((msg) => (msg.role === 'user' ? 'Usuario: ' : 'Asistente: ') + clipText(msg.content, 400)).join('\n');
      const artifact = brain.current_artifact ? ('Artefacto actual: ' + brain.current_artifact.kind + ' "' + brain.current_artifact.title + '"' + (brain.current_artifact.note ? ' | ' + brain.current_artifact.note : '') + '.\n\n') : '';
      const res = await callEdge({
        action: 'chat',
        model: BRAIN_UPDATE_MODEL,
        maxTokens: 420,
        temperature: 0.1,
        system: 'Eres la memoria interna de un chat. Devuelve SOLO JSON valido con estas claves: resumen, objetivo, tarea_activa, reglas, decisiones, estado. Todo en espanol. No inventes datos. No pongas texto fuera del JSON.',
        messages: [{ role: 'user', content: (brain.running_summary ? ('Resumen previo:\n' + brain.running_summary + '\n\n') : '') + artifact + 'Mensajes recientes:\n' + recent }]
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) return;
      const parsed = parseLooseJson(String(data.text || ''));
      const summary = clipText(parsed.resumen, 1100);
      if (!summary) return;
      brain.running_summary = summary;
      if (parsed.objetivo) brain.user_goal = clipText(parsed.objetivo, 240);
      if (parsed.tarea_activa) brain.active_task = clipText(parsed.tarea_activa, 240);
      if (parsed.estado) brain.last_known_state = clipText(parsed.estado, 240);
      if (Array.isArray(parsed.reglas) && parsed.reglas.length) brain.important_rules = uniqueList(parsed.reglas, 8, 160);
      if (Array.isArray(parsed.decisiones) && parsed.decisiones.length) brain.decisions = uniqueList(parsed.decisiones, 8, 160);
      brain.covered_count = messages.length;
      brain.updated_at = Date.now();
      saveConvos();
      syncPushOne(convo).catch(() => {});
    } catch (_) {
    } finally {
      brainUpdatePending.delete(convo.id);
    }
  }


  const memoryStopWords = new Set(['que', 'como', 'para', 'sobre', 'esto', 'esta', 'este', 'estos', 'estas', 'donde', 'cuando', 'quien', 'cual', 'porque', 'por', 'una', 'uno', 'unos', 'unas', 'del', 'las', 'los', 'con', 'sin', 'muy', 'mas', 'más', 'sus', 'mis', 'tus', 'hay', 'aqui', 'ahi', 'ese', 'esa', 'eso', 'fue', 'era', 'ser', 'soy', 'eres', 'somos', 'son', 'the', 'what', 'when', 'where', 'who', 'with', 'from', 'this', 'that']);
  let devicePersistTimer = null;
  let localMemoryDbPromise = null;

  function normalizeForSearch(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function currentUserScopeId() {
    const user = (state.session && state.session.user) || state.user || null;
    if (user && (user.id || user.email)) return String(user.id || user.email);
    return 'guest';
  }

  function scopedLocalKey(baseKey) {
    return baseKey + '__' + currentUserScopeId();
  }

  function convoStoreKey(id, userId) {
    return String(userId || currentUserScopeId()) + '::' + String(id || '');
  }

  function canUseIndexedDb() {
    return typeof indexedDB !== 'undefined' && !!indexedDB && typeof indexedDB.open === 'function';
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function idbTransactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function openLocalMemoryDb() {
    if (!canUseIndexedDb()) return Promise.resolve(null);
    if (localMemoryDbPromise) return localMemoryDbPromise;
    localMemoryDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(LOCAL_MEMORY_DB_NAME, LOCAL_MEMORY_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LOCAL_MEMORY_STORE)) {
          const store = db.createObjectStore(LOCAL_MEMORY_STORE, { keyPath: 'key' });
          store.createIndex('user_id', 'user_id', { unique: false });
          store.createIndex('updated', 'updated', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('No se pudo abrir IndexedDB'));
    }).catch(() => null);
    return localMemoryDbPromise;
  }

  function mergeMessageLists(baseMessages, incomingMessages) {
    const out = [];
    const seen = new Set();
    const pushOne = (msg) => {
      const m = normalizeStoredMessage(msg);
      if (!m) return;
      const key = m.role + '|' + (Number(m.ts) || 0) + '|' + String(m.content || '').slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(m);
    };
    (Array.isArray(baseMessages) ? baseMessages : []).forEach(pushOne);
    (Array.isArray(incomingMessages) ? incomingMessages : []).forEach(pushOne);
    out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    return out;
  }

  function mergeConvoPair(left, right) {
    const a = normalizeConvo(left);
    const b = normalizeConvo(right);
    if (!a) return b;
    if (!b) return a;
    const newer = (Number(a.updated || 0) >= Number(b.updated || 0)) ? a : b;
    const older = newer === a ? b : a;
    return normalizeConvo({
      id: newer.id || older.id,
      title: clipText(newer.title || older.title || 'Chat', 160),
      created: newer.created || older.created || new Date().toISOString(),
      updated: Math.max(Number(a.updated || 0), Number(b.updated || 0), 0),
      messages: mergeMessageLists(older.messages, newer.messages),
      brain: mergeBrain(older.brain, newer.brain),
      // El modo del chat es pegajoso: el servidor no lo guarda, asi que conservamos el
      // modo no-auto de cualquiera de las dos versiones (si no, al sincronizar se perdia).
      mode: [newer.mode, older.mode].find((mm) => mm && mm !== 'auto') || 'auto'
    });
  }

  function mergeConvoCollections(baseList, incomingList) {
    const map = new Map();
    const addOne = (convo) => {
      const normalized = normalizeConvo(convo);
      if (!normalized || !normalized.id) return;
      const existing = map.get(normalized.id);
      map.set(normalized.id, existing ? mergeConvoPair(existing, normalized) : normalized);
    };
    (Array.isArray(baseList) ? baseList : []).forEach(addOne);
    (Array.isArray(incomingList) ? incomingList : []).forEach(addOne);
    return Array.from(map.values()).sort((a, b) => (Number(b.updated || 0) - Number(a.updated || 0)));
  }

  function serializeConvoForCache(convo) {
    const normalized = normalizeConvo(convo);
    if (!normalized) return null;
    return normalizeConvo(Object.assign({}, normalized, { messages: normalized.messages.slice(-HISTORY_LIMIT) }));
  }

  async function loadConvosFromDevice() {
    const userId = currentUserScopeId();
    if (!userId || userId === 'guest') return [];
    const db = await openLocalMemoryDb();
    if (!db) return [];
    try {
      const tx = db.transaction(LOCAL_MEMORY_STORE, 'readonly');
      const store = tx.objectStore(LOCAL_MEMORY_STORE);
      let rows = [];
      if (store.indexNames && store.indexNames.contains('user_id')) {
        rows = await idbRequest(store.index('user_id').getAll(userId)).catch(() => []);
      } else {
        rows = await idbRequest(store.getAll()).catch(() => []);
        rows = rows.filter((row) => row && row.user_id === userId);
      }
      await idbTransactionDone(tx).catch(() => {});
      return (Array.isArray(rows) ? rows : []).map((row) => normalizeConvo(row && row.convo)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  async function persistConvosToDevice(convos) {
    const userId = currentUserScopeId();
    if (!userId || userId === 'guest') return false;
    const db = await openLocalMemoryDb();
    if (!db) return false;
    const list = (Array.isArray(convos) ? convos : []).map(normalizeConvo).filter(Boolean);
    try {
      const tx = db.transaction(LOCAL_MEMORY_STORE, 'readwrite');
      const store = tx.objectStore(LOCAL_MEMORY_STORE);
      for (const convo of list) {
        store.put({ key: convoStoreKey(convo.id, userId), user_id: userId, updated: Number(convo.updated || Date.now()) || Date.now(), convo });
      }
      await idbTransactionDone(tx);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function deleteConvoFromDevice(id) {
    const userId = currentUserScopeId();
    if (!id || !userId || userId === 'guest') return false;
    const db = await openLocalMemoryDb();
    if (!db) return false;
    try {
      const tx = db.transaction(LOCAL_MEMORY_STORE, 'readwrite');
      tx.objectStore(LOCAL_MEMORY_STORE).delete(convoStoreKey(id, userId));
      await idbTransactionDone(tx);
      return true;
    } catch (_) {
      return false;
    }
  }

  function schedulePersistDeviceConvos() {
    if (devicePersistTimer) clearTimeout(devicePersistTimer);
    devicePersistTimer = setTimeout(() => {
      devicePersistTimer = null;
      persistConvosToDevice(state.convos).catch(() => {});
    }, 40);
  }

  function loadCachedConvos() {
    const scopedKey = scopedLocalKey(CONVO_KEY);
    const fallbackKey = CONVO_KEY;
    try {
      const raw = localStorage.getItem(scopedKey);
      const fallback = raw == null ? localStorage.getItem(fallbackKey) : raw;
      const parsed = JSON.parse(fallback || '[]');
      return Array.isArray(parsed) ? parsed.map(normalizeConvo).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  function loadCachedTombstones() {
    const scopedKey = scopedLocalKey(TOMB_KEY);
    const fallbackKey = TOMB_KEY;
    try {
      const raw = localStorage.getItem(scopedKey);
      const fallback = raw == null ? localStorage.getItem(fallbackKey) : raw;
      const parsed = JSON.parse(fallback || '[]');
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (_) {
      return [];
    }
  }

  function tokenizeRecallTerms(text) {
    return normalizeForSearch(text).split(/\s+/).filter((term) => term && term.length >= 3 && !memoryStopWords.has(term)).slice(0, 12);
  }

  function scoreRecallCandidate(message, queryNorm, terms) {
    const contentNorm = normalizeForSearch(message && message.content);
    if (!contentNorm) return 0;
    let score = message && message.role === 'user' ? 2 : 1;
    for (const term of terms) {
      if (contentNorm.includes(term)) score += 4;
    }
    if (/\b(recuerda|recuerdas|antes|dije|hablamos|nombre|apellido|cafe|casa|pdf|imagen|archivo|objetivo|compromiso)\b/.test(queryNorm) && message && message.role === 'user') score += 2;
    if (/\b(nombre|apellido|llamo|soy|prefiero|cafe|casa|pdf|imagen|archivo|recuerdame|meta)\b/.test(contentNorm)) score += 1;
    return score;
  }

  function buildDeviceMemoryRecallBlock(convo, query) {
    const normalized = normalizeConvo(convo);
    const rawQuery = normalizeWhitespace(query);
    if (!normalized || !rawQuery) return '';
    const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
    if (messages.length <= LOCAL_RECALL_RECENT_SKIP) return '';
    const olderMessages = messages.slice(0, Math.max(0, messages.length - LOCAL_RECALL_RECENT_SKIP));
    const queryNorm = normalizeForSearch(rawQuery);
    const terms = tokenizeRecallTerms(rawQuery);
    // Recuerdos por entidad: si la pregunta menciona una entidad por su nombre o por su
    // relacion (ej. "esposa" -> Ana), inyectamos el nombre como termino de busqueda extra.
    const entities = (normalized.brain && Array.isArray(normalized.brain.entities)) ? normalized.brain.entities : [];
    const extraTerms = [];
    for (const ent of entities) {
      const nameNorm = normalizeForSearch(ent.name);
      const noteNorm = normalizeForSearch(ent.note);
      if (!nameNorm) continue;
      if (queryNorm.includes(nameNorm) || (noteNorm && queryNorm.includes(noteNorm))) extraTerms.push(nameNorm);
    }
    const recallTerms = uniqueList(terms.concat(extraTerms), 16, 60);
    const explicitRecall = /\b(recuerda|recuerdas|recorda|antes|dije|hablamos|mi nombre|mi apellido|mi cafe|mi objetivo|pdf|imagen|archivo)\b/.test(queryNorm);
    if (!explicitRecall && terms.length < 2 && !extraTerms.length) return '';
    const ranked = olderMessages.map((msg, index) => ({ msg, index, score: scoreRecallCandidate(msg, queryNorm, recallTerms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.index - a.index))
      .slice(0, LOCAL_RECALL_MAX_SNIPPETS);
    if (!ranked.length) return '';
    const lines = ['MEMORIA LOCAL DEL DISPOSITIVO (fragmentos antiguos relevantes del mismo chat; usalos solo como contexto fiel):'];
    ranked.forEach((item) => {
      lines.push('- ' + (item.msg.role === 'user' ? 'Usuario' : 'Asistente') + ': ' + clipText(item.msg.content, 240));
    });
    lines.push('Si estos fragmentos chocan con el mensaje actual o con la memoria del chat, pide aclaracion breve antes de asumir algo.');
    return lines.join('\n');
  }

  async function deleteConvoEverywhere(id) {
    await deleteConvoFromDevice(id).catch(() => {});
    const token = await ensureToken().catch(() => null);
    if (!token) return;
    const headers = { apikey: SB_KEY, Authorization: 'Bearer ' + token, Prefer: 'return=minimal' };
    const encodedId = encodeURIComponent(String(id || ''));
    await Promise.allSettled([
      fetch(REST_URL + '?id=eq.' + encodedId, { method: 'DELETE', headers }),
      fetch(MEDIA_REST_URL + '?conversation_id=eq.' + encodedId, { method: 'DELETE', headers }),
      fetch(FEEDBACK_REST_URL + '?conversation_id=eq.' + encodedId, { method: 'DELETE', headers })
    ]).catch(() => {});
  }

  window.LTH_IA_TEST_API = { normalizeBrain, extractBrainFromUserMessage, buildBrainContextBlock, detectCrisisIntent, detectFreeSkillIntent, buildFreeSkillSystem, buildFreeSkillClarification, normalizeResearchQuery, detectFreeResearchIntent, buildFreeResearchContextBlock, buildDeviceMemoryRecallBlock, mergeConvoCollections, serializeConvoForCache, extractEntities, detectBrainConflicts, mergeBrain, parseDuckDuckGoResults, detectLiveWebIntent, buildPreviewDoc, withPreviewShim, closePreviewFrame, applyConversationState, buildCategoryGuidance, buildTemporalSystemBlock, composeSystemWithMemory, ensureConvoBrain, reasonStageHtml, CODE_STRUCTURE_PROMPT, CODE_CSS_PROMPT, CODE_POLISH_PROMPT, ORCHESTRATOR_PROMPT, PROGRAM_WIZARD_PROMPT, PROGRAM_CODER_PROMPT, PROGRAM_PATCH_PROMPT, applyProgramPatch, programStepSignature, formatProgramChoice, buildProgramFallbackPlan, looksTrivial, looksLikeNewProgramProject, extractFencedCode, assembleProgramDoc, splitProgramDocParts };

  async function loadConvos() {
    state.convos = loadCachedConvos();
    state.tombstones = loadCachedTombstones();
    const deviceConvos = await loadConvosFromDevice();
    if (deviceConvos.length) state.convos = mergeConvoCollections(state.convos, deviceConvos);
  }
  function saveConvos() {
    try {
      localStorage.setItem(scopedLocalKey(CONVO_KEY), JSON.stringify(state.convos.slice(0, 40).map(serializeConvoForCache).filter(Boolean)));
    } catch (_) {}
    schedulePersistDeviceConvos();
  }
  function saveTombstones() { try { localStorage.setItem(scopedLocalKey(TOMB_KEY), JSON.stringify(state.tombstones.slice(-300))); } catch (_) {} }
  function activeConvo() {
    const convo = state.convos.find((c) => c.id === state.activeId) || null;
    return convo ? normalizeConvo(convo) : null;
  }

  function newConvo() {
    state.activeId = null;
    renderMessages(); renderConvoList(); syncComposerMode(); closeDrawer();
    el.input && el.input.focus();
  }

  function ensureActiveConvo(firstText) {
    let c = activeConvo();
    if (c) return c;
    c = normalizeConvo({ id: uid(), title: (firstText || 'Nuevo chat').slice(0, 48), messages: [], created: new Date().toISOString(), updated: Date.now(), brain: normalizeBrain() });
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
    saveConvos();
    deleteConvoFromDevice(id).catch(() => {});
    renderConvoList(); renderMessages();
    deleteConvoEverywhere(id).catch(() => {});
  }

  async function syncPull() {
    const token = await ensureToken();
    if (!token) return;
    try {
      const res = await fetch(REST_URL + '?select=id,title,messages,brain,source,updated_at&order=updated_at.desc&limit=80', {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token }
      });
      if (!res.ok) return;
      const rows = await res.json().catch(() => []);
      if (!Array.isArray(rows) || !rows.length) return;
      let changed = false;
      for (const row of rows) {
        const id = String(row.id || ''); if (!id) continue;
        if (state.tombstones.includes(id)) continue;
        const remoteMsgs = (Array.isArray(row.messages) ? row.messages : []).map(normalizeStoredMessage).filter(Boolean);
        let c = state.convos.find((x) => x.id === id);
        if (!c) {
          if (!remoteMsgs.length) continue;
          state.convos.push(normalizeConvo({
            id: id,
            title: String(row.title || '').trim() || 'Chat',
            updated: Date.parse(row.updated_at) || Date.now(),
            created: new Date(Number(remoteMsgs[0] && remoteMsgs[0].ts) || Date.now()).toISOString(),
            messages: remoteMsgs,
            brain: normalizeBrain(row.brain)
          }));
          changed = true;
          continue;
        }
        c = normalizeConvo(c);
        const known = new Set(c.messages.map((m) => m.role + '|' + (Number(m.ts) || 0) + '|' + String(m.content || '').slice(0, 60)));
        for (const m of remoteMsgs) {
          const key = m.role + '|' + (Number(m.ts) || 0) + '|' + String(m.content || '').slice(0, 60);
          if (known.has(key)) continue;
          c.messages.push(m);
          known.add(key);
          changed = true;
        }
        c.brain = mergeBrain(c.brain, row.brain);
        c.updated = Math.max(Number(c.updated || 0), Date.parse(row.updated_at) || 0, c.messages.reduce((max, msg) => Math.max(max, Number(msg.ts) || 0), 0));
      }
      if (changed) {
        state.convos.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        saveConvos(); renderConvoList(); if (activeConvo()) renderMessages();
      }
    } catch (_) {}
  }

  async function syncPushOne(convo) {
    if (!convo) return;
    convo = normalizeConvo(convo);
    const token = await ensureToken();
    if (!token) return;
    const row = {
      id: convo.id,
      title: String(convo.title || '').slice(0, 160),
      messages: convo.messages.slice(-120).map((m) => {
        const r = { id: m.id, role: m.role, content: String(m.content || '').slice(0, 20000), ts: m.ts };
        if (Array.isArray(m.media) && m.media.length) r.media = m.media;
        if (m.programDoc) r.programDoc = String(m.programDoc).slice(0, 200000);
        return r;
      }),
      brain: normalizeBrain(convo.brain),
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

  // Etiqueta unica del modelo activo (header + selector). En pago el default es "Auto";
  // nunca mostramos la marca "Mady Canont {Plan}" del servidor para planes de pago.
  function currentModelLabel() {
    const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
    const free = plan === 'free';
    const id = free ? 'free' : (state.manualModel === 'free' ? 'auto' : state.manualModel);
    const m = MANUAL_MODELS[id] || (free ? MANUAL_MODELS.free : MANUAL_MODELS.auto);
    return m.label || 'LTH IA';
  }

  function renderCredits() {
    const c = state.credits;
    el.modelLabel.textContent = currentModelLabel();
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

  // El razonamiento ya no tiene usos semanales (se cobra por tokens). Solo cargamos la
  // config de modelos por etapa (editable en admin) para reasonModel().
  async function fetchReasonStatus() {
    try {
      const res = await callEdge({ action: 'reason-status' });
      const data = await res.json().catch(() => ({}));
      if (data && data.reasoningModels && typeof data.reasoningModels === 'object') state.reasonModels = data.reasoningModels;
    } catch (_) {}
  }

  // Modelo configurado para una etapa del razonamiento (editable en admin); fallback al default.
  function reasonModel(stage, fallback) {
    const cfg = state.reasonModels && state.reasonModels[stage];
    const m = cfg && typeof cfg.model === 'string' ? cfg.model.trim() : '';
    return m || fallback;
  }

  function renderConvoList() {
    if (!el.convoList) return;
    if (!state.convos.length) { el.convoList.innerHTML = '<div style="padding:18px;color:var(--text-dim);font-size:12px;text-align:center;">Sin conversaciones todavia.</div>'; return; }
    el.convoList.innerHTML = '';
    for (const c of state.convos) {
      const last = c.messages[c.messages.length - 1];
      const sub = last ? String(last.content).replace(/\s+/g, ' ').slice(0, 30) : 'vacio';
      const item = document.createElement('div');
      const isProgram = c.mode === 'program';
      item.className = 'convo-item' + (isProgram ? ' is-program' : '') + (c.id === state.activeId ? ' on' : '');
      const badge = isProgram ? '<span class="ci-badge">⌨ Programación</span>' : '';
      item.innerHTML = '<div class="ci-title"><span class="ci-name">' + escapeHtml(c.title || 'Chat') + '</span>' + badge + '</div>' +
        '<div class="ci-sub"><span>' + escapeHtml(sub) + '</span><span class="ci-del" data-del="1">borrar</span></div>';
      item.addEventListener('click', (e) => {
        if (e.target && e.target.getAttribute('data-del')) { e.stopPropagation(); deleteConvo(c.id); return; }
        state.activeId = c.id; renderConvoList(); renderMessages(); syncComposerMode(); closeDrawer();
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
      const html = m.role === 'user' ? escapeHtml(m.content).replace(/\n/g, '<br>') : renderMarkdown(m.content, { preview: true });
      const node = bubbleEl(m.role, html);
      // Pagina de Programar: la Vista previa se arma del doc adjunto (no del markdown).
      if (m.role === 'assistant' && m.programDoc) node.bub.innerHTML += buildPreviewBlockHtml(m.programDoc);
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
    convo.brain = extractBrainFromUserMessage(convo.brain, text);
    convo.updated = Date.now();
    if (convo.messages.length === 1) convo.title = text.slice(0, 48);
    saveConvos();
    if (!activeConvo() || el.messages.querySelector('.welcome')) renderMessages();
    else el.messages.appendChild(bubbleEl('user', escapeHtml(text).replace(/\n/g, '<br>')).wrap);
    renderConvoList();
    el.input.value = ''; autoGrow();
    scrollDown();

    const crisis = detectCrisisIntent(text);
    if (crisis.matched) {
      markCrisisGuard(convo);
      const replyText = crisis.response;
      convo.messages.push({ id: uid(), role: 'assistant', content: replyText, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo);
      return;
    }

    // Chat DEDICADO a Programar: cada mensaje edita/charla sobre la pagina (no chat normal),
    // asi no se manda el HTML gigante a un modelo barato ni se mezclan modos.
    if (convo.mode === 'program') {
      await programFollowup(convo, text);
      return;
    }

    // Programar prepara primero un prompt maestro breve y luego la misma IA crea el HTML.
    if (state.programMode) {
      setBusy(true); state.abort = new AbortController();
      try { await openProgramWizard(text, convo); }
      catch (_) {}
      finally { setBusy(false); state.abort = null; }
      return;
    }

    const wantImage = looksLikeImageRequest(text);
    const wantPdf = !wantImage && looksLikePdfRequest(text);
    if ((wantImage || wantPdf) && !canUsePremium()) {
      const what = wantImage ? 'La generacion de imagenes' : 'La generacion de PDF';
      const note = what + ' es del plan **Pro**. Con tu plan actual puedo ayudarte con texto; mejora a Pro para desbloquearlo.';
      markAssistantTurn(convo, note, 'Restriccion del plan');
      convo.messages.push({ id: uid(), role: 'assistant', content: note, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo);
      void maybeUpdateConvoBrain(convo);
      return;
    }

    const { wrap, bub } = bubbleEl('ai',
      wantImage ? '<span class="gen-img-loading">Generando imagen<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
        : wantPdf ? '<span class="gen-img-loading">Preparando PDF<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
          : state.engine === 'os' ? '<span class="gen-img-loading">Motor LTH OS pensando<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>'
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
      if (state.engine === 'os') {
        const ok = await askPcEngine(text, convo, bub);
        if (ok) return;
        bub.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      }
      if ((state.reasoning || convo.mode === 'reason') && canUsePremium()) {
        if (convo.mode !== 'reason') { convo.mode = 'reason'; saveConvos(); syncComposerMode(); }
        await reasoningAnswer(text, convo, bub);
        return;
      }

      const manual = (state.manualModel !== 'auto' && state.manualModel !== 'free') ? MANUAL_MODELS[state.manualModel] : null;
      const manualAllowed = manual && (!manual.premium || canUsePremium());
      const createOn = state.createMode || convo.mode === 'create';
      // Charla trivial (saludo/agradecimiento): se salta el clasificador y la memoria para
      // no gastar llamadas extra en algo como "hola". No aplica a manual ni a "Crear algo".
      const trivial = !createOn && looksTrivial(text);
      const trivialAuto = trivial && !manualAllowed && canUsePremium();
      let routeOpts = null;
      let freeSkill = null;
      if (manual && !manualAllowed) {
        setComposerHint('Ese modelo es de un plan de pago. Usando modo automatico.');
        state.manualModel = 'auto'; renderModelBar();
      }
      if (manualAllowed && manual.image) {
        await generateImage(text, convo, wrap, bub);
        return;
      }
      if (manualAllowed) {
        routeOpts = { model: manual.model, maxTokens: manual.maxTokens, temperature: manual.temperature, reasoning: manual.reasoning };
        bub.innerHTML = engineThinkingHtml('premium');
      } else {
        // Trivial: responde directo con el modelo barato (sin clasificador).
        if (trivialAuto) {
          const cheap = window.LTHRouter && window.LTHRouter.MODEL_CONFIG ? window.LTHRouter.MODEL_CONFIG.tiers.cheap : null;
          if (cheap) { routeOpts = { model: cheap.primary, maxTokens: cheap.maxTokens, temperature: cheap.temperature, reasoning: cheap.reasoning }; bub.innerHTML = engineThinkingHtml('cheap'); }
        }
        const route = trivialAuto ? null : await autoRoute(text, convo);
        if (route && route.action === 'block') {
          const msg = 'No puedo ayudar con esa solicitud.';
          bub.innerHTML = renderMarkdown(msg);
          markAssistantTurn(convo, msg, 'Bloqueo del router');
          convo.messages.push({ id: uid(), role: 'assistant', content: msg, ts: Date.now() });
          convo.updated = Date.now(); saveConvos(); renderConvoList(); syncPushOne(convo);
          void maybeUpdateConvoBrain(convo);
          return;
        }
        if (route && route.tier === 'image') {
          await generateImage(text, convo, wrap, bub);
          return;
        }
        if (route) routeOpts = { model: route.model, maxTokens: route.maxTokens, temperature: route.temperature, reasoning: route.reasoning, system: route.system };
        if (route && route.tier) bub.innerHTML = engineThinkingHtml(route.tier);
        if (!routeOpts && isFreePlan()) {
          const researchIntent = detectFreeResearchIntent(text);
          if (researchIntent.matched) {
            bub.innerHTML = engineThinkingHtml('web');
            const research = await runFreeResearch(text, state.abort && state.abort.signal);
            if (research && research.sources && research.sources.length) {
              routeOpts = { system: buildFreeResearchSystem(SYSTEM_PROMPT, research) };
            }
          }
          if (!routeOpts) {
            freeSkill = detectFreeSkillIntent(text, convo);
            const clarification = buildFreeSkillClarification(freeSkill);
            if (clarification) {
              bub.innerHTML = renderMarkdown(clarification);
              markAssistantTurn(convo, clarification, 'Aclaracion de habilidad free');
              convo.messages.push({ id: uid(), role: 'assistant', content: clarification, ts: Date.now() });
              convo.updated = Date.now(); saveConvos(); renderConvoList(); syncPushOne(convo);
              void maybeUpdateConvoBrain(convo);
              return;
            }
            if (freeSkill) {
              routeOpts = { system: buildFreeSkillSystem(SYSTEM_PROMPT, freeSkill) };
              bub.innerHTML = engineThinkingHtml(freeSkill.tier || 'standard');
            }
          }
        }
      }

      // Modo "Crear algo": fuerza salida HTML autocontenida (visualizable) en cualquier ruta.
      if (createOn) {
        routeOpts = routeOpts || {};
        routeOpts.system = ((routeOpts && routeOpts.system) || SYSTEM_PROMPT) + '\n\n' + CREATE_SYSTEM;
        if (convo.mode !== 'create') { convo.mode = 'create'; syncComposerMode(); }
      }

      let started = false;
      const result = await streamChat(convo, text, (full) => {
        if (!started) { started = true; bub.classList.add('cursor'); }
        bub.innerHTML = renderMarkdown(full);
        bub.classList.add('cursor');
        scrollDown();
      }, state.abort.signal, routeOpts);

      bub.classList.remove('cursor');
      const finalText = result.text || '';
      bub.innerHTML = renderMarkdown(finalText || '_(sin respuesta)_', { preview: true });
      const assistantMsg = { id: uid(), role: 'assistant', content: finalText, ts: Date.now() };
      markAssistantTurn(convo, finalText, 'Respuesta web');
      convo.messages.push(assistantMsg);
      if (finalText.trim()) appendFeedback(bub, assistantMsg, convo);
      convo.updated = Date.now();
      saveConvos(); renderConvoList();
      syncPushOne(convo);
      fetchStatus();
      if (!trivial) void maybeUpdateConvoBrain(convo);
    } catch (err) {
      bub.classList.remove('cursor');
      wrap.remove();
      if (err && err.name === 'AbortError') {
        const partial = bub.textContent || '';
        if (partial.trim()) {
          markAssistantTurn(convo, partial, 'Respuesta interrumpida');
          convo.messages.push({ id: uid(), role: 'assistant', content: partial, ts: Date.now() });
        }
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

  function isFreePlan() {
    return String((state.credits && state.credits.plan) || 'free').toLowerCase() === 'free';
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
        if (capEl) capEl.textContent = '🗑ï¸ Imagen expirada (se borran a las 24 h)';
      }
    } catch (_) {}
  }

  async function generateImage(prompt, convo, wrap, bub, reasonStage) {
    const res = await callEdge({
      action: 'chat',
      model: IMAGE_MODEL,
      routerMode: 'image',
      routerHint: 'image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '1:1', image_size: '1K' },
      maxTokens: 1200,
      temperature: 0.5,
      reasonStage: reasonStage === true,
      system: composeSystemWithMemory(IMAGE_SYSTEM_PROMPT, convo, prompt),
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
      markAssistantTurn(convo, txt, 'Imagen sin salida');
      convo.messages.push({ id: uid(), role: 'assistant', content: txt, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      void maybeUpdateConvoBrain(convo);
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

    const replyText = caption || 'Aqui tienes tu imagen.';
    rememberCurrentArtifact(convo, { kind: 'image', id: media[0] && media[0].id, title: prompt, note: caption || prompt }, 'Se genero una imagen para el chat.');
    convo.messages.push({ id: uid(), role: 'assistant', content: replyText, media: media, ts: Date.now() });
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
    void maybeUpdateConvoBrain(convo);
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
      if (!data) { note.textContent = '🗑ï¸ PDF expirado (se borran a las 24 h)'; return; }
      openData(data);
    });
    dl.addEventListener('click', async () => {
      const data = await fetchMediaData(item.id);
      if (!data) { note.textContent = '🗑ï¸ PDF expirado (se borran a las 24 h)'; return; }
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
    let userMsgId = ''; let userMsgText = '';
    const idx = convo.messages.indexOf(message);
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (convo.messages[i] && convo.messages[i].role === 'user') {
        userMsgId = String(convo.messages[i].id || '');
        userMsgText = String(convo.messages[i].content || '');
        break;
      }
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
          user_message: userMsgText.slice(0, 30000),
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
    const history = buildCloudMessages(convo, 'pdf');
    const res = await callEdge({ action: 'chat', feature: 'pdf', maxTokens: 4000, system: composeSystemWithMemory(PDF_SYSTEM_PROMPT, convo, prompt), messages: history }, state.abort && state.abort.signal);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(data.error || 'No se pudo generar el documento.', data.status || res.status, data.credits);
    }
    const docText = String(data.text || '').trim();
    if (!docText) {
      const emptyMsg = 'No pude generar el documento esta vez. Dame mas detalle de lo que quieres en el PDF.';
      markAssistantTurn(convo, emptyMsg, 'PDF vacio');
      convo.messages.push({ id: uid(), role: 'assistant', content: emptyMsg, ts: Date.now() });
      convo.updated = Date.now(); saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      void maybeUpdateConvoBrain(convo);
      return;
    }
    const title = derivePdfTitle(prompt, docText);
    let dataUri;
    try { dataUri = buildPdfFromText(title, docText); }
    catch (_) {
      markAssistantTurn(convo, docText, 'PDF texto');
      convo.messages.push({ id: uid(), role: 'assistant', content: docText, ts: Date.now() });
      convo.updated = Date.now(); saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
      void maybeUpdateConvoBrain(convo);
      return;
    }
    const stored = await storeMedia({ convoId: convo.id, kind: 'pdf', mime: 'application/pdf', title, prompt, src: dataUri });
    const id = stored && stored.id ? stored.id : ('local_' + uid());
    mediaCache[id] = dataUri;
    rememberCurrentArtifact(convo, { kind: 'pdf', id: id, title: title, note: clipText(docText, 220) }, 'Se genero un PDF para el chat.');
    convo.messages.push({ id: uid(), role: 'assistant', content: 'Aqui tienes tu PDF: **' + title + '**.', media: [{ id: id, kind: 'pdf', mime: 'application/pdf', title: title }], ts: Date.now() });
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
    void maybeUpdateConvoBrain(convo);
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
      bub.innerHTML = '<span class="gen-img-loading">Motor LTH OS pensando<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>';
      const row = await sendOsCommand('ia-ask', { convoId: convo.id, text }, 165000);
      if (!row || row.status !== 'done') {
        if (row && row.status === 'denied') { state.engine = 'web'; persistEngine(); stopEnginePresence(); }
        state.osConnected = false; renderEngineBadge();
        return false;
      }
      const answer = String((row.result || {}).text || '').trim();
      if (!answer) { state.osConnected = false; renderEngineBadge(); return false; }
      bub.classList.remove('cursor');
      bub.innerHTML = renderMarkdown(answer, { preview: true });
      const webMsg = { id: uid(), role: 'assistant', content: answer, ts: Date.now() };
      markAssistantTurn(convo, answer, 'Respuesta del motor LTH OS');
      convo.messages.push(webMsg);
      if (answer.trim()) appendFeedback(bub, webMsg, convo);
      convo.updated = Date.now();
      saveConvos(); renderConvoList(); syncPushOne(convo); fetchStatus();
      state.osConnected = true; renderEngineBadge();
      void maybeUpdateConvoBrain(convo);
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
  // Deteccion determinista de "necesita internet en vivo" (precios, noticias, clima,
  // actualidad). El clasificador LLM falla con frases cortas como "cuanto esta el bitcoin",
  // asi que esto FUERZA el tier web (perplexity/sonar) sin depender del modelo barato.
  function detectLiveWebIntent(text) {
    const raw = normalizeForSearch(text);
    if (!raw) return false;
    if (/\b(precio|precios|cotizacion|cotiza|tipo de cambio|a cuanto|cuanto (cuesta|vale|esta|anda)|valor (de|del|actual))\b/.test(raw)) return true;
    if (/\b(bitcoin|btc|ethereum|eth|dolar|euro|peso|cripto|criptomoneda|accion|acciones|bolsa|nasdaq|sp500)\b/.test(raw) && /\b(cuanto|precio|vale|esta|cotiza|valor|hoy|ahora|cambio)\b/.test(raw)) return true;
    if (/\b(noticias?|que paso|ultima hora|ultimas noticias|hoy|esta semana|actualmente|en este momento|ahora mismo|reciente|recientes|ultimo lanzamiento|version mas nueva|que hay de nuevo)\b/.test(raw)) return true;
    if (/\b(clima|el tiempo en|pronostico|temperatura en|resultado|marcador|quien gano|quien va ganando)\b/.test(raw)) return true;
    if (/\b(busca en internet|buscar en internet|investiga|googlea|en la web|busca informacion)\b/.test(raw)) return true;
    return false;
  }

  function forcedWebRoute(R, plan) {
    return R.chooseModel(R.validateDecision({ category: 'business', target_tier: 'standard', needs_web: true, confidence: 0.9 }, { manualMode: 'auto' }), { userPlan: plan, manualMode: 'auto' });
  }

  // Capa 4: actualiza el estado de la conversacion (entidad activa, estudio biblico,
  // modo creador) de forma determinista a partir de la decision del clasificador.
  function applyConversationState(convo, text, decision) {
    if (!convo || !decision) return;
    const brain = ensureConvoBrain(convo);
    let changed = false;
    const ents = Array.isArray(decision.entities_mentioned) ? decision.entities_mentioned : [];
    if (ents.length === 1) {
      // Un solo referente claro -> se vuelve la entidad activa (anti-deriva en correcciones).
      brain.active_entity = { name: clipText(ents[0], 80), kind: decision.needs_temporal_check ? 'actualidad' : '', updated_at: Date.now() };
      changed = true;
    } else if (ents.length === 0 && decision.correction_detected && brain.active_entity) {
      // Correccion sin entidad nueva: conserva la activa (no saltar de USA a Honduras).
      brain.active_entity.updated_at = Date.now();
      changed = true;
    }
    if (decision.biblical_ref && decision.biblical_ref.book) {
      brain.active_study = {
        book: clipText(decision.biblical_ref.book, 60),
        chapter: clipText(decision.biblical_ref.chapter, 12),
        verses: clipText(decision.biblical_ref.verses, 24),
        version: (brain.active_study && brain.active_study.version) || '',
        focus: (brain.active_study && brain.active_study.focus) || ''
      };
      changed = true;
    }
    if (decision.creator_mode && !brain.creator_mode) { brain.creator_mode = true; changed = true; }
    if (changed) { brain.updated_at = Date.now(); try { saveConvos(); } catch (_) {} }
  }

  // Capa 5: instrucciones por categoria (no son llamadas nuevas; afinan la respuesta).
  function buildCategoryGuidance(decision, convo) {
    if (!decision) return '';
    const frags = [];
    if (decision.needs_web) {
      // Lo PRIMERO en toda busqueda: anclar la fecha absoluta antes de buscar y responder,
      // si no "hoy" le queda ambiguo al buscador y trae eventos que no son de hoy.
      frags.push('ANCLA TEMPORAL (PASO 1, antes de buscar y de responder): parte de la fecha de hoy indicada arriba y convierte "hoy", "manana", "ayer", "este fin", "esta semana" o "este mes" a su fecha ABSOLUTA (dia, mes y ano). Incluye esa fecha absoluta en la busqueda. Decide si el hecho YA PASO o ESTA POR PASAR respecto a hoy antes de afirmar nada. Si los resultados no corresponden a la fecha de hoy (o son de otro ano), descartalos y vuelve a buscar con la fecha absoluta. Nunca trates un evento anterior a hoy como "proximo" ni uno futuro como "ya ocurrido".');
      frags.push('FRONTERA DE DIA ESTRICTA: si el usuario pide lo de "hoy", incluye UNICAMENTE eventos cuya fecha sea EXACTAMENTE hoy en la zona del usuario (America/Chicago) y EXCLUYE los de manana o ayer, aunque la fuente los liste juntos en el mismo bloque. Verifica la fecha de CADA item por separado antes de incluirlo; un horario que cae despues de medianoche en la zona del usuario pertenece a otro dia. Ante la duda de un item, indica su fecha en vez de asumir que es de hoy.');
    }
    if (decision.needs_web && decision.multi_entity && decision.entities_mentioned.length) {
      frags.push('VERIFICACION MULTI-ENTIDAD: la consulta menciona varias entidades. En UNA sola busqueda resuelve CADA UNA por separado: ' + decision.entities_mentioned.join(', ') + '. Da el dato/cargo ACTUAL de cada una con su fecha (ej. toma de posesion). Descarta cualquier dato anterior al ultimo cambio. No mezcles datos correctos con viejos; si una no se verifica, dilo. No hagas una busqueda por entidad: una sola bien armada.');
    } else if (decision.needs_web) {
      frags.push('DATO EN VIVO: responde con el dato ACTUAL y la fecha de consulta. Precios: una cifra principal en USD con hora aproximada, aclara que varia por exchange. Deportes: usa la fecha absoluta de hoy y la zona del usuario, manten torneo/seleccion del contexto y nunca traigas resultados de anos anteriores como si fueran el "proximo" o "actual".');
    }
    if (decision.needs_web) {
      // El modelo tiende a completar listas (ej. partidos) con datos inventados de memoria.
      // Sonar ya devuelve resultados reales con enlaces: obligar a atar cada dato a su
      // fuente y a cerrar con la lista de URLs. Un dato sin fuente no se muestra.
      frags.push('SOLO LO COMPROBADO + FUENTES OBLIGATORIAS (PASO FINAL antes de enviar): cada dato factual (cada partido, precio, lider, fecha) debe provenir de una fuente recuperada en ESTA busqueda. Si un dato NO tiene fuente real, NO lo incluyas; nada de completar la lista de memoria o "por intuicion". Revisa item por item y elimina lo que no puedas respaldar. Marca los datos clave con su fuente y TERMINA con una seccion "Fuentes:" listando los enlaces (URL) que realmente usaste. No inventes URLs: si no tienes el enlace, no afirmes el dato. Si solo confirmaste parte, dilo ("confirme N; podrian faltar o sobrar") en vez de rellenar. Si las fuentes se contradicen, senalalo; no promedies inventando. Prefiero una lista corta con fuentes a una larga sin respaldo.');
    }
    if (decision.local_retail) {
      frags.push('COMPRA LOCAL/RETAIL: tratalo como decision de compra real, no charla. Normaliza el producto (ej. "2x4" -> "2x4x8 sin tratar" salvo que el usuario indique otra medida o tratamiento) y la tienda (homedepoot/home/HD -> Home Depot). Usa la ciudad del usuario si la dio. Si el usuario menciono un precio real que vio, usalo como referencia principal por encima de cualquier rango generico. Cierra con recomendacion accionable: opcion economica, balanceada y profesional. Para contratista prioriza durabilidad, garantia y un mismo ecosistema de baterias.');
    }
    if (decision.biblical_ref) {
      frags.push('ESTUDIO BIBLICO: primero cita el TEXTO EXACTO del pasaje pedido; si no estas segura de la version, declara "Uso RVR1960 salvo que prefieras otra". Estructura: "El texto dice" / "Interpretacion principal" / "Postura pentecostal comun" / "Otras posturas fuertes". No presentes una interpretacion debatida como la UNICA postura pentecostal; expresa grados de confianza. Manten el pasaje en curso (memoria de estudio activo); tono pastoral pero preciso, sin sobreafirmar especulacion.');
    }
    if (decision.creator_mode || (convo && convo.brain && convo.brain.creator_mode)) {
      frags.push('MODO CREADOR: el usuario es el creador/desarrollador. Tono tecnico de diagnostico, sin adulacion. Si reporta un fallo: resume el bug, su causa probable y pasos de reproduccion; pide logs solo si faltan.');
    }
    return frags.join('\n\n');
  }

  // Detector de charla trivial (saludo/agradecimiento/ack puro). Conservador: solo si
  // TODAS las palabras son de saludo/relleno, es corto y NO hay pregunta. Excluye
  // correcciones ("no", "incorrecto", "mal") para no romper el ruteo a web del fix temporal.
  const TRIVIAL_WORDS = new Set([
    'hola', 'hola', 'holaa', 'holaaa', 'holi', 'holis', 'ola', 'hey', 'ey', 'buenas', 'buenos', 'buen',
    'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'que', 'tal', 'onda', 'hubo', 'como', 'estas',
    'esta', 'va', 'andas', 'saludos', 'gracias', 'muchas', 'mil', 'ok', 'oka', 'okay', 'okey', 'vale',
    'listo', 'perfecto', 'genial', 'excelente', 'de', 'acuerdo', 'entendido', 'adios', 'chao', 'chau',
    'bye', 'hasta', 'luego', 'pronto', 'nos', 'vemos', 'jaja', 'jeje', 'jiji', 'mady', 'ia', 'tu', 'y'
  ]);
  function looksTrivial(text) {
    const raw = normalizeForSearch(text);
    if (!raw) return false;
    if (/[?¿]/.test(String(text || ''))) return false;
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 5) return false;
    return words.every((w) => TRIVIAL_WORDS.has(w));
  }

  async function autoRoute(text, convo) {
    const R = window.LTHRouter;
    const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
    if (!R || !['pro', 'studio', 'ultra'].includes(plan)) return null;
    const forceWeb = detectLiveWebIntent(text);
    try {
      const brainBlock = buildBrainContextBlock(convo, text);
      const input = R.buildClassifierInput({
        userMessage: brainBlock ? (brainBlock + '\n\nMENSAJE ACTUAL DEL USUARIO:\n' + text) : text,
        history: buildCloudMessages(convo, 'router').slice(-4),
        userPlan: plan,
        manualMode: 'auto'
      });
      const res = await callEdge({
        action: 'chat',
        model: R.MODEL_CONFIG.router.model,
        maxTokens: R.MODEL_CONFIG.router.maxTokens,
        temperature: 0,
        response_format: R.MODEL_CONFIG.router.responseFormat,
        system: composeSystemWithMemory(R.getClassifierPrompt(), convo, text),
        messages: [{ role: 'user', content: input }]
      }, state.abort && state.abort.signal);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) return forceWeb ? forcedWebRoute(R, plan) : null;
      let raw = {};
      try { const m = String(data.text || '').match(/\{[\s\S]*\}/); raw = m ? JSON.parse(m[0]) : {}; } catch (_) { raw = {}; }
      const decision = R.validateDecision(raw, { manualMode: 'auto' });
      // Override en vivo: si claramente pide datos actuales, gana la ruta web aunque el
      // clasificador la haya mandado a standard/premium (pero respeta codigo/imagen/bloqueo).
      if (forceWeb && decision.category !== 'image_generation' && decision.category !== 'image_editing' && decision.category !== 'code' && decision.category !== 'debug' && decision.target_tier !== 'blocked') {
        decision.needs_web = true;
        if (decision.target_tier === 'premium') decision.target_tier = 'standard';
        if (decision.category === 'reasoning' || decision.category === 'app_architecture') decision.category = 'business';
      }
      applyConversationState(convo, text, decision);
      const route = R.chooseModel(decision, { userPlan: plan, manualMode: 'auto' });
      if (route && route.action !== 'block') {
        const guidance = buildCategoryGuidance(decision, convo);
        if (guidance) route.system = SYSTEM_PROMPT + '\n\n' + guidance;
      }
      return route;
    } catch (_) { return forceWeb ? forcedWebRoute(R, plan) : null; }
  }

  function engineThinkingHtml(tier) {
    const map = { code: '💻 Programando', premium: '🧠 Razonando', web: '🌐 Buscando en la web', files: '📎 Analizando', standard: '✦ Pensando', cheap: '✦ Escribiendo' };
    return '<span class="gen-img-loading">' + (map[tier] || '✦ Pensando') + '<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>';
  }

  /* ─────────── Barra de modelos (selector manual) ─────────── */
  let composerHintTimer = null;
  function setComposerHint(msg) {
    if (!el.composerHint) return;
    const original = 'LTH IA puede equivocarse. Verifica información importante.';
    el.composerHint.textContent = msg;
    if (composerHintTimer) clearTimeout(composerHintTimer);
    composerHintTimer = setTimeout(() => { if (el.composerHint) el.composerHint.textContent = original; }, 4000);
  }
  function renderModelBar() {
    const plan = String((state.credits && state.credits.plan) || 'free').toLowerCase();
    const free = plan === 'free';
    // Modo automatico segun plan:
    //  - Free: se llama "Mady Canont Free" (su unico modelo permitido).
    //  - Pago: se llama "Auto" (el router elige el mejor modelo, incl. busqueda web via Sonar).
    MANUAL_MODELS.free.label = 'Mady Canont Free';
    if (free) state.manualModel = 'free';
    else if (state.manualModel === 'free') state.manualModel = 'auto';
    const cur = MANUAL_MODELS[state.manualModel] || (free ? MANUAL_MODELS.free : MANUAL_MODELS.auto);
    if (el.modelPickerLabel) el.modelPickerLabel.textContent = cur.label;
    if (el.modelLabel) el.modelLabel.textContent = cur.label;
    if (el.modelMenu) {
      el.modelMenu.querySelectorAll('[data-model]').forEach((b) => {
        const id = b.getAttribute('data-model');
        // 'free' (Mady Canont Free) solo en plan free; 'auto' (Auto) solo en planes de pago.
        b.hidden = free ? (id !== 'free') : (id === 'free');
        b.classList.toggle('on', id === state.manualModel);
      });
    }
  }
  // Banner de upsell a Plan Pro (cuando un usuario free toca algo premium).
  function showProModal(context) {
    if (!el.proModal) return;
    if (el.proSub) {
      el.proSub.innerHTML = context === 'reasoning'
        ? 'El <b>Modo Razonamiento</b> es del <b>plan Pro</b>. Cámbiate y deja que un experto + un juez verifiquen cada respuesta.'
        : context === 'model'
          ? 'Ese <b>modelo</b> es del <b>plan Pro</b>. Desbloquéalo y elige el motor que quieras.'
          : 'Esta función es del <b>plan Pro</b>. Cámbiate y obtén lo mejor de LTH IA.';
    }
    el.proModal.hidden = false;
  }
  function closeProModal() { if (el.proModal) el.proModal.hidden = true; }

  // Tema claro / oscuro (por defecto oscuro). Aplica a toda la app y se recuerda.
  function applyTheme(theme) {
    const light = theme === 'light';
    document.body.classList.toggle('light', light);
    if (el.themeSeg) el.themeSeg.querySelectorAll('[data-theme]').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-theme') === (light ? 'light' : 'dark'));
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#eef0f8' : '#02060a');
    try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (_) {}
  }

  function openModelMenu() {
    if (!el.modelMenu) return;
    el.modelMenu.hidden = false;
    el.modelPickerBtn.setAttribute('aria-expanded', 'true');
  }
  function closeModelMenu() {
    if (!el.modelMenu) return;
    el.modelMenu.hidden = true;
    el.modelPickerBtn.setAttribute('aria-expanded', 'false');
  }

  /* ─────────── Modo razonamiento (skill -> resolver -> verificar) ─────────── */
  function persistReason() { try { localStorage.setItem(REASON_KEY, state.reasoning ? '1' : '0'); } catch (_) {} }
  function renderReasonBtn() {
    if (!el.reasonBtn) return;
    el.reasonBtn.classList.toggle('on', !!state.reasoning);
    el.reasonBtn.setAttribute('aria-pressed', state.reasoning ? 'true' : 'false');
    el.reasonBtn.title = 'Modo razonamiento (Pro) · se cobra por tokens';
  }

  function renderCreateBtn() {
    if (!el.createBtn) return;
    el.createBtn.classList.toggle('on', !!state.createMode);
    el.createBtn.setAttribute('aria-pressed', state.createMode ? 'true' : 'false');
  }

  // Cada chat queda dedicado a un modo (program/reason/create) una vez usado. Esto bloquea
  // los otros chips para no mezclar modos en el mismo chat.
  function syncComposerMode() {
    const convo = activeConvo();
    const mode = (convo && convo.mode) || 'auto';
    const lock = mode !== 'auto';
    const apply = (btn, isActive, globalOn) => {
      if (!btn) return;
      btn.disabled = lock && !isActive;            // los OTROS chips quedan deshabilitados
      btn.classList.toggle('mode-locked-on', lock && isActive); // el del modo: activo, no clickeable
      btn.classList.toggle('on', lock ? isActive : !!globalOn);
    };
    apply(el.reasonBtn, mode === 'reason', state.reasoning);
    apply(el.programBtn, mode === 'program', state.programMode);
    apply(el.createBtn, mode === 'create', state.createMode);
    if (el.modelPickerBtn) { el.modelPickerBtn.disabled = lock; el.modelPickerBtn.classList.toggle('locked', lock); }
  }

  // Instrucciones inyectadas cuando "Crear algo" esta activo: forzar HTML autocontenido.
  const CREATE_SYSTEM = 'El usuario activo el modo CREAR. Genera lo que pide como una pagina o mini-app web COMPLETA y AUTOCONTENIDA: entrega UN solo bloque ```html con el documento entero (incluye el CSS dentro de <style> y el JS dentro de <script> en el mismo archivo). Debe verse bien y funcionar al renderizarse en un iframe. NAVEGACION SEGURA (obligatoria): la pagina es de UNA sola pantalla. Cada seccion lleva su id (<section id="inicio">, <section id="contacto">) y los enlaces del menu apuntan a ese id con hash (<a href="#inicio">). NUNCA uses href="/", "/login", "/home", "/auth", "index.html" ni rutas relativas. Los botones de accion son <button type="button"> y, si llevan a una seccion, usan onclick con scroll interno (onclick="document.querySelector(\'#top-comidas\').scrollIntoView({behavior:\'smooth\'})"); NUNCA uses location.href, location.assign ni window.location para navegar. No uses recursos externos que requieran clave. Da una frase breve antes del codigo y nada de explicaciones largas.';

  function reasonStageHtml(stage) {
    const map = {
      orchestrate: 'Entendiendo tu pedido',
      codigo: 'Programando la solución',
      code_structure: 'Armando la estructura',
      code_css: 'Diseñando el estilo (CSS)',
      code_js: 'Programando interacciones (JS)',
      code_assemble: 'Armando el documento final',
      code_polish: 'Puliendo y armando todo',
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

  // Extrae el codigo de un bloque ``` (por lenguaje preferido; si no, el primer bloque).
  function extractFencedCode(text, langs) {
    const t = String(text || '');
    const rx = /```([\w+-]*)\n?([\s\S]*?)```/g;
    let m; let firstAny = null;
    while ((m = rx.exec(t))) {
      const lang = String(m[1] || '').toLowerCase();
      const code = String(m[2] || '').replace(/\s+$/, '');
      if (firstAny == null && code.trim()) firstAny = code;
      if (langs.indexOf(lang) !== -1 && code.trim()) return code;
    }
    return firstAny != null ? firstAny : t.trim();
  }

  function assembleProgramDoc(html, css, js) {
    let doc = String(html || '').trim();
    const cssBlock = String(css || '').trim() ? ('<style>\n' + String(css).trim() + '\n</style>') : '';
    const jsBlock = String(js || '').trim() ? ('<script>\n' + String(js).trim() + '\n<\/script>') : '';
    const isFull = /<!doctype/i.test(doc) || /<html[\s>]/i.test(doc);
    if (isFull) {
      if (cssBlock && !/<style/i.test(doc)) doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, cssBlock + '\n</head>') : cssBlock + '\n' + doc;
      if (jsBlock) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, jsBlock + '\n</body>') : doc + '\n' + jsBlock;
      return doc;
    }
    return '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + cssBlock + '\n</head>\n<body>\n' + doc + '\n' + jsBlock + '\n</body>\n</html>';
  }

  function renderProgramStageLive(stageKey, progress) {
    const p = progress || {};
    return reasonStageHtml(stageKey) + '<div style="margin-top:8px;font-size:12px;color:rgba(212,255,246,.6)">Escribiendo… ' + Number(p.events || 0) + ' eventos</div>';
  }

  async function streamProgramAgent(baseOpts, stageKey, bub, signal) {
    let combined = '';
    for (let pass = 0; pass < 2; pass += 1) {
      const messages = pass === 0 ? baseOpts.messages : [{ role: 'user', content: 'CONTINUA EXACTAMENTE desde donde te quedaste, sin repetir lo ya escrito ni reiniciar, y cierra el bloque de codigo.\n\nULTIMO:\n' + combined.slice(-8000) }];
      const r = await streamReasonChat({
        model: baseOpts.model, system: baseOpts.system, messages: messages,
        maxTokens: pass === 0 ? baseOpts.maxTokens : Math.min(baseOpts.maxTokens, 10000),
        temperature: baseOpts.temperature, reasonStage: baseOpts.reasonStage, stageLabel: baseOpts.stageLabel
      }, signal, { onProgress: (pr) => { bub.innerHTML = renderProgramStageLive(stageKey, pr); scrollDown(); } });
      combined += String(r && r.text || '');
      if (!(r && r.truncated)) break;
    }
    return combined;
  }

  // Una sola IA produce el unico HTML. Una peticion = una llamada facturable.
  async function buildCodePipeline(text, improved, convo, history, bub, signal, billed) {
    const codeModel = reasonModel('spec_codigo', 'deepseek/deepseek-v4-pro');
    const programModel = reasonModel('program_coder', codeModel);
    const brief = 'PEDIDO DEL USUARIO:\n' + text + (improved && improved !== text ? ('\n\nCONTEXTO ADICIONAL:\n' + improved) : '');
    const stage = billed ? false : undefined;
    bub.innerHTML = reasonStageHtml('codigo');
    const raw = await streamProgramAgent({
      model: programModel,
      system: composeSystemWithMemory(PROGRAM_CODER_PROMPT, convo, text),
      messages: [{ role: 'user', content: brief }],
      maxTokens: 30000,
      temperature: 0.2,
      reasonStage: stage,
      stageLabel: 'Programar · pagina completa'
    }, 'codigo', bub, signal);
    const doc = extractFencedCode(raw, ['html', 'markup', 'xml']);
    return assembleProgramDoc(doc, '', '');
  }
  /* ─────────── Herramienta "Programar": asistente interactivo + build ─────────── */
  function openProgramModal() { if (el.programModal) el.programModal.hidden = false; }
  function closeProgramModal() { if (el.programModal) el.programModal.hidden = true; }

  function setProgramBusy() {
    if (el.programBody) el.programBody.innerHTML = '<div class="pg-busy"><span class="reason-orb"></span> Pensando opciones…</div>';
  }
  function renderProgramError(msg) {
    if (!el.programBody) return;
    el.programBody.innerHTML = '<div class="pg-busy">No se pudo continuar' + (msg ? ': ' + escapeHtml(msg) : '') + '. <button id="pgRetry" type="button" class="pg-next">Reintentar</button></div>';
    const r = el.programBody.querySelector('#pgRetry'); if (r) r.addEventListener('click', programNextStep);
  }

  async function openProgramWizard(request, convo, seed) {
    if (!canUsePremium()) { showProModal('reasoning'); return; }
    if (convo && convo.mode !== 'program') { convo.mode = 'program'; try { saveConvos(); } catch (_) {} syncComposerMode(); }
    state.program = { active: true, convo: convo, request: String(request || '').trim(), answers: [], plan: '', busy: false, lastStep: null, lastAskSig: '' };
    // Desvio desde Razonar: el brief mejorado entra como contexto inicial.
    const s = String(seed || '').trim();
    if (s && s !== state.program.request) state.program.answers.push('Contexto: ' + s.slice(0, 400));
    openProgramModal();
    await programNextStep();
  }

  async function programOrchestrate() {
    const p = state.program;
    const codeModel = reasonModel('spec_codigo', 'deepseek/deepseek-v4-pro');
    const raw = await reasonChat({
      model: reasonModel('program_coder', codeModel),
      system: composeSystemWithMemory(PROGRAM_WIZARD_PROMPT, p.convo, p.request),
      messages: [{ role: 'user', content: JSON.stringify({ request: p.request, answers: p.answers, max_questions: 3, remaining_questions: Math.max(0, 3 - p.answers.length) }, null, 2) }],
      maxTokens: 1800, temperature: 0.25, reasonStage: false
    }, null);
    return parseReasonJson(raw);
  }

  async function programNextStep() {
    const p = state.program;
    if (!p || !p.active) return;
    setProgramBusy();
    let step;
    try { step = await programOrchestrate(); }
    catch (e) { renderProgramError(e && e.message); return; }
    if (!step || !step.phase) { renderProgramError(); return; }
    if (step.phase === 'plan' && String(step.plan || '').trim()) {
      p.plan = String(step.plan).trim();
      p.lastStep = null;
      p.lastAskSig = '';
      renderProgramPlan(p.plan);
    } else {
      if (p.answers.length >= 3) {
        p.plan = buildProgramFallbackPlan(p, step);
        p.lastStep = null;
        p.lastAskSig = '';
        renderProgramPlan(p.plan);
        return;
      }
      const sig = programStepSignature(step);
      if (sig && sig === p.lastAskSig && p.answers.length) {
        p.plan = buildProgramFallbackPlan(p, step);
        p.lastStep = null;
        p.lastAskSig = '';
        renderProgramPlan(p.plan);
        return;
      }
      p.lastStep = step;
      p.lastAskSig = sig;
      renderProgramStep(step);
    }
  }

  function normalizeProgramText(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max).trim() : text;
  }

  function programStepSignature(step) {
    if (!step || String(step.phase || '').trim().toLowerCase() !== 'ask') return '';
    const question = normalizeProgramText(step.question, 160).toLowerCase();
    const options = (Array.isArray(step.options) ? step.options : [])
      .slice(0, 3)
      .map((entry) => normalizeProgramText(entry && (entry.label || entry.value || ''), 80).toLowerCase())
      .filter(Boolean)
      .join('|');
    return [question, options].filter(Boolean).join('::');
  }

  function formatProgramChoice(step, value) {
    const answer = normalizeProgramText(value, 180);
    if (!answer) return '';
    const question = normalizeProgramText(step && step.question, 160);
    return question ? (question + ' -> ' + answer) : answer;
  }

  function buildProgramFallbackPlan(program, repeatedStep) {
    const request = normalizeProgramText(program && program.request, 240) || 'Construir el proyecto pedido por el usuario.';
    const answers = Array.isArray(program && program.answers)
      ? program.answers.map((item) => normalizeProgramText(item, 220)).filter(Boolean)
      : [];
    const pending = normalizeProgramText(repeatedStep && repeatedStep.question, 180);
    const lines = [
      '# PROMPT MAESTRO PARA GENERAR EL HTML',
      '',
      '## Objetivo y alcance',
      '- ' + request,
      '',
      '## Decisiones confirmadas por el usuario'
    ];
    if (answers.length) answers.forEach((item) => lines.push('- ' + item));
    else lines.push('- Tomar la solicitud inicial como referencia principal.');
    lines.push(
      '',
      '## Requisitos de construccion',
      '- Entregar un unico documento HTML autocontenido con CSS dentro de <style> y JavaScript dentro de <script>.',
      '- Crear todas las secciones y contenido necesarios para cumplir el objetivo; no usar lorem ipsum ni controles decorativos sin funcion.',
      '- Priorizar una experiencia movil excelente, luego adaptar de forma responsive a tablet y escritorio.',
      '- Mantener jerarquia visual clara, contraste legible, navegacion accesible y estados focus/hover.',
      '- Implementar y comprobar cada interaccion solicitada sin dependencias que requieran claves.',
      '- Hacer que el menu navegue solo con hashes a secciones del mismo documento; nunca usar href="/", rutas internas ni index.html.',
      '- Considerar terminado solo cuando la pagina se vea completa y sus controles funcionen.'
    );
    if (pending) lines.push('', '## Criterio profesional', '- Resolver profesionalmente este detalle aun abierto sin contradecir las decisiones confirmadas: ' + pending);
    return lines.join('\n');
  }

  function closePreviewFrame(frame) {
    if (!frame) return;
    const wrap = frame.closest('.code-preview');
    const trigger = wrap && wrap.querySelector('[data-preview-toggle]');
    frame.classList.remove('is-fullscreen-preview');
    frame.hidden = true;
    const label = trigger && trigger.querySelector('.cpl-label');
    if (label) label.textContent = 'Abrir página';
  }

  function submitProgramChoice(value) {
    if (!state.program || !state.program.active) return;
    const formatted = formatProgramChoice(state.program.lastStep, value);
    if (!formatted) return;
    state.program.answers.push(formatted);
    state.program.lastStep = null;
    programNextStep();
  }
  function renderProgramStep(step) {
    if (!el.programBody) return;
    const opts = Array.isArray(step.options) ? step.options.slice(0, 3) : [];
    let html = '<div class="pg-step"><div class="pg-q">' + escapeHtml(String(step.question || '¿Que quieres construir?')) + '</div><div class="pg-opts">';
    opts.forEach((o, i) => {
      const val = escapeHtml(String(o.value || o.label || ''));
      const answer = escapeHtml(normalizeProgramText(String(o.label || o.value || ''), 180) || String(o.value || ''));
      const rec = (i === 0) || o.recommended === true;
      const desc = String(o.description || '').trim();
      html += '<button type="button" class="pg-opt" data-val="' + val + '" data-answer="' + answer + '"><span class="pg-opt-copy"><span class="pg-opt-label">' + escapeHtml(String(o.label || o.value || '')) + '</span>' + (desc ? '<span class="pg-opt-desc">' + escapeHtml(desc) + '</span>' : '') + '</span>' + (rec ? '<span class="pg-rec">Recomendada</span>' : '') + '</button>';
    });
    html += '</div><div class="pg-custom"><input id="pgCustom" type="text" placeholder="o escribe lo tuyo…" autocomplete="off"></div><div class="pg-actions"><button id="pgNext" type="button" class="pg-next" disabled>Siguiente</button></div></div>';
    el.programBody.innerHTML = html;
    wireProgramStep();
  }

  function wireProgramStep() {
    const body = el.programBody; if (!body) return;
    let selected = '';
    const next = body.querySelector('#pgNext');
    const custom = body.querySelector('#pgCustom');
    const refresh = () => { if (next) next.disabled = !((custom && custom.value.trim()) || selected); };
    body.querySelectorAll('.pg-opt').forEach((b) => {
      b.addEventListener('click', () => {
        body.querySelectorAll('.pg-opt').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel'); selected = b.getAttribute('data-val') || ''; if (custom) custom.value = ''; refresh();
      });
    });
    if (custom) {
      custom.addEventListener('input', () => { if (custom.value.trim()) { body.querySelectorAll('.pg-opt').forEach((x) => x.classList.remove('sel')); selected = ''; } refresh(); });
      custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (custom.value.trim()) submitProgramChoice(custom.value); } });
    }
    if (next) next.addEventListener('click', () => {
      const chosen = body.querySelector('.pg-opt.sel');
      const preset = chosen ? (chosen.getAttribute('data-answer') || chosen.getAttribute('data-val') || '') : selected;
      const v = (custom && custom.value.trim()) || preset;
      if (v) submitProgramChoice(v);
    });
  }

  function renderProgramPlan(planMd) {
    if (!el.programBody) return;
    el.programBody.innerHTML = '<div class="pg-plan"><div class="pg-plan-title">✨ Prompt maestro listo</div><div class="pg-plan-body">' + renderMarkdown(planMd) + '</div><div class="pg-actions"><button id="pgAdjust" type="button" class="pg-ghost">Ajustar</button><button id="pgStart" type="button" class="pg-next">Crear página ⏎</button></div></div>';
    const start = el.programBody.querySelector('#pgStart');
    const adjust = el.programBody.querySelector('#pgAdjust');
    if (start) { start.addEventListener('click', confirmProgramPlan); start.focus(); }
    if (adjust) adjust.addEventListener('click', renderProgramAdjust);
  }

  function renderProgramAdjust() {
    if (!el.programBody) return;
    el.programBody.innerHTML = '<div class="pg-step"><div class="pg-q">¿Qué quieres cambiar del plan?</div><div class="pg-custom"><input id="pgCustom" type="text" placeholder="Escribe el ajuste…" autocomplete="off"></div><div class="pg-actions"><button id="pgNext" type="button" class="pg-next">Aplicar</button></div></div>';
    const custom = el.programBody.querySelector('#pgCustom');
    const next = el.programBody.querySelector('#pgNext');
    const apply = () => { if (custom && custom.value.trim()) submitProgramChoice('Ajuste pedido: ' + custom.value); };
    if (custom) custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    if (next) next.addEventListener('click', apply);
    if (custom) custom.focus();
  }

  // Guarda el artefacto (html/css/js/doc) por 48h para la futura funcion de editar.
  // user_id lo pone la BD por defecto (auth.uid()); RLS asegura que sea del propio usuario.
  async function saveProgramArtifact(convo, messageId, request, doc) {
    try {
      doc = String(doc || '').trim();
      if (!doc) return;
      const parts = splitProgramDocParts(doc);
      const token = await ensureToken();
      if (!token) return;
      await fetch(PROGRAM_REST_URL, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          conversation_id: convo && convo.id ? String(convo.id) : null,
          message_id: messageId ? String(messageId) : null,
          request: String(request || '').slice(0, 2000),
          html: parts.html, css: parts.css, js: parts.js, doc: doc
        })
      });
    } catch (_) {}
  }

  // Encuentra el ultimo documento HTML de pagina en el chat (para editarlo).
  function lastProgramDoc(convo) {
    const msgs = (convo && convo.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant') continue;
      if (m.programDoc && String(m.programDoc).trim()) return String(m.programDoc);
      if (/```html/i.test(String(m.content || ''))) {
        const d = extractFencedCode(String(m.content), ['html']);
        if (d && d.trim()) return d;
      }
    }
    return '';
  }

  function looksLikeNewProgramProject(text) {
    const value = normalizeForSearch(text);
    return /\b(nuevo|nueva|otro|otra|segundo|segunda)\s+(proyecto|sitio|pagina|web|aplicacion|app)\b/.test(value)
      || /\b(empezar|comenzar|crear)\s+(otro|otra|de cero|desde cero)\b/.test(value);
  }

  // Un chat de Programar equivale a un unico proyecto. Todo mensaje posterior se procesa
  // obligatoriamente como edicion de la revision mas reciente.
  async function programFollowup(convo, text) {
    const doc = lastProgramDoc(convo);
    if (!doc) {
      await openProgramWizard(text, convo);
      return;
    }
    if (looksLikeNewProgramProject(text)) {
      const msg = 'Este chat ya contiene un proyecto de **Programar**. Para evitar mezclar o sobrescribir páginas, abre **Nuevo chat** para crear otro proyecto. Aquí solo puedo continuar editando la página actual.';
      convo.messages.push({ id: uid(), role: 'assistant', content: msg, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo);
      return;
    }
    state.programEdit = { doc: doc, convo: convo };
    await runProgramEdit(text);
  }

  /* ─────────── Editar una pagina ya hecha (re-corre solo la parte que cambia) ─────────── */
  function applyProgramPatch(doc, response) {
    const current = String(doc || '');
    const patch = typeof response === 'string' ? parseReasonJson(response) : (response || {});
    const operations = Array.isArray(patch.operations) ? patch.operations : [];
    if (operations.length > 24) throw new Error('La IA intento hacer demasiados cambios a la vez.');
    let next = current;
    operations.forEach((operation, index) => {
      const search = String(operation && operation.search || '');
      const replace = String(operation && operation.replace || '');
      if (!search) throw new Error('El parche ' + (index + 1) + ' no tiene texto de referencia.');
      const first = next.indexOf(search);
      if (first < 0) throw new Error('El parche ' + (index + 1) + ' no coincide con la pagina actual.');
      if (first !== next.lastIndexOf(search)) throw new Error('El parche ' + (index + 1) + ' es ambiguo y no se aplico.');
      next = next.slice(0, first) + replace + next.slice(first + search.length);
    });
    return { doc: next, changed: next !== current, summary: String(patch.summary || '').trim(), operationCount: operations.length };
  }
  function openProgramEdit(doc) {
    if (!canUsePremium()) { showProModal('reasoning'); return; }
    const d = String(doc || '').trim();
    if (!d) return;
    state.programEdit = { doc: d, convo: activeConvo() };
    openProgramModal();
    renderProgramEditForm();
  }

  function renderProgramEditForm() {
    if (!el.programBody) return;
    const convo = (state.programEdit && state.programEdit.convo) || activeConvo();
    const canRevert = !!(convo && (programHistory.get(convo.id) || []).length);
    const examples = ['Cambia los colores a un tema oscuro', 'Agrega una sección de contacto', 'Hazlo más moderno', 'Que el menú funcione en móvil'];
    const revertBtn = canRevert ? '<button id="pgEditRevert" type="button" class="pg-ghost">↩ Versión anterior</button>' : '';
    el.programBody.innerHTML = '<div class="pg-step"><div class="pg-q">✎ ¿Qué quieres cambiar o agregar?</div><div class="pg-opts">'
      + examples.map((ex) => '<button type="button" class="pg-opt" data-edit-ex="' + escapeHtml(ex) + '"><span class="pg-opt-label">' + escapeHtml(ex) + '</span></button>').join('')
      + '</div><div class="pg-custom"><input id="pgEdit" type="text" placeholder="Escribe el cambio…" autocomplete="off"></div>'
      + '<div class="pg-actions">' + revertBtn + '<button id="pgEditCancel" type="button" class="pg-ghost">Cancelar</button><button id="pgEditApply" type="button" class="pg-next" disabled>Aplicar cambio</button></div></div>';
    const input = el.programBody.querySelector('#pgEdit');
    const apply = el.programBody.querySelector('#pgEditApply');
    const cancel = el.programBody.querySelector('#pgEditCancel');
    const revert = el.programBody.querySelector('#pgEditRevert');
    const refresh = () => { if (apply) apply.disabled = !(input && input.value.trim()); };
    el.programBody.querySelectorAll('[data-edit-ex]').forEach((b) => b.addEventListener('click', () => { if (input) { input.value = b.getAttribute('data-edit-ex') || ''; refresh(); input.focus(); } }));
    if (input) {
      input.addEventListener('input', refresh);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); runProgramEdit(input.value.trim()); } });
      input.focus();
    }
    if (apply) apply.addEventListener('click', () => { if (input && input.value.trim()) runProgramEdit(input.value.trim()); });
    if (revert) revert.addEventListener('click', revertProgramVersion);
    if (cancel) cancel.addEventListener('click', closeProgramModal);
  }

  // Restaura la version anterior guardada en el historial (en memoria). No re-apila la version
  // deshecha (skipHistory), asi se puede revertir varias veces hacia atras.
  function revertProgramVersion() {
    const convo = (state.programEdit && state.programEdit.convo) || activeConvo();
    const list = convo && programHistory.get(convo.id);
    if (!convo || !list || !list.length) return;
    const prev = String(list.pop() || '').trim();
    programHistory.set(convo.id, list);
    closeProgramModal();
    state.programEdit = null;
    if (!prev) return;
    const built = bubbleEl('ai', '');
    el.messages.appendChild(built.wrap);
    pushProgramResult(convo, built.bub, prev, 'Restauré la versión anterior ✅. Volví la página al estado previo a tu último cambio.', 'Revertir a versión anterior', 'Revertir (Programar)', { skipHistory: true });
    scrollDown();
  }

  async function runProgramEdit(change) {
    const ed = state.programEdit;
    if (!ed || !ed.doc || state.busy) return;
    const convo = ed.convo || activeConvo() || ensureActiveConvo(change);
    const currentDoc = String(ed.doc);
    closeProgramModal();
    state.programEdit = null;
    const built = bubbleEl('ai', '<span class="gen-img-loading">Aplicando tu cambio<span class="dots"><i>.</i><i>.</i><i>.</i></span></span>');
    const bub = built.bub;
    el.messages.appendChild(built.wrap); scrollDown();
    setBusy(true); state.abort = new AbortController();
    const signal = state.abort.signal;
    const codeModel = reasonModel('spec_codigo', 'deepseek/deepseek-v4-pro');
    const programModel = reasonModel('program_coder', codeModel);
    try {
      // 1) Parche quirurgico (rapido, preserva bytes). Ideal para cambios chicos.
      bub.innerHTML = reasonStageHtml('codigo');
      let patched = null;
      try {
        const raw = await reasonChat({
          model: programModel,
          system: composeSystemWithMemory(PROGRAM_PATCH_PROMPT, convo, change),
          messages: [{ role: 'user', content: 'CAMBIO PEDIDO:\n' + change + '\n\nHTML ACTUAL (no lo reescribas; devuelve operaciones exactas):\n' + currentDoc }],
          maxTokens: 8000,
          temperature: 0.1,
          reasoning: { enabled: true, effort: 'medium', exclude: true },
          reasonStage: false
        }, signal);
        patched = applyProgramPatch(currentDoc, raw);
      } catch (patchErr) {
        patched = null; // el parche no era aplicable -> caemos a reescritura completa
      }
      if (patched && patched.changed) {
        const summary = patched.summary || String(change).trim();
        pushProgramResult(convo, bub, patched.doc, 'Cambio aplicado ✅: ' + summary + '. Se modificaron ' + patched.operationCount + ' fragmento(s); el resto quedo intacto. Abre la pagina para revisarla.', 'Edicion: ' + change, 'Edicion incremental (Programar)');
        return;
      }
      // 2) Reescritura COMPLETA: para cambios grandes que el parche no puede hacer. Ya no se
      //    bloquea por "seguridad": si algo no gusta, el usuario usa "↩ Version anterior".
      if (signal.aborted) return;
      bub.innerHTML = reasonStageHtml('codigo');
      const rewriteRaw = await reasonChat({
        model: programModel,
        system: composeSystemWithMemory(PROGRAM_REWRITE_PROMPT, convo, change),
        messages: [{ role: 'user', content: 'CAMBIO PEDIDO:\n' + change + '\n\nHTML ACTUAL:\n' + currentDoc }],
        maxTokens: 16000,
        temperature: 0.2,
        reasoning: { enabled: true, effort: 'medium', exclude: true },
        reasonStage: false
      }, signal);
      const newDoc = String(extractFencedCode(rewriteRaw, ['html', 'htm']) || '').trim();
      if (!newDoc || !/<html[\s>]/i.test(newDoc)) throw new Error('La IA no devolvio un HTML completo.');
      pushProgramResult(convo, bub, newDoc, 'Cambio aplicado ✅ (reescritura completa): ' + String(change).trim() + '. Si algo no te gusta, abre Editar y usa "↩ Versión anterior" para volver atras.', 'Edicion: ' + change, 'Edicion completa (Programar)');
    } catch (e) {
      bub.innerHTML = renderMarkdown('No se pudo aplicar el cambio: ' + ((e && e.message) || 'error') + '. Intenta de nuevo o describe el cambio con otras palabras.');
    } finally {
      setBusy(false); state.abort = null;
    }
  }
  // El documento va ADJUNTO al mensaje (m.programDoc), no dentro del markdown: asi la Vista
  // previa siempre sale (sin parsear fences) y el doc grande no se trunca.
  // Historial de versiones de Programar EN MEMORIA (no se persiste ni se sincroniza, para no
  // bloatear localStorage/Supabase con varios HTML pesados). Permite revertir en la sesion.
  const programHistory = new Map(); // convoId -> [docs anteriores, mas reciente al final]
  function pushProgramHistory(convoId, doc) {
    if (!convoId || !doc) return;
    const list = programHistory.get(convoId) || [];
    if (list[list.length - 1] === doc) return;
    list.push(doc);
    while (list.length > 6) list.shift();
    programHistory.set(convoId, list);
  }

  function pushProgramResult(convo, bub, doc, note, request, label, opts) {
    const safeDoc = String(doc || '').trim();
    bub.innerHTML = renderMarkdown(note) + buildPreviewBlockHtml(safeDoc);
    // Guarda la version que estamos reemplazando para poder revertir (salvo si esto YA es un
    // revert, que no debe re-apilar la version deshecha).
    if (!(opts && opts.skipHistory)) {
      const prev = (convo.messages || []).filter((e) => e && e.programDoc).map((e) => e.programDoc).pop();
      if (prev && prev !== safeDoc) pushProgramHistory(convo.id, prev);
    }
    // Solo la revision mas reciente conserva el HTML pesado y la vista previa. Los mensajes
    // anteriores quedan como bitacora textual, evitando duplicar el proyecto en cada cambio.
    (convo.messages || []).forEach((entry) => {
      if (entry && entry.programDoc) delete entry.programDoc;
    });
    const m = { id: uid(), role: 'assistant', content: note, programDoc: safeDoc, ts: Date.now() };
    markAssistantTurn(convo, note, label);
    convo.messages.push(m);
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
    void saveProgramArtifact(convo, m.id, request, safeDoc);
    return m;
  }

  async function buildProgramPage(convo, request) {
    if (!convo || !String(request || '').trim() || state.busy) return;
    if (!canUsePremium()) { showProModal('reasoning'); return; }
    convo.mode = 'program';
    const { wrap, bub } = bubbleEl('ai', reasonStageHtml('codigo'));
    el.messages.appendChild(wrap); scrollDown();
    setBusy(true); state.abort = new AbortController();
    try {
      const doc = String(await buildCodePipeline(request, request, convo, [], bub, state.abort.signal, true) || '').trim();
      if (!doc || !/<html[\s>]/i.test(doc)) throw new Error('La IA no devolvio un HTML completo.');
      pushProgramResult(convo, bub, doc, 'Pagina lista ✅ — creada por una sola IA y guardada como un unico HTML. Abrela para verla a pantalla completa o pide un cambio puntual.', request, 'Pagina construida (Programar)');
      void maybeUpdateConvoBrain(convo);
    } catch (e) {
      bub.innerHTML = renderMarkdown('No se pudo construir: ' + ((e && e.message) || 'error') + '.');
    } finally {
      setBusy(false); state.abort = null;
    }
  }
  async function confirmProgramPlan() {
    const p = state.program;
    if (!p || !p.active || state.busy) return;
    const convo = p.convo;
    const brief = (p.plan || p.request) + (p.answers.length ? '\n\nDecisiones del usuario:\n- ' + p.answers.join('\n- ') : '');
    closeProgramModal();
    state.program.active = false;
    const { wrap, bub } = bubbleEl('ai', reasonStageHtml('code_structure'));
    el.messages.appendChild(wrap); scrollDown();
    setBusy(true); state.abort = new AbortController();
    try {
      const history = buildCloudMessages(convo, 'reasoning');
      const built = await buildCodePipeline(p.request, brief, convo, history, bub, state.abort.signal, true);
      const doc = String(built || '').trim();
      if (!doc) { bub.innerHTML = renderMarkdown('No se pudo construir la página. Intenta de nuevo.'); return; }
      pushProgramResult(convo, bub, doc, 'Página lista ✅ — estructura, estilos e interacciones en un solo archivo. Usa **Vista previa**, **Editar** o **Descargar** abajo.', p.request, 'Pagina construida (Programar)');
      void maybeUpdateConvoBrain(convo);
    } catch (e) {
      bub.innerHTML = renderMarkdown('No se pudo construir: ' + ((e && e.message) || 'error') + '.');
    } finally {
      setBusy(false); state.abort = null;
    }
  }

  function persistProgram() { try { localStorage.setItem(PROGRAM_KEY, state.programMode ? '1' : '0'); } catch (_) {} }
  function renderProgramBtn() {
    if (!el.programBtn) return;
    el.programBtn.classList.toggle('on', !!state.programMode);
    el.programBtn.setAttribute('aria-pressed', state.programMode ? 'true' : 'false');
  }

  function categorySpecialist(category, improved) {
    const brief = '\n\nInstrucciones del orquestador (síguelas al pie de la letra):\n' + improved;
    if (category === 'codigo') {
      return { model: reasonModel('spec_codigo', 'deepseek/deepseek-v4-pro'), stage: 'codigo', temperature: 0.2, system: 'Eres un ingeniero de software senior. Entrega codigo correcto, integrado y ejecutable; prioriza la correctitud y la integracion real; explica lo esencial brevemente.' + brief };
    }
    if (category === 'chat_max') {
      const hoy = new Date().toLocaleDateString('es', { day: '2-digit', month: 'long', year: 'numeric' });
      return {
        model: reasonModel('spec_chat_max', 'anthropic/claude-sonnet-4.6:online'), stage: 'chat_max', temperature: 0.2,
        plugins: [{ id: 'web', max_results: 6 }],
        system: 'Eres Mady en modo investigacion con BUSQUEDA WEB ACTIVA. Hoy es ' + hoy + ' (estamos en el ano 2026; NUNCA trates esta fecha como futura ni digas que no puedes acceder a internet). DEBES usar los resultados de la busqueda web que recibes para responder con datos REALES y ACTUALES. CITA las fuentes (URLs reales) que uses. Separa hechos confirmados de inferencias y marca explicitamente lo que no se pudo verificar.' + brief
      };
    }
    if (category === 'razonamiento') {
      return { model: reasonModel('spec_razonamiento', 'z-ai/glm-5.2'), stage: 'razonamiento', temperature: 0.3, system: 'Eres Mady en razonamiento tecnico profundo. Razona con rigor, considera alternativas y justifica cada decision.' + brief };
    }
    return { model: reasonModel('spec_chat_simple', 'z-ai/glm-5.2'), stage: 'chat_simple', temperature: 0.4, system: SYSTEM_PROMPT + brief };
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

  // Pipeline premium: IA principal (clasifica + mejora prompt) -> especialista -> juez Opus 4.8.
  async function reasoningAnswer(text, convo, bub) {
    const signal = state.abort && state.abort.signal;
    const history = buildCloudMessages(convo, 'reasoning');

    // 1) Clasificar BARATO con el orquestador (modelo flash). Se cobra por token como las
    //    demas etapas; corre primero para decidir si aclara o desvia a Programar (codigo).
    bub.innerHTML = reasonStageHtml('orchestrate');
    let orch;
    try {
      const orchRaw = await reasonChat({ model: reasonModel('orchestrator', 'google/gemini-2.5-flash'), system: composeSystemWithMemory(ORCHESTRATOR_PROMPT, convo, text), messages: history, maxTokens: 1400, temperature: 0.2, reasonStage: false }, signal);
      orch = parseReasonJson(orchRaw);
    } catch (_) {
      const msg = 'No se pudo iniciar el modo razonamiento. Intenta de nuevo.';
      bub.innerHTML = renderMarkdown(msg);
      convo.messages.push({ id: uid(), role: 'assistant', content: msg, ts: Date.now() });
      convo.updated = Date.now(); saveConvos(); renderConvoList();
      return;
    }

    if (orch.need_clarification && String(orch.questions || '').trim()) {
      const q = String(orch.questions).trim();
      bub.innerHTML = renderMarkdown(q);
      markAssistantTurn(convo, q, 'Aclaracion del orquestador');
      convo.messages.push({ id: uid(), role: 'assistant', content: q, ts: Date.now() });
      convo.updated = Date.now();
      saveConvos(); renderConvoList(); syncPushOne(convo);
      void maybeUpdateConvoBrain(convo);
      return;
    }
    const category = String(orch.category || 'chat_simple').toLowerCase();
    const improved = String(orch.improved_prompt || text).trim();

    // 2) Codigo se entrega a la unica IA de Programar, sin planificador ni etapas.
    if (category === 'codigo') {
      convo.mode = 'program';
      saveConvos(); syncComposerMode();
      const doc = String(await buildCodePipeline(text, improved, convo, [], bub, signal, true) || '').trim();
      if (!doc || !/<html[\s>]/i.test(doc)) throw new Error('La IA no devolvio un HTML completo.');
      pushProgramResult(convo, bub, doc, 'Pagina lista ✅ — creada por una sola IA y guardada como un unico HTML. Abrela para verla a pantalla completa o pide un cambio puntual.', text, 'Pagina construida (Programar)');
      return;
    }

    // 3) No-codigo: el razonamiento se cobra por TOKENS (entrada/salida) como los demas
    //    modelos. Cada llamada interna (especialista + juez) reserva creditos normal
    //    (reasonStage:false). Ya no hay usos semanales ni llamadas internas gratis.
    if (category === 'imagen') {
      await generateImage(improved, convo, null, bub, false);
      return;
    }

    const spec = categorySpecialist(category, improved);
    bub.innerHTML = reasonStageHtml(spec.stage);
    const draft = await reasonChat({ model: spec.model, system: composeSystemWithMemory(spec.system, convo, improved), messages: history, maxTokens: 9000, temperature: spec.temperature, plugins: spec.plugins, reasonStage: false }, signal);

    bub.innerHTML = reasonStageHtml('judge');
    const judgeRaw = await reasonChat({
      model: reasonModel('judge', 'anthropic/claude-opus-4.8'),
      system: composeSystemWithMemory(JUDGE_PROMPT, convo, text),
      messages: [{ role: 'user', content: 'PETICION ORIGINAL:\n' + text + '\n\nPROMPT MEJORADO:\n' + improved + '\n\nBORRADOR DEL ESPECIALISTA:\n' + draft }],
      maxTokens: 9000,
      temperature: 0.1,
      reasonStage: false
    }, signal);
    const j = parseReasonJson(judgeRaw);
    const finalText = String(j.respuesta_final || draft).trim() || '_(sin respuesta)_';
    const verdict = extractVerdict(j);

    const m = { id: uid(), role: 'assistant', content: finalText, ts: Date.now() };
    if (verdict) m.verdict = verdict;
    markAssistantTurn(convo, finalText, 'Respuesta razonada');
    convo.messages.push(m);
    convo.updated = Date.now();
    saveConvos(); renderMessages(); renderConvoList(); syncPushOne(convo); fetchStatus();
    void maybeUpdateConvoBrain(convo);
  }

  async function reasonChat(opts, signal) {
    const payload = {
      action: 'chat',
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens || 4000,
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      // reasonStage ya NO exime del cobro: el razonamiento se cobra por tokens como todo
      // lo demas. Se conserva el flag solo como metadato de etapa interna.
      reasonStage: opts.reasonStage !== false
    };
    if (opts.plugins && opts.plugins.length) payload.plugins = opts.plugins;
    if (opts.reasoning) payload.reasoning = opts.reasoning;
    const res = await callEdge(payload, signal);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(stageErrorMessage(opts, data, res), data.status || res.status, data.credits);
    }
    return String(data.text || '').trim();
  }

  async function streamReasonChat(opts, signal, hooks) {
    const payload = {
      action: 'stream',
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens || 4000,
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      reasonStage: opts.reasonStage !== false
    };
    if (opts.plugins && opts.plugins.length) payload.plugins = opts.plugins;
    const res = await callEdge(payload, signal);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      if (data && data.credits) { state.credits = mergeCredits(state.credits, data.credits); renderCredits(); }
      throw ApiError(stageErrorMessage(opts, data, res), data.status || res.status, data.credits);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let credits = null;
    let errored = null;
    let errorStatus = 500;
    let events = 0;
    let sawReasoning = false;
    let finishReason = null;
    let truncated = false;

    const emit = () => {
      if (hooks && typeof hooks.onProgress === 'function') hooks.onProgress({ text: full, events, sawReasoning });
    };

    const handle = (evt) => {
      if (!evt || !evt.type) return;
      events += 1;
      if (evt.type === 'content' && evt.text) {
        full += evt.text;
        emit();
        return;
      }
      if (evt.type === 'reasoning') {
        sawReasoning = true;
        emit();
        return;
      }
      if (evt.type === 'complete') {
        if (typeof evt.text === 'string' && evt.text.length >= full.length) full = evt.text;
        if (evt.credits) credits = evt.credits;
        finishReason = evt.finishReason || finishReason;
        truncated = evt.truncated === true || String(evt.finishReason || '').toLowerCase() === 'length';
        emit();
        return;
      }
      if (evt.type === 'error') {
        errored = evt.error || 'Error en el stream.';
        errorStatus = Number(evt.status || 500) || 500;
        if (evt.credits) credits = evt.credits;
        emit();
        return;
      }
      emit();
    };

    emit();
    while (true) {
      const result = await reader.read();
      const value = result.value;
      const done = result.done;
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i = buffer.indexOf('\n\n');
      while (i >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const dataStr = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n').trim();
        if (dataStr) {
          try { handle(JSON.parse(dataStr)); } catch (_) {}
        }
        i = buffer.indexOf('\n\n');
      }
    }
    if (errored) throw ApiError(stageErrorMessage(opts, { error: errored, status: errorStatus }, null), errorStatus, credits);
    return { text: full, credits, finishReason, truncated, events, sawReasoning };
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
      stopEnginePresence();
      setEngineUI(false, '', 'Motor web (estándar)');
      renderEngineBadge();
      return;
    }
    setEngineToggleVisual(false, 'busy');
    el.engineStatus.className = 'engine-status';
    el.engineStatus.textContent = '🔎 Buscando tu PC con LTH OS…';
    const probe = await probeOsEngine();
    if (!probe.ok) {
      setEngineUI(false, 'warn', '⚠️ No se encontró tu PC. Enciende LTH OS y activa LTH Remote, en la misma cuenta.');
      return;
    }
    // PC en línea: se conecta solo (sin PIN). Misma cuenta = mismo motor.
    state.engine = 'os'; persistEngine();
    state.osConnected = true;
    setEngineUI(true, 'ok', '✅ Conectado al motor LTH OS');
    renderEngineBadge(); startEnginePresence();
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
    el.creditsBtn.addEventListener('click', () => { el.creditsPanel.hidden = !el.creditsPanel.hidden; });
    document.addEventListener('click', (e) => {
      if (!el.creditsPanel.hidden && !el.creditsPanel.contains(e.target) && !el.creditsBtn.contains(e.target)) el.creditsPanel.hidden = true;
    });

    el.composer.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.busy) { if (state.abort) state.abort.abort(); return; }
      send(el.input.value);
    });
    el.reasonBtn.addEventListener('click', () => {
      if (el.reasonBtn.disabled) return;
      if (!canUsePremium()) { showProModal('reasoning'); return; }
      state.reasoning = !state.reasoning; persistReason(); renderReasonBtn();
      // Solo un modo a la vez.
      if (state.reasoning) {
        if (state.programMode) { state.programMode = false; persistProgram(); renderProgramBtn(); }
        if (state.createMode) { state.createMode = false; renderCreateBtn(); }
      }
    });
    if (el.programBtn) el.programBtn.addEventListener('click', () => {
      if (el.programBtn.disabled) return;
      if (!canUsePremium()) { showProModal('reasoning'); return; }
      state.programMode = !state.programMode; persistProgram(); renderProgramBtn();
      if (state.programMode) {
        if (state.reasoning) { state.reasoning = false; persistReason(); renderReasonBtn(); }
        if (state.createMode) { state.createMode = false; renderCreateBtn(); }
        setComposerHint('Modo Programar: describe tu idea; te hare hasta 3 preguntas utiles antes de crear el HTML.');
      }
    });
    if (el.programClose) el.programClose.addEventListener('click', closeProgramModal);
    if (el.programModal) el.programModal.addEventListener('click', (e) => { if (e.target === el.programModal) closeProgramModal(); });
    if (el.createBtn) el.createBtn.addEventListener('click', () => {
      if (el.createBtn.disabled) return;
      state.createMode = !state.createMode; renderCreateBtn();
      if (state.createMode) {
        if (state.reasoning) { state.reasoning = false; persistReason(); renderReasonBtn(); }
        if (state.programMode) { state.programMode = false; persistProgram(); renderProgramBtn(); }
        setComposerHint('Modo crear: describe la pagina o mini-app y la IA la genera en HTML (con Vista previa).');
      }
    });
    if (el.themeSeg) el.themeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme]');
      if (b) applyTheme(b.getAttribute('data-theme'));
    });
    if (el.proClose) el.proClose.addEventListener('click', closeProModal);
    if (el.proModal) el.proModal.addEventListener('click', (e) => { if (e.target === el.proModal) closeProModal(); });
    if (el.proBuyBtn) el.proBuyBtn.addEventListener('click', () => {
      // Compra aún bloqueada: por ahora solo marketing.
      el.proBuyBtn.textContent = 'Disponible muy pronto ✨';
      el.proBuyBtn.disabled = true;
      setTimeout(() => { el.proBuyBtn.textContent = 'Comprar plan Pro'; el.proBuyBtn.disabled = false; }, 2200);
    });
    if (el.modelPickerBtn) {
      el.modelPickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.modelMenu.hidden) openModelMenu(); else closeModelMenu();
      });
    }
    if (el.modelMenu) {
      el.modelMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-model]');
        if (!btn) return;
        const id = btn.getAttribute('data-model');
        const m = MANUAL_MODELS[id];
        if (!m) return;
        if (m.premium && !canUsePremium()) { closeModelMenu(); showProModal('model'); return; }
        state.manualModel = id;
        renderModelBar();
        closeModelMenu();
      });
      document.addEventListener('click', (e) => {
        if (el.modelMenu.hidden) return;
        if (!el.modelMenu.contains(e.target) && e.target !== el.modelPickerBtn && !el.modelPickerBtn.contains(e.target)) closeModelMenu();
      });
    }
    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.composer.requestSubmit(); }
    });
    el.suggestions.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { el.input.value = b.textContent.replace(/…$/, ''); autoGrow(); el.input.focus(); });
    });
  }

  /* ───────────────────────── Auth UI ───────────────────────── */
  function stopInvitePolling() {
    if (state.inviteTimer) clearInterval(state.inviteTimer);
    state.inviteTimer = null;
  }

  function setAuthMode(mode) {
    stopInvitePolling();
    state.authMode = mode;
    el.authTabs.hidden = false;
    el.authForm.hidden = false;
    el.invitePanel.hidden = true;
    el.pinForm.hidden = true;
    el.resetForm.hidden = true;
    document.querySelectorAll('[data-auth-tab]').forEach((t) => t.classList.toggle('on', t.getAttribute('data-auth-tab') === mode));
    const signup = mode === 'signup';
    el.passwordRules.hidden = !signup;
    el.turnstileWrap.hidden = !signup;
    el.forgotPasswordBtn.hidden = signup;
    el.authBtnLabel.textContent = signup ? 'Solicitar invitación' : 'Entrar';
    el.authPassword.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    el.authFoot.textContent = signup
      ? 'LTH Mady está en producción · revisamos cada solicitud manualmente'
      : 'Acceso protegido por Supabase Auth';
    el.authMsg.textContent = ''; el.authMsg.classList.remove('ok');
    if (signup) {
      if (!CFG.TURNSTILE_SITE_KEY) authMessage('El registro todavía no está activado: falta configurar Turnstile.');
      else INVITES.renderTurnstile('turnstileWidget', CFG.TURNSTILE_SITE_KEY).catch((error) => authMessage(error.message));
    }
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

  function pinMessage(text, ok) {
    el.pinMsg.textContent = text || '';
    el.pinMsg.classList.toggle('ok', !!ok);
  }

  async function inviteCall(action, body, token) {
    if (!INVITES) throw new Error('El módulo de invitaciones no está disponible.');
    return INVITES.call(INVITE_FN_URL, SB_KEY, action, body, token);
  }

  function showInvitePanel(invite, rawEmail) {
    const info = invite || { status: 'pending' };
    const vm = INVITES.viewModel(info);
    state.invite = info;
    stopInvitePolling();
    if (vm.status === 'code_sent') {
      showPinPanel(rawEmail || (INVITES.loadTracker() || {}).email || '');
      return;
    }
    if (vm.status === 'active' || vm.status === 'grandfathered') {
      INVITES.clearTracker();
      setAuthMode('login');
      if (rawEmail) el.authEmail.value = rawEmail;
      authMessage('Cuenta verificada. Inicia sesión con tu contraseña.', true);
      return;
    }
    el.authTabs.hidden = true;
    el.authForm.hidden = true;
    el.pinForm.hidden = true;
    el.resetForm.hidden = true;
    el.invitePanel.hidden = false;
    el.inviteStatusIcon.textContent = vm.icon;
    el.inviteStatusTitle.textContent = vm.title;
    el.inviteStatusText.textContent = vm.text;
    el.inviteMaskedEmail.textContent = info.email || 'Correo registrado';
    el.inviteExpiry.textContent = info.expiresAt ? 'Vence: ' + new Date(info.expiresAt).toLocaleString('es-MX') : '';
    el.authFoot.textContent = 'Nunca solicitaremos tu contraseña por correo';
    if (['pending', 'code_ready'].includes(vm.status) && INVITES.loadTracker()) {
      state.inviteTimer = setInterval(refreshInviteStatus, 30000);
    }
  }

  function showPinPanel(email) {
    stopInvitePolling();
    el.authTabs.hidden = true;
    el.authForm.hidden = true;
    el.invitePanel.hidden = true;
    el.pinForm.hidden = false;
    if (email) el.pinEmail.value = email;
    el.pinCode.value = '';
    el.pinMsg.textContent = '';
    el.authFoot.textContent = 'El PIN vence 24 horas después del envío · máximo 5 intentos';
    setTimeout(() => el.pinCode.focus(), 0);
  }

  async function refreshInviteStatus() {
    const tracker = INVITES.loadTracker();
    if (!tracker) {
      showPinPanel(el.pinEmail.value || el.authEmail.value);
      return;
    }
    try {
      const data = await inviteCall('invite.status', { requestToken: tracker.requestToken });
      showInvitePanel(data.invite, tracker.email);
    } catch (error) {
      el.inviteStatusText.textContent = error.message || 'No se pudo actualizar el estado.';
    }
  }

  async function handlePinSubmit(event) {
    event.preventDefault();
    const email = String(el.pinEmail.value || '').trim().toLowerCase();
    const pin = String(el.pinCode.value || '').replace(/\D/g, '');
    if (!email || !/^\d{6}$/.test(pin)) { pinMessage('Escribe tu correo y el PIN de 6 dígitos.'); return; }
    el.pinSubmit.disabled = true; el.pinSpinner.hidden = false; pinMessage('');
    try {
      await inviteCall('invite.verify', { email, pin });
      INVITES.clearTracker();
      setAuthMode('login');
      el.authEmail.value = email;
      el.authPassword.value = '';
      authMessage('Cuenta verificada. Introduce tu contraseña para entrar.', true);
    } catch (error) {
      pinMessage(error.message || 'No se pudo verificar el PIN.');
    } finally {
      el.pinSubmit.disabled = false; el.pinSpinner.hidden = true;
    }
  }

  function resetTracker(value) {
    const key = 'lth_ia_password_reset_tracker_v1';
    if (value === undefined) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
    try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); } catch (_) {}
  }

  function setResetNotice(text) {
    el.resetNotice.textContent = text || '';
    el.resetNotice.hidden = !text;
  }

  function resetPasswordToggles() {
    el.resetForm.querySelectorAll('.password-toggle').forEach((btn) => {
      const input = el.resetForm.querySelector('#' + btn.getAttribute('data-target'));
      if (input) input.type = 'password';
      btn.textContent = 'Ver'; btn.setAttribute('aria-label', 'Mostrar contraseña');
    });
  }

  function showResetForm(complete) {
    stopInvitePolling();
    el.authTabs.hidden = true; el.authForm.hidden = true; el.invitePanel.hidden = true; el.pinForm.hidden = true; el.resetForm.hidden = false;
    state.resetStage = complete ? 'complete' : 'request';
    el.resetPinFields.hidden = !complete; el.resetTurnstile.hidden = !!complete;
    el.resetHavePinBtn.hidden = !!complete; el.resetBtnLabel.textContent = complete ? 'Cambiar contraseña' : 'Solicitar PIN';
    el.resetMsg.textContent = ''; el.resetMsg.classList.remove('ok');
    el.resetTitle.textContent = complete ? 'Introduce tu PIN' : 'Restablecer contraseña';
    el.resetIntro.textContent = complete
      ? 'Revisa tu bandeja de entrada (y la carpeta de spam) e introduce el PIN. Después define tu nueva contraseña.'
      : 'Escribe tu correo. El administrador te enviará un PIN manualmente.';
    setResetNotice(complete ? 'El PIN puede llegar durante las próximas 12 horas. Tienes un máximo de 5 intentos.' : '');
    el.resetPin.value = ''; el.resetPassword.value = ''; el.resetPasswordConfirm.value = '';
    resetPasswordToggles();
    if (!complete) INVITES.renderTurnstile('resetTurnstileWidget', CFG.TURNSTILE_SITE_KEY).catch((error) => { el.resetMsg.textContent = error.message; });
    const tracker = resetTracker(); if (tracker && tracker.email) el.resetEmail.value = tracker.email;
    // El auto-enfoque solo en escritorio: en moviles (pointer grueso) provoca saltos y bloqueos del teclado en iOS.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) setTimeout(() => { (complete ? el.resetPin : el.resetEmail).focus(); }, 0);
  }

  async function handleResetSubmit(event) {
    event.preventDefault();
    const email = String(el.resetEmail.value || '').trim().toLowerCase();
    if (!email) { el.resetMsg.textContent = 'Escribe tu correo.'; return; }
    el.resetSubmit.disabled = true; el.resetSpinner.hidden = false; el.resetMsg.textContent = ''; el.resetMsg.classList.remove('ok');
    try {
      if (state.resetStage === 'request') {
        const token = INVITES.turnstileToken('resetTurnstileWidget');
        if (!token) throw new Error('Completa la verificación de seguridad.');
        let alreadyRequested = false;
        try {
          const data = await inviteCall('password.request', { email, turnstileToken: token });
          if (data.reset && data.reset.requestToken) resetTracker({ email, requestToken: data.reset.requestToken });
        } catch (err) {
          // Si ya hay una solicitud previa (p.ej. tope de solicitudes), no es un fallo real:
          // pasamos igual a introducir el PIN, que es lo unico que falta.
          const tracker = resetTracker();
          if (!(tracker && tracker.email)) throw err;
          alreadyRequested = true;
        }
        showResetForm(true);
        el.resetMsg.textContent = alreadyRequested
          ? 'Ya tenías una solicitud activa. Escribe el PIN que te enviamos a tu correo.'
          : 'Solicitud enviada. Revisa tu bandeja de entrada (y la carpeta de spam) y escribe el PIN aquí.';
        el.resetMsg.classList.add('ok');
      } else {
        const pin = String(el.resetPin.value || '').replace(/\D/g, '');
        const password = String(el.resetPassword.value || '');
        const confirm = String(el.resetPasswordConfirm.value || '');
        if (!/^\d{6}$/.test(pin)) throw new Error('Escribe el PIN de 6 dígitos.');
        const problem = INVITES.passwordError(password, email); if (problem) throw new Error(problem);
        if (password !== confirm) throw new Error('Las contraseñas no coinciden.');
        await inviteCall('password.complete', { email, pin, newPassword: password });
        resetTracker(null); setAuthMode('login'); el.authEmail.value = email; el.authPassword.value = '';
        authMessage('Contraseña actualizada. Ya puedes iniciar sesión.', true);
      }
    } catch (error) { el.resetMsg.textContent = error.message || 'No se pudo completar la solicitud.'; el.resetMsg.classList.remove('ok'); }
    finally { el.resetSubmit.disabled = false; el.resetSpinner.hidden = true; }
  }
  async function ensureWebAccess(session) {
    const data = await inviteCall('invite.accessStatus', {}, session.access_token);
    if (data.allowed) return true;
    let invite = data.invite;
    if (!invite || invite.status === 'missing') {
      const requested = await inviteCall('invite.requestExistingAccount', {}, session.access_token);
      invite = requested.invite;
      INVITES.saveTracker(invite, session.user && session.user.email);
    }
    clearSession();
    showInvitePanel(invite, session.user && session.user.email);
    return false;
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = String(el.authEmail.value || '').trim().toLowerCase();
    const password = String(el.authPassword.value || '');
    if (!email || !password) { authMessage('Completa correo y contraseña.'); return; }
    if (state.authMode === 'signup') {
      const passwordProblem = INVITES.passwordError(password, email);
      if (passwordProblem) { authMessage(passwordProblem); return; }
      if (!CFG.TURNSTILE_SITE_KEY) { authMessage('Las nuevas solicitudes aún no están activadas.'); return; }
      const turnstileToken = INVITES.turnstileToken('turnstileWidget');
      if (!turnstileToken) { authMessage('Completa la verificación de seguridad.'); return; }
      setAuthBusy(true); authMessage('');
      try {
        const data = await inviteCall('invite.request', { email, password, turnstileToken });
        INVITES.saveTracker(data.invite, email);
        el.authPassword.value = '';
        INVITES.resetTurnstile('turnstileWidget');
        showInvitePanel(data.invite, email);
      } catch (error) {
        authMessage(error.message || 'No se pudo enviar la solicitud.');
        INVITES.resetTurnstile('turnstileWidget');
      } finally { setAuthBusy(false); }
      return;
    }

    setAuthBusy(true); authMessage('');
    try {
      const login = await inviteCall('auth.login', { email, password });
      const data = login.session;
      const session = normalizeSession(data);
      if (!session) throw new Error('No se pudo iniciar sesión.');
      saveSession(session);
      if (await ensureWebAccess(session)) await enterApp();
    } catch (err) {
      let msg = (err && err.message) || 'Error.';
      if (/invalid login/i.test(msg)) msg = 'Correo o contraseña incorrectos.';
      else if (/email not confirmed/i.test(msg)) {
        const tracker = INVITES.loadTracker();
        if (tracker && tracker.email === email) { await refreshInviteStatus(); return; }
        msg = 'Tu cuenta todavía está pendiente de verificación manual.';
      }
      authMessage(msg);
    } finally { setAuthBusy(false); }
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
    // El Modo Razonamiento (4 factores) es 100% MANUAL: arranca SIEMPRE apagado en
    // cada carga y solo corre cuando el usuario pulsa "Razonar" en esa sesion. No se
    // restaura de localStorage para que nunca se dispare solo el pipeline premium.
    state.reasoning = false;
    renderReasonBtn();
    // Programar tambien arranca apagado en cada carga (igual que Razonar).
    state.programMode = false;
    state.program = null;
    renderProgramBtn();
    state.createMode = false;
    renderCreateBtn();
    state.manualModel = 'auto';
    renderModelBar();
    state.osConnected = null; // comprobando hasta el primer sondeo
    renderEngineBadge();
    if (state.engine === 'os') startEnginePresence();
    await loadConvos();
    state.activeId = state.convos[0] ? state.convos[0].id : null;
    renderConvoList(); renderMessages(); syncComposerMode();
    el.input.focus();

    await fetchStatus();
    syncPull();
  }

  function logout() {
    stopInvitePolling();
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
    el.authTabs = $('#authTabs'); el.authForm = $('#authForm'); el.authEmail = $('#authEmail'); el.authPassword = $('#authPassword');
    el.passwordRules = $('#passwordRules'); el.turnstileWrap = $('#turnstileWrap');
    el.authSubmit = $('#authSubmit'); el.authBtnLabel = el.authSubmit.querySelector('.btn-label');
    el.authSpinner = el.authSubmit.querySelector('.btn-spinner'); el.authMsg = $('#authMsg'); el.authFoot = $('#authFoot');
    el.havePinBtn = $('#havePinBtn'); el.invitePanel = $('#invitePanel'); el.inviteStatusIcon = $('#inviteStatusIcon');
    el.inviteStatusTitle = $('#inviteStatusTitle'); el.inviteStatusText = $('#inviteStatusText'); el.inviteMaskedEmail = $('#inviteMaskedEmail');
    el.inviteExpiry = $('#inviteExpiry'); el.inviteRefreshBtn = $('#inviteRefreshBtn'); el.inviteLoginBtn = $('#inviteLoginBtn');
    el.pinForm = $('#pinForm'); el.pinEmail = $('#pinEmail'); el.pinCode = $('#pinCode'); el.pinSubmit = $('#pinSubmit');
    el.pinSpinner = el.pinSubmit.querySelector('.pin-spinner'); el.pinMsg = $('#pinMsg'); el.pinBackBtn = $('#pinBackBtn');
    el.forgotPasswordBtn = $('#forgotPasswordBtn'); el.resetForm = $('#resetForm'); el.resetEmail = $('#resetEmail');
    el.resetTurnstile = $('#resetTurnstile'); el.resetPinFields = $('#resetPinFields'); el.resetPin = $('#resetPin'); el.resetPassword = $('#resetPassword');
    el.resetPasswordConfirm = $('#resetPasswordConfirm'); el.resetNotice = $('#resetNotice'); el.resetTitle = $('#resetTitle'); el.resetIntro = $('#resetIntro');
    el.resetSubmit = $('#resetSubmit'); el.resetBtnLabel = el.resetSubmit.querySelector('.reset-btn-label'); el.resetSpinner = el.resetSubmit.querySelector('.reset-spinner');
    el.resetMsg = $('#resetMsg'); el.resetHavePinBtn = $('#resetHavePinBtn'); el.resetBackBtn = $('#resetBackBtn');
    el.menuBtn = $('#menuBtn'); el.statusDot = $('#statusDot'); el.modelLabel = $('#modelLabel'); el.engineBadge = $('#engineBadge');
    el.creditsBtn = $('#creditsBtn'); el.planTag = $('#planTag');
    el.usageFill = $('#usageFill'); el.usageVal = $('#usageVal'); el.usageLabel = $('#usageLabel');
    el.newChatTop = $('#newChatTop');
    el.creditsPanel = $('#creditsPanel'); el.cpPlan = $('#cpPlan');
    el.cpWeek = $('#cpWeek'); el.cpWeekTxt = $('#cpWeekTxt'); el.cpMonth = $('#cpMonth'); el.cpMonthTxt = $('#cpMonthTxt');
    el.cpWindow = $('#cpWindow'); el.cpWindowTxt = $('#cpWindowTxt'); el.cpNote = $('#cpNote');
    el.cpReasonRow = $('#cpReasonRow'); el.cpReason = $('#cpReason'); el.cpReasonTxt = $('#cpReasonTxt');
    el.drawer = $('#drawer'); el.scrim = $('#scrim'); el.convoList = $('#convoList');
    el.newChatBtn = $('#newChatBtn'); el.closeDrawerBtn = $('#closeDrawerBtn'); el.logoutBtn = $('#logoutBtn');
    el.settingsBtn = $('#settingsBtn'); el.settingsModal = $('#settingsModal'); el.settingsClose = $('#settingsClose');
    el.engineToggle = $('#engineToggle'); el.engineStatus = $('#engineStatus'); el.engineDot = $('#engineDot');
    el.userName = $('#userName'); el.userEmail = $('#userEmail'); el.userAvatar = $('#userAvatar');
    el.messages = $('#messages'); el.welcome = $('#welcome'); el.suggestions = $('#suggestions');
    // Visualizador: toggle de la vista previa de codigo (delegado).
    if (el.messages && !el.messages._previewBound) {
      el.messages._previewBound = true;
      el.messages.addEventListener('click', (e) => {
        const closeBtn = e.target.closest && e.target.closest('[data-preview-close]');
        if (closeBtn) {
          const frame = closeBtn.closest('.code-preview-frame');
          closePreviewFrame(frame);
          return;
        }
        const dlBtn = e.target.closest && e.target.closest('[data-preview-download]');
        if (dlBtn) {
          const dlWrap = dlBtn.closest('.code-preview');
          const iframe = dlWrap && dlWrap.querySelector('.code-preview-iframe');
          const doc = lastProgramDoc(activeConvo()) || (iframe ? iframe.getAttribute('data-doc') : '');
          downloadPreviewDoc(doc, dlBtn.getAttribute('data-preview-download'));
          return;
        }
        const editBtn = e.target.closest && e.target.closest('[data-preview-edit]');
        if (editBtn) {
          closePreviewFrame(editBtn.closest('.code-preview-frame'));
          openProgramEdit(lastProgramDoc(activeConvo()));
          return;
        }
        const codeBtn = e.target.closest && e.target.closest('[data-preview-code]');
        if (codeBtn) {
          const wrap = codeBtn.closest('.code-preview');
          const panel = wrap && wrap.querySelector('.code-preview-code');
          const frame = wrap && wrap.querySelector('.code-preview-frame');
          if (frame) closePreviewFrame(frame);
          if (panel) panel.hidden = !panel.hidden;
          return;
        }
        const codeClose = e.target.closest && e.target.closest('[data-preview-codeclose]');
        if (codeClose) {
          const panel = codeClose.closest('.code-preview-code');
          if (panel) panel.hidden = true;
          return;
        }
        const copyBtn = e.target.closest && e.target.closest('[data-preview-copy]');
        if (copyBtn) {
          const wrap = copyBtn.closest('.code-preview');
          const codeEl = wrap && wrap.querySelector('.code-preview-pre code');
          copyTextToClipboard(codeEl ? codeEl.textContent : '', copyBtn);
          return;
        }
        const btn = e.target.closest && e.target.closest('[data-preview-toggle]');
        if (!btn) return;
        const wrap = btn.closest('.code-preview');
        const frame = wrap && wrap.querySelector('.code-preview-frame');
        if (!frame) return;
        const panel = wrap && wrap.querySelector('.code-preview-code');
        if (panel) panel.hidden = true;
        const show = frame.hidden;
        frame.hidden = !show;
        frame.classList.toggle('is-fullscreen-preview', show);
        const label = btn.querySelector('.cpl-label');
        if (label) label.textContent = show ? 'Página abierta' : 'Abrir página';
      });
    }
    el.composer = $('#composer'); el.input = $('#input'); el.sendBtn = $('#sendBtn'); el.reasonBtn = $('#reasonBtn'); el.createBtn = $('#createBtn');
    el.programBtn = $('#programBtn'); el.programModal = $('#programModal'); el.programClose = $('#programClose'); el.programBody = $('#programBody');
    el.modelPickerBtn = $('#modelPickerBtn'); el.modelPickerLabel = $('#modelPickerLabel'); el.modelMenu = $('#modelMenu'); el.composerHint = $('#composerHint');
    el.proModal = $('#proModal'); el.proClose = $('#proClose'); el.proBuyBtn = $('#proBuyBtn'); el.proSub = $('#proSub');
    el.themeSeg = $('#themeSeg');
    el.icSend = el.sendBtn.querySelector('.ic-send'); el.icStop = el.sendBtn.querySelector('.ic-stop');
  }

  async function init() {
    cache();
    try { applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'); } catch (_) { applyTheme('dark'); }
    if (!SB_URL || !SB_KEY) { authMessage('Falta configurar Supabase en config.js.'); return; }
    document.querySelectorAll('[data-auth-tab]').forEach((t) => t.addEventListener('click', () => setAuthMode(t.getAttribute('data-auth-tab'))));
    el.authForm.addEventListener('submit', handleAuthSubmit);
    el.pinForm.addEventListener('submit', handlePinSubmit);
    el.resetForm.addEventListener('submit', handleResetSubmit);
    el.forgotPasswordBtn.addEventListener('click', () => showResetForm(false));
    el.resetHavePinBtn.addEventListener('click', () => showResetForm(true));
    el.resetBackBtn.addEventListener('click', () => setAuthMode('login'));
    el.resetPin.addEventListener('input', () => { el.resetPin.value = el.resetPin.value.replace(/\D/g, '').slice(0, 6); });
    el.resetForm.querySelectorAll('.password-toggle').forEach((btn) => btn.addEventListener('click', () => {
      const input = el.resetForm.querySelector('#' + btn.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Ocultar' : 'Ver';
      btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
    }));
    el.havePinBtn.addEventListener('click', () => showPinPanel(el.authEmail.value));
    el.pinBackBtn.addEventListener('click', () => setAuthMode('login'));
    el.inviteLoginBtn.addEventListener('click', () => setAuthMode('login'));
    el.inviteRefreshBtn.addEventListener('click', refreshInviteStatus);
    el.pinCode.addEventListener('input', () => { el.pinCode.value = el.pinCode.value.replace(/\D/g, '').slice(0, 6); });
    bindApp();
    setAuthMode('login');

    const stored = loadSession();
    if (stored && stored.access_token) {
      state.session = stored;
      const token = await ensureToken();
      if (token) {
        stored.access_token = token;
        try { if (await ensureWebAccess(stored)) await enterApp(); }
        catch (error) { clearSession(); authMessage(error.message || 'No se pudo comprobar el acceso web.'); }
      } else { clearSession(); }
    }

    if (el.appScreen.hidden) {
      const tracker = INVITES && INVITES.loadTracker();
      if (tracker) await refreshInviteStatus();
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();








