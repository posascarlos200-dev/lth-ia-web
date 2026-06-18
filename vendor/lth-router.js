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
    next.reason_short = String(next.reason_short || '').trim().slice(0, 220);
    if (attachmentKinds.indexOf('pdf') !== -1 || attachmentKinds.indexOf('file') !== -1) {
      next.needs_files = true;
      if (next.category === 'unknown') next.category = 'file_analysis';
    }
    if (next.target_tier === 'max' && manualMode !== 'reasoning') next.target_tier = 'premium';
    if (next.confidence < 0.65 && next.target_tier === 'premium') next.target_tier = next.needs_files ? 'code' : 'standard';
    if (next.category === 'image_generation' || next.category === 'image_editing') { next.target_tier = 'image'; next.needs_image_model = true; }
    if (next.category === 'unsafe') next.target_tier = 'blocked';
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
