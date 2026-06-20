/* LTH IA Router (portado del OS: src/lth-ia/router) — mismo motor de
   "pensar en automatico" que Mady de LTH OS. Clasifica la intencion con un
   modelo barato y elige el modelo fuerte por categoria. Expuesto como
   window.LTHRouter. Sin dependencias. */
(function () {
  'use strict';

  var MODEL_CONFIG = {
    router: { model: 'google/gemini-2.5-flash-lite', maxTokens: 350, temperature: 0, responseFormat: { type: 'json_object' } },
    tiers: {
      cheap: { id: 'cheap', primary: 'google/gemini-2.5-flash-lite', maxTokens: 4000, temperature: 0.2, reasoning: { enabled: true, effort: 'minimal', exclude: true }, fallbacks: ['google/gemini-2.5-flash'] },
      standard: { id: 'standard', primary: 'google/gemini-2.5-flash', maxTokens: 8000, temperature: 0.25, reasoning: { enabled: true, effort: 'low', exclude: true }, fallbacks: ['google/gemini-2.5-flash-lite'] },
      code: { id: 'code', primary: 'deepseek/deepseek-v4-pro', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'medium', exclude: true }, fallbacks: ['qwen/qwen3-coder-flash', 'google/gemini-2.5-flash'] },
      premium: { id: 'premium', primary: 'z-ai/glm-5.2', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'medium', exclude: true }, fallbacks: ['google/gemini-2.5-flash'] },
      max: { id: 'max', primary: 'anthropic/claude-fable-5', maxTokens: 16000, temperature: 0.2, reasoning: { enabled: true, effort: 'high', exclude: true }, fallbacks: ['anthropic/claude-sonnet-4.6'] },
      image: { id: 'image', primary: 'google/gemini-3.1-flash-image-preview', maxTokens: 1200, temperature: 0.5, modalities: ['image', 'text'], imageConfig: { aspect_ratio: '1:1', image_size: '1K' }, reasoning: { enabled: true, effort: 'minimal', exclude: true }, fallbacks: ['google/gemini-2.5-flash-image'] },
      files: { id: 'files', primary: 'google/gemini-2.5-flash', maxTokens: 8000, temperature: 0.25, reasoning: { enabled: true, effort: 'low', exclude: true }, fallbacks: ['google/gemini-2.5-flash-lite'] },
      web: { id: 'web', primary: 'perplexity/sonar', maxTokens: 4000, temperature: 0.1, reasoning: { enabled: true, effort: 'low', exclude: true }, fallbacks: ['google/gemini-2.5-flash'] }
    }
  };

  var ROUTER_CATEGORIES = ['simple_chat', 'translation', 'rewrite_message', 'code', 'debug', 'app_architecture', 'reasoning', 'business', 'image_generation', 'image_editing', 'file_analysis', 'rag_needed', 'unsafe', 'unknown'];
  var ROUTER_TIERS = ['cheap', 'standard', 'code', 'premium', 'max', 'image', 'blocked'];

  var PLAN_LIMITS = {
    free: { allowPremium: false, allowImage: false },
    basic: { allowPremium: false, allowImage: false },
    pro: { allowPremium: true, allowImage: true },
    studio: { allowPremium: true, allowImage: true },
    ultra: { allowPremium: true, allowImage: true }
  };
  function normalizePlan(plan) {
    var v = String(plan || 'free').trim().toLowerCase();
    return PLAN_LIMITS[v] ? v : 'free';
  }
  function getPlanLimits(plan) { return PLAN_LIMITS[normalizePlan(plan)]; }

  function getClassifierPrompt() {
    return [
      'Eres el clasificador interno de LTH AI Router.',
      '',
      'Tu trabajo NO es responder al usuario.',
      'Tu trabajo es analizar la solicitud y decidir que modelo debe responder.',
      '',
      'Debes clasificar la peticion con precision pensando en costo, dificultad, tipo de tarea, necesidad de archivos, razonamiento profundo, imagen, contexto del proyecto y riesgo de seguridad.',
      '',
      'Reglas importantes:',
      '1. Usa cheap SOLO para charla trivial: saludos, frases cortas sin contenido tecnico, confirmaciones.',
      '2. Si la tarea es traduccion, correccion de texto o mensaje para enviar, usa cheap.',
      '2b. Preguntas de conocimiento o tecnicas (tecnologia, IA, herramientas, historia, ciencia, comparativas, recomendaciones, "cuales son los mejores...", "investiga...", "explicame...") usan standard como minimo aunque parezcan cortas.',
      '3. Si la tarea requiere codigo, debugging o arquitectura tecnica, usa code.',
      '4. Si la tarea requiere decisiones complejas, estrategia, logica profunda, arquitectura o documentacion compleja, usa premium.',
      '5. Si la tarea pide crear, editar, generar, renderizar o modificar una imagen (logos, banners, fotos, dibujos), usa image.',
      '5b. Si la pregunta necesita informacion actual de internet o posterior a tu corte (noticias, lanzamientos, precios de hoy, versiones nuevas) o el usuario dice "investiga"/"busca en internet", marca needs_web como true.',
      '6. Si la tarea necesita documentos, archivos del usuario o codigo del proyecto, marca needs_context como true.',
      '7. Si no estas seguro, usa standard, no premium.',
      '8. Nunca escales a premium si el modelo rapido base puede resolverlo bien.',
      '9. Devuelve SOLO JSON valido. No expliques nada fuera del JSON.',
      '',
      'Senales temporales y de contexto (rellena estos campos con cuidado):',
      '10. needs_temporal_check = true si la respuesta correcta depende del momento actual: cargos publicos (presidente, ministro, alcalde, CEO), precios o mercados (bitcoin, dolar, acciones), resultados o calendarios deportivos, leyes/versiones recientes, o si aparece "actual", "hoy", "ahora", "ultimo", "reciente", "vigente", "este ano", "2026", "investiga", "verifica", "en la actualidad".',
      '11. correction_detected = true si el usuario corrige o rechaza una respuesta previa: "incorrecto", "estas mal", "no es asi", "eso fue el ano pasado", "sigue fallando", "estas atrasado", "no", "nooo", "tu informacion esta mal".',
      '12. entities_mentioned = lista de entidades concretas de la peticion (paises, personas, empresas, selecciones). multi_entity = true si hay 2 o mas entidades que verificar por separado.',
      '13. local_retail = objeto {city, store, product} si es una compra local, precio de tienda o asesoria de producto (Home Depot, Lowes, "cuanto vale", "que me recomiendas comprar"); si no aplica, null. Si local_retail no es null, marca needs_web true.',
      '14. biblical_ref = objeto {book, chapter, verses} si el usuario cita o estudia un pasaje biblico (ej. "Apocalipsis 10:1-2"); si no aplica, null.',
      '15. creator_mode = true si el usuario declara ser el creador/programador del sistema o reporta que esta version esta mal programada ("soy tu creador", "se como te programe", "esta version esta defectuosa").',
      '',
      'Categorias permitidas: simple_chat, translation, rewrite_message, code, debug, app_architecture, reasoning, business, image_generation, image_editing, file_analysis, rag_needed, unsafe, unknown',
      'Niveles permitidos: cheap, standard, code, premium, image, blocked',
      '',
      'Formato obligatorio:',
      '{',
      '  "category": "",',
      '  "target_tier": "",',
      '  "can_deepseek_answer": true,',
      '  "confidence": 0.0,',
      '  "needs_context": false,',
      '  "needs_files": false,',
      '  "needs_image_model": false,',
      '  "needs_web": false,',
      '  "needs_temporal_check": false,',
      '  "correction_detected": false,',
      '  "entities_mentioned": [],',
      '  "multi_entity": false,',
      '  "local_retail": null,',
      '  "biblical_ref": null,',
      '  "creator_mode": false,',
      '  "estimated_input_tokens": 0,',
      '  "estimated_output_tokens": 0,',
      '  "reason_short": ""',
      '}'
    ].join('\n');
  }

  function extractMessageText(content) {
    if (Array.isArray(content)) {
      return content.map(function (part) {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[image]';
        return '';
      }).filter(Boolean).join('\n');
    }
    return String(content || '');
  }

  function summarizeHistory(history, limit) {
    limit = limit || 4;
    if (!Array.isArray(history)) return [];
    return history.filter(function (i) { return i && (i.role === 'user' || i.role === 'assistant'); })
      .slice(-limit)
      .map(function (i) { return { role: i.role, text: extractMessageText(i.content).replace(/\s+/g, ' ').trim().slice(0, 240) }; })
      .filter(function (i) { return i.text; });
  }

  function buildClassifierInput(opts) {
    opts = opts || {};
    var atts = Array.isArray(opts.attachmentKinds) ? opts.attachmentKinds.filter(Boolean) : [];
    return JSON.stringify({
      user_plan: String(opts.userPlan || 'free'),
      manual_mode: String(opts.manualMode || 'auto'),
      has_attachments: atts.length > 0,
      attachment_kinds: atts,
      history_summary: summarizeHistory(opts.history || [], 4),
      user_message: String(opts.userMessage || '').trim()
    }, null, 2);
  }

  function validateDecision(decision, context) {
    var next = decision && typeof decision === 'object' ? Object.assign({}, decision) : {};
    context = context || {};
    var manualMode = String(context.manualMode || 'auto').trim().toLowerCase();
    var attachmentKinds = Array.isArray(context.attachmentKinds) ? context.attachmentKinds : [];
    if (ROUTER_CATEGORIES.indexOf(next.category) === -1) next.category = 'unknown';
    if (ROUTER_TIERS.indexOf(next.target_tier) === -1) next.target_tier = 'standard';
    next.can_deepseek_answer = next.can_deepseek_answer !== false;
    next.confidence = isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.5;
    next.confidence = Math.max(0, Math.min(1, next.confidence));
    next.needs_context = next.needs_context === true;
    next.needs_files = next.needs_files === true;
    next.needs_image_model = next.needs_image_model === true;
    next.needs_web = next.needs_web === true;
    // Capa 1: senales temporales/contexto (coercion + defaults seguros).
    next.needs_temporal_check = next.needs_temporal_check === true;
    next.correction_detected = next.correction_detected === true;
    next.creator_mode = next.creator_mode === true;
    next.multi_entity = next.multi_entity === true;
    next.entities_mentioned = Array.isArray(next.entities_mentioned)
      ? next.entities_mentioned.map(function (e) { return String(e || '').trim(); }).filter(Boolean).slice(0, 12)
      : [];
    if (next.entities_mentioned.length >= 2) next.multi_entity = true;
    next.local_retail = (next.local_retail && typeof next.local_retail === 'object') ? {
      city: String(next.local_retail.city || '').trim().slice(0, 80),
      store: String(next.local_retail.store || '').trim().slice(0, 80),
      product: String(next.local_retail.product || '').trim().slice(0, 120)
    } : null;
    next.biblical_ref = (next.biblical_ref && typeof next.biblical_ref === 'object' && next.biblical_ref.book) ? {
      book: String(next.biblical_ref.book || '').trim().slice(0, 60),
      chapter: String(next.biblical_ref.chapter || '').trim().slice(0, 12),
      verses: String(next.biblical_ref.verses || '').trim().slice(0, 24)
    } : null;
    next.reason_short = String(next.reason_short || '').trim().slice(0, 220);
    if (attachmentKinds.indexOf('pdf') !== -1 || attachmentKinds.indexOf('file') !== -1) {
      next.needs_files = true;
      if (next.category === 'unknown') next.category = 'file_analysis';
    }
    if (next.target_tier === 'max' && manualMode !== 'reasoning') next.target_tier = 'premium';
    if (next.confidence < 0.65 && next.target_tier === 'premium') next.target_tier = next.needs_files ? 'code' : 'standard';
    if (next.category === 'image_generation' || next.category === 'image_editing') { next.target_tier = 'image'; next.needs_image_model = true; }
    if (next.category === 'unsafe') next.target_tier = 'blocked';
    // Capa 2: actualidad o correccion del usuario OBLIGAN el tier web (datos vivos),
    // sin importar la confianza. Es justo donde Mady fallaba respondiendo standard con
    // memoria vieja. No aplica a imagen, codigo ni a peticiones bloqueadas.
    var temporalForce = next.needs_temporal_check || next.correction_detected;
    var routable = next.category !== 'image_generation' && next.category !== 'image_editing'
      && next.category !== 'code' && next.category !== 'debug' && next.target_tier !== 'blocked';
    if (temporalForce && routable) {
      next.needs_web = true;
      // Quita la ruta cara: web (perplexity/sonar) responde, no premium/max.
      if (next.target_tier === 'premium' || next.target_tier === 'max') next.target_tier = 'standard';
      if (next.category === 'reasoning' || next.category === 'app_architecture') next.category = 'business';
    }
    // Compra local / precio de tienda: tambien exige datos vivos.
    if (next.local_retail && routable) next.needs_web = true;
    return next;
  }

  function buildRoute(tierKey, extra) {
    var tier = MODEL_CONFIG.tiers[tierKey] || MODEL_CONFIG.tiers.standard;
    var r = {
      action: 'route', tier: tier.id, model: tier.primary, maxTokens: tier.maxTokens,
      temperature: tier.temperature, reasoning: tier.reasoning,
      modalities: tier.modalities ? tier.modalities.slice() : undefined,
      image_config: tier.imageConfig ? Object.assign({}, tier.imageConfig) : undefined
    };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }

  function chooseModel(decision, options) {
    decision = decision || {};
    options = options || {};
    var limits = getPlanLimits(options.userPlan);
    if (decision.category === 'unsafe' || decision.target_tier === 'blocked') {
      return { action: 'block', tier: 'blocked', model: null, reason: 'Solicitud bloqueada por seguridad.' };
    }
    if (decision.needs_image_model) {
      if (!limits.allowImage) return buildRoute('standard', { downgradedFrom: 'image' });
      return buildRoute('image', { reason: decision.reason_short || 'Solicitud de imagen.' });
    }
    if (decision.target_tier === 'code' || decision.category === 'code' || decision.category === 'debug') {
      return buildRoute('code', { reason: decision.reason_short || 'Solicitud de codigo.' });
    }
    if (decision.target_tier === 'premium' || decision.category === 'app_architecture' || decision.category === 'reasoning') {
      if (!limits.allowPremium) return buildRoute('standard', { downgradedFrom: 'premium' });
      return buildRoute('premium', { reason: decision.reason_short || 'Razonamiento complejo.' });
    }
    if (decision.needs_files || decision.category === 'file_analysis' || decision.category === 'rag_needed') {
      return buildRoute('files', { reason: decision.reason_short || 'Solicitud con archivos.' });
    }
    if (decision.needs_web) {
      return buildRoute('web', { reason: decision.reason_short || 'Solicitud con web.' });
    }
    var cheapCategories = ['simple_chat', 'translation', 'rewrite_message'];
    if (decision.can_deepseek_answer && decision.confidence >= 0.85 && decision.target_tier === 'cheap' && cheapCategories.indexOf(decision.category) !== -1) {
      return buildRoute('cheap', { reason: decision.reason_short || 'Solicitud simple.' });
    }
    return buildRoute('standard', { reason: decision.reason_short || 'Solicitud estandar.' });
  }

  window.LTHRouter = {
    MODEL_CONFIG: MODEL_CONFIG,
    getClassifierPrompt: getClassifierPrompt,
    buildClassifierInput: buildClassifierInput,
    validateDecision: validateDecision,
    chooseModel: chooseModel,
    getPlanLimits: getPlanLimits,
    normalizePlan: normalizePlan
  };
})();
