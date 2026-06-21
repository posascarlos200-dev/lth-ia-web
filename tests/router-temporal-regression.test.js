// Regresion del router de actualidad/contexto (Capas 1-5).
// Cubre el ruteo determinista derivado de los casos P1..P5 de
// "Fallos de Mady Pro-(auto)". No usa red: solo valida validateDecision/chooseModel
// y el estado de conversacion (entidad activa, estudio biblico, modo creador).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ 1) Router (vendor/lth-router.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'lth-router.js'), 'utf8');
const routerCtx = { window: {}, JSON, Math };
vm.runInNewContext(routerSrc, routerCtx, { filename: 'lth-router.js' });
const R = routerCtx.window.LTHRouter;
assert.ok(R && typeof R.validateDecision === 'function' && typeof R.chooseModel === 'function', 'LTHRouter no expuesto');

const auto = { manualMode: 'auto' };
const pro = { userPlan: 'pro', manualMode: 'auto' };
const decide = (raw) => R.validateDecision(raw, auto);
const routeOf = (raw) => R.chooseModel(decide(raw), pro);

// P1/P4: presidente actual (una entidad temporal) -> tier web, no standard/memoria.
{
  const d = decide({ category: 'business', target_tier: 'standard', confidence: 0.9, needs_temporal_check: true, entities_mentioned: ['Estados Unidos'] });
  assert.equal(d.needs_web, true, 'temporal debe forzar needs_web');
  assert.equal(R.chooseModel(d, pro).tier, 'web', 'presidente actual debe ir a web');
}

// P1/P4: correccion con baja confianza sobre premium -> degradar y mandar a web (no premium caro).
{
  const d = decide({ category: 'reasoning', target_tier: 'premium', confidence: 0.3, correction_detected: true });
  assert.equal(d.needs_web, true, 'correccion debe forzar web');
  assert.notEqual(d.target_tier, 'premium', 'correccion no debe quedarse en premium');
  assert.equal(R.chooseModel(d, pro).tier, 'web', 'correccion debe rutear a web');
}

// P4: multi-entidad (4 paises) -> multi_entity true + web.
{
  const d = decide({ category: 'business', target_tier: 'standard', confidence: 0.9, needs_temporal_check: true, entities_mentioned: ['USA', 'Honduras', 'China', 'Ucrania'] });
  assert.equal(d.multi_entity, true, 'cuatro entidades => multi_entity');
  assert.equal(R.chooseModel(d, pro).tier, 'web');
}

// P2: precio bitcoin / retail local -> web (datos vivos).
{
  const d = decide({ category: 'business', target_tier: 'standard', confidence: 0.85, local_retail: { city: 'Dallas', store: 'homedepoot', product: '2x4' } });
  assert.equal(d.needs_web, true, 'local_retail debe forzar web');
  assert.equal(d.local_retail.store, 'homedepoot');
  assert.equal(R.chooseModel(d, pro).tier, 'web');
}

// P5: cita biblica se conserva en la decision (alimenta estudio activo).
{
  const d = decide({ category: 'simple_chat', target_tier: 'standard', confidence: 0.9, biblical_ref: { book: 'Apocalipsis', chapter: '10', verses: '1-2' } });
  assert.equal(d.biblical_ref.book, 'Apocalipsis');
  assert.equal(d.biblical_ref.verses, '1-2');
}

// Charla trivial NO debe forzar web ni escalar (no romper el tier barato).
{
  const d = decide({ category: 'simple_chat', target_tier: 'cheap', can_deepseek_answer: true, confidence: 0.95 });
  assert.equal(d.needs_web, false, 'saludo no debe ir a web');
  assert.equal(R.chooseModel(d, pro).tier, 'cheap');
}

// Anti-sobrecosto preservado: premium con baja confianza y SIN temporal -> standard.
{
  const d = decide({ category: 'business', target_tier: 'premium', confidence: 0.4 });
  assert.equal(d.target_tier, 'standard', 'premium dudoso no temporal => standard');
  assert.equal(d.needs_web, false);
}

// Imagen y bloqueo intactos.
assert.equal(routeOf({ category: 'image_generation', target_tier: 'standard', confidence: 0.9 }).tier, 'image');
assert.equal(routeOf({ category: 'unsafe', confidence: 0.9 }).action, 'block');

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ 2) Estado de conversacion + prompts (app.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const store = new Map();
const docStub = {
  readyState: 'loading', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ className: '', innerHTML: '', textContent: '', appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, classList: { add: noop, remove: noop, toggle: noop } }),
  body: { appendChild: noop, classList: { add: noop, remove: noop, toggle: noop } }
};
const ctx = {
  window: { LTH_IA_CONFIG: {} }, document: docStub,
  localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  navigator: {}, location: {}, fetch: async () => ({ ok: true, headers: { get: () => '' }, json: async () => ({}) }),
  setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console, Date, JSON, Math, Set, Map, URL, Intl,
  Blob, Uint8Array, AbortController, atob: (v) => Buffer.from(String(v), 'base64').toString('binary')
};
ctx.window.window = ctx.window; ctx.window.document = docStub; ctx.window.localStorage = ctx.localStorage;
ctx.window.navigator = ctx.navigator; ctx.window.requestAnimationFrame = ctx.requestAnimationFrame;
ctx.window.setTimeout = setTimeout; ctx.window.clearTimeout = clearTimeout; ctx.globalThis = ctx;
vm.runInNewContext(appSrc, ctx, { filename: 'app.js' });
const api = ctx.window.LTH_IA_TEST_API;
assert.ok(api && typeof api.applyConversationState === 'function', 'test API de estado no expuesto');

// Fecha del sistema presente en todo prompt.
const sys = api.composeSystemWithMemory('BASE', { id: 'c0', messages: [], brain: null }, 'hola');
assert.match(sys, /FECHA Y HORA/, 'falta bloque de fecha');
assert.match(sys, /America\/Chicago/, 'falta zona horaria');
assert.match(sys, /HONESTIDAD/, 'falta guarda anti-falsa-verificacion');

// Entidad activa: una sola entidad se vuelve la activa; la correccion la conserva (anti-deriva).
const convo = { id: 'c1', messages: [], brain: null };
api.applyConversationState(convo, 'quien es el presidente de usa', { entities_mentioned: ['Estados Unidos'], needs_temporal_check: true, correction_detected: false });
assert.equal(api.ensureConvoBrain(convo).active_entity.name, 'Estados Unidos');
api.applyConversationState(convo, 'incorrecto investiga', { entities_mentioned: [], correction_detected: true });
assert.equal(api.ensureConvoBrain(convo).active_entity.name, 'Estados Unidos', 'correccion no debe perder la entidad activa');

// Estudio biblico activo persistente.
api.applyConversationState(convo, 'Apocalipsis 10:1-2', { biblical_ref: { book: 'Apocalipsis', chapter: '10', verses: '1-2' }, entities_mentioned: [] });
assert.equal(api.ensureConvoBrain(convo).active_study.book, 'Apocalipsis');

// Modo creador sticky.
api.applyConversationState(convo, 'soy tu creador', { creator_mode: true, entities_mentioned: [] });
assert.equal(api.ensureConvoBrain(convo).creator_mode, true);

// La memoria del chat ya inyecta entidad/estudio/creador.
const sys2 = api.composeSystemWithMemory('BASE', convo, 'de usa?');
assert.match(sys2, /ENTIDAD ACTIVA/);
assert.match(sys2, /ESTUDIO BIBLICO ACTIVO/);
assert.match(sys2, /MODO CREADOR/);

// Guidance por categoria.
const webG = api.buildCategoryGuidance({ needs_web: true, multi_entity: true, entities_mentioned: ['USA', 'Honduras'] }, null);
assert.match(webG, /MULTI-ENTIDAD/);
assert.match(webG, /ANCLA TEMPORAL/, 'toda busqueda web debe anclar la fecha primero');
assert.match(webG, /FRONTERA DE DIA ESTRICTA/, 'debe filtrar estricto por el dia de hoy');
assert.match(webG, /SOLO LO COMPROBADO/, 'toda busqueda web debe exigir fuentes y auto-filtrar');
assert.match(webG, /Fuentes:/, 'toda busqueda web debe cerrar con la lista de fuentes');
const webG2 = api.buildCategoryGuidance({ needs_web: true, multi_entity: false, entities_mentioned: [] }, null);
assert.match(webG2, /ANCLA TEMPORAL/);
assert.match(webG2, /SOLO LO COMPROBADO/);
assert.match(webG2, /Fuentes:/);
assert.match(api.buildCategoryGuidance({ needs_web: false, local_retail: { city: 'Dallas', store: 'Home Depot', product: '2x4' }, entities_mentioned: [] }, null), /RETAIL/);
assert.match(api.buildCategoryGuidance({ needs_web: false, biblical_ref: { book: 'Apocalipsis' }, entities_mentioned: [] }, null), /BIBLICO/);

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ 3) Flujo de programacion en Razonar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// Orquestador con clarificacion de opciones para codigo.
assert.match(api.ORCHESTRATOR_PROMPT, /codigo/i);
assert.match(api.ORCHESTRATOR_PROMPT, /\(recomendada\)/);
// Los 3 agentes de build existen y son distintos.
assert.equal(typeof api.CODE_STRUCTURE_PROMPT, 'string');
assert.match(api.CODE_STRUCTURE_PROMPT, /ESTRUCTURA/);
assert.match(api.CODE_CSS_PROMPT, /CSS/);
assert.match(api.CODE_POLISH_PROMPT, /PULIDO|QA/);
// Etiquetas de etapa nuevas.
assert.match(api.reasonStageHtml('code_structure'), /estructura/i);
assert.match(api.reasonStageHtml('code_css'), /CSS/i);
assert.match(api.reasonStageHtml('code_polish'), /[Pp]uliendo/);

// Herramienta Programar: el asistente pide opciones (max 3, 1a recomendada) o plan.
assert.equal(typeof api.PROGRAM_WIZARD_PROMPT, 'string');
assert.match(api.PROGRAM_WIZARD_PROMPT, /recomendada/i);
assert.match(api.PROGRAM_WIZARD_PROMPT, /"phase": "ask"/);
assert.match(api.PROGRAM_WIZARD_PROMPT, /"phase": "plan"/);

const programStep = {
  phase: 'ask',
  question: 'Que estilo visual quieres para la pagina?',
  options: [
    { label: 'Deportivo moderno', value: 'deportivo-moderno', recommended: true },
    { label: 'Oscuro premium', value: 'oscuro-premium' }
  ]
};
assert.equal(typeof api.programStepSignature, 'function');
assert.equal(typeof api.formatProgramChoice, 'function');
assert.equal(typeof api.buildProgramFallbackPlan, 'function');
assert.match(api.programStepSignature(programStep), /que estilo visual quieres/i);
assert.equal(api.formatProgramChoice(programStep, 'Oscuro premium'), 'Que estilo visual quieres para la pagina? -> Oscuro premium');
const fallbackPlan = api.buildProgramFallbackPlan({
  request: 'Creame una pagina de futbol',
  answers: [
    'Tipo de pagina -> Landing page',
    'Que estilo visual quieres para la pagina? -> Oscuro premium'
  ]
}, programStep);
assert.match(fallbackPlan, /Creame una pagina de futbol/i);
assert.match(fallbackPlan, /Landing page/);
assert.match(fallbackPlan, /Ya hay suficiente contexto para construir la primera version/i);

// Charla trivial: salta clasificador/memoria. Conservador y SIN romper correcciones.
assert.equal(typeof api.looksTrivial, 'function');
assert.equal(api.looksTrivial('hola'), true);
assert.equal(api.looksTrivial('Hola Mady'), true);
assert.equal(api.looksTrivial('buenos dias'), true);
assert.equal(api.looksTrivial('gracias'), true);
assert.equal(api.looksTrivial('ok perfecto'), true);
assert.equal(api.looksTrivial('hola, cuanto esta el bitcoin?'), false, 'pregunta no es trivial');
assert.equal(api.looksTrivial('quien es el presidente de usa'), false);
assert.equal(api.looksTrivial('no, eso esta mal'), false, 'correccion no es trivial');
assert.equal(api.looksTrivial('incorrecto'), false, 'correccion no es trivial');
assert.equal(api.looksTrivial('hazme una pagina de deportes'), false);

// Programar: el documento se arma en CODIGO (no lo reconstruye un modelo).
assert.equal(typeof api.extractFencedCode, 'function');
assert.equal(typeof api.assembleProgramDoc, 'function');
assert.equal(api.extractFencedCode('texto\n```css\n.a{color:red}\n```\nmas', ['css']), '.a{color:red}');
assert.equal(api.extractFencedCode('```html\n<div>x</div>\n```', ['html']), '<div>x</div>');
{
  const doc = api.assembleProgramDoc('<main>Hola</main>', '.x{color:red}', 'console.log(1)');
  assert.match(doc, /<!DOCTYPE html>/i, 'arma documento completo');
  assert.match(doc, /<style>[\s\S]*\.x\{color:red\}/, 'incrusta el CSS');
  assert.match(doc, /<script>[\s\S]*console\.log\(1\)/, 'incrusta el JS');
  assert.match(doc, /<main>Hola<\/main>/, 'conserva el HTML');
}
{
  // Si la estructura ya es un documento completo, inyecta CSS en head y JS antes de </body>.
  const full = api.assembleProgramDoc('<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>', '.y{}', 'var z=1');
  assert.match(full, /<style>[\s\S]*\.y\{\}[\s\S]*<\/head>/, 'CSS al head');
  assert.match(full, /<script>[\s\S]*var z=1[\s\S]*<\/body>/, 'JS antes de cerrar body');
}

console.log('router-temporal-regression: OK');

