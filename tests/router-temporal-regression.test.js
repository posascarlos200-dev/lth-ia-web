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
assert.match(api.PROGRAM_WIZARD_PROMPT, /recomendaci/i);
assert.match(api.PROGRAM_WIZARD_PROMPT, /"phase": "ask"/);
assert.match(api.PROGRAM_WIZARD_PROMPT, /"phase": "plan"/);
assert.match(api.PROGRAM_WIZARD_PROMPT, /maximo 3 preguntas/i);
assert.match(api.PROGRAM_WIZARD_PROMPT, /PROMPT MAESTRO/);
assert.match(api.PROGRAM_WIZARD_PROMPT, /description/);

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
assert.match(fallbackPlan, /PROMPT MAESTRO PARA GENERAR EL HTML/i);
assert.match(fallbackPlan, /un unico documento HTML autocontenido/i);
assert.match(fallbackPlan, /experiencia movil excelente/i);

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

// Descarga: separar el doc autocontenido en index.html + style.css + script.js.
{
  const doc = api.assembleProgramDoc('<main>Hola</main>', '.x{color:red}', 'console.log(1)');
  const parts = api.splitProgramDocParts(doc);
  assert.match(parts.css, /\.x\{color:red\}/, 'extrae el CSS');
  assert.match(parts.js, /console\.log\(1\)/, 'extrae el JS');
  assert.match(parts.html, /<link rel="stylesheet" href="style\.css">/, 'enlaza style.css');
  assert.match(parts.html, /<script src="script\.js"><\/script>/, 'enlaza script.js');
  assert.doesNotMatch(parts.html, /<style>/i, 'el html ya no tiene <style> inline');
  assert.match(parts.html, /<main>Hola<\/main>/, 'conserva el contenido');
}

// Programar nuevo: una IA y parches exactos que preservan todo lo no solicitado.
assert.match(api.PROGRAM_CODER_PROMPT, /UNICA IA programadora/);
assert.match(api.PROGRAM_CODER_PROMPT, /un solo archivo HTML/);
assert.match(api.PROGRAM_CODER_PROMPT, /Nunca uses href="\/"/);
assert.match(api.PROGRAM_PATCH_PROMPT, /Nunca devuelvas el HTML completo/);
assert.match(api.PROGRAM_PATCH_PROMPT, /UN SOLO PROYECTO persistente/);
assert.match(api.PROGRAM_PATCH_PROMPT, /razona internamente/i);
assert.match(api.PROGRAM_PATCH_PROMPT, /logo de modo nocturno/i);
assert.match(api.PROGRAM_CODER_PROMPT, /RECURSOS VISUALES OBLIGATORIOS/);
assert.match(api.PROGRAM_PATCH_PROMPT, /Nunca las reemplaces por SVG/);
assert.match(api.PROGRAM_ASSET_SEARCH_PROMPT, /Wikimedia Commons/);
assert.equal(typeof api.applyProgramPatch, 'function');
assert.equal(typeof api.looksLikeNewProgramProject, 'function');
assert.equal(api.looksLikeNewProgramProject('crea otro proyecto'), true);
assert.equal(api.looksLikeNewProgramProject('quiero una nueva pagina'), true);
assert.equal(api.looksLikeNewProgramProject('mejora el logo en modo nocturno'), false);
assert.equal(api.looksLikeNewProgramProject('agrega otra sección de contacto'), false);
assert.equal(typeof api.withPreviewShim, 'function');
assert.equal(typeof api.closePreviewFrame, 'function');
{
  const guarded = api.withPreviewShim('<!doctype html><html><head></head><body><a href="/">Inicio</a></body></html>');
  assert.match(guarded, /document\.addEventListener\("click"/, 'inyecta guardia de navegacion');
  assert.match(guarded, /e\.preventDefault\(\)/, 'bloquea rutas internas del host');
  assert.match(guarded, /scrollIntoView/, 'convierte rutas internas en navegacion local');
  assert.match(guarded, /target="_blank"/, 'los enlaces externos abren fuera del visor');
}
{
  const original = '<!doctype html><html><head><style>.hero{color:red}.card{padding:8px}</style></head><body><h1>Hola</h1><p>Intacto</p></body></html>';
  const patched = api.applyProgramPatch(original, {
    summary: 'titulo actualizado',
    operations: [{ search: '<h1>Hola</h1>', replace: '<h1>Bienvenido</h1>' }]
  });
  assert.equal(patched.doc, original.replace('<h1>Hola</h1>', '<h1>Bienvenido</h1>'));
  assert.match(patched.doc, /<p>Intacto<\/p>/, 'conserva contenido no pedido');
  assert.match(patched.doc, /\.card\{padding:8px\}/, 'conserva CSS no pedido');
  assert.equal(patched.operationCount, 1);
  // Edicion tolerante: una operacion sin ancla NO rompe la edicion; se omite y se reporta,
  // dejando el documento intacto en esa parte (antes lanzaba excepcion y abandonaba todo).
  const notFound = api.applyProgramPatch(original, { operations: [{ search: '<div>no existe</div>', replace: '' }] });
  assert.equal(notFound.changed, false, 'una operacion sin ancla no aplica cambios');
  assert.equal(notFound.operationCount, 0, 'no cuenta operaciones que no ubican el ancla');
  assert.ok(notFound.skipped && notFound.skipped.length >= 1, 'reporta la operacion omitida');
  assert.equal(notFound.doc, original, 'conserva el documento intacto si no ubica el ancla');
  const inserted = api.applyProgramPatch(original, { operations: [{ type: 'insert_after', search: '<h1>Hola</h1>', content: '<img src="car.jpg" alt="Carro">' }] });
  assert.match(inserted.doc, /<h1>Hola<\/h1><img src="car\.jpg"/, 'inserta sin repetir el ancla en la salida del modelo');
  // Garantia de seguridad conservada: nunca reemplaza el documento entero (se omite la op).
  const whole = api.applyProgramPatch(original, { operations: [{ search: original, content: original.replace('Hola', 'Otro') }] });
  assert.equal(whole.changed, false, 'no reemplaza el documento entero');
  assert.equal(whole.doc, original, 'el documento queda intacto ante un reemplazo gigante');
  // Garantia conservada: no permite esconder un HTML completo dentro de content.
  const rebuilt = api.applyProgramPatch(original, { operations: [{ search: '<h1>Hola</h1>', content: '<!doctype html><html><body>Rehecho</body></html>' }] });
  assert.equal(rebuilt.changed, false, 'no reconstruye el documento via content');
  assert.equal(rebuilt.doc, original, 'el documento queda intacto ante un content que reconstruye');
  const outline = api.buildProgramEditOutline('<main id="inicio"><section id="servicios" class="cards grid"><h2>Servicios</h2></section></main>');
  assert.match(outline, /#servicios/);
  assert.ok(outline.length < 4201, 'el mapa del orquestador permanece compacto');
}

{
  const start = appSrc.indexOf('async function runProgramEdit');
  const end = appSrc.indexOf('// El documento va ADJUNTO', start);
  const editSource = appSrc.slice(start, end);
  assert.equal((editSource.match(/await patchOnce\(/g) || []).length, 1, 'una edicion hace un solo intento de parche');
  assert.doesNotMatch(editSource, /PROGRAM_REWRITE_PROMPT|Edicion completa \(Programar\)/, 'editar nunca reconstruye el documento');
  assert.match(editSource, /skipAutoFix: true/, 'una edicion no dispara otra IA de autorreparacion');
  assert.match(editSource, /buildProgramEditOutline\(currentDoc\)/, 'el orquestador recibe un mapa compacto, no todo el HTML');
}

// Programar integra fotografias web reales y respeta URLs explicitas sin reconstruir.
{
  const photoIntent = api.detectProgramMediaIntent('Integra fotos reales de carros y servicios');
  assert.equal(photoIntent.active, true);
  assert.equal(photoIntent.needsSearch, true);
  const logoUrl = 'https://cdn.example.com/mi-logo.png';
  const logoIntent = api.detectProgramMediaIntent('Usa ' + logoUrl + ' como logo principal');
  assert.deepEqual(Array.from(logoIntent.explicitUrls), [logoUrl]);
  assert.equal(logoIntent.needsSearch, false);
  assert.equal(api.usableProgramPhotoUrl('https://upload.wikimedia.org/example/car.jpg'), true);
  assert.equal(api.usableProgramPhotoUrl('https://upload.wikimedia.org/example/icon.svg'), false);
  assert.equal(api.usableProgramPhotoUrl('data:image/svg+xml,abc'), false);
  const normalized = api.normalizeProgramAssets({ query: 'car repair', assets: [
    { url: 'https://upload.wikimedia.org/example/car.jpg', alt: 'Auto en taller' },
    { url: 'https://upload.wikimedia.org/example/icon.svg', alt: 'No usar' }
  ] });
  assert.equal(normalized.assets.length, 1, 'filtra SVG y conserva fotografia raster');
  const resolved = { intent: logoIntent, assets: [{ url: logoUrl, explicit: true }] };
  assert.equal(api.programVisualAssetsApplied('<img src="' + logoUrl + '">', resolved), true);
  assert.equal(api.programVisualAssetsApplied('<img src="otra.png">', resolved), false);
}
console.log('router-temporal-regression: OK');
