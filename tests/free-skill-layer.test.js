const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const store = new Map();
const noop = () => {};
const documentStub = {
  readyState: 'loading',
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    className: '',
    innerHTML: '',
    textContent: '',
    appendChild: noop,
    remove: noop,
    setAttribute: noop,
    addEventListener: noop,
    classList: { add: noop, remove: noop, toggle: noop }
  }),
  body: {
    appendChild: noop,
    classList: { add: noop, remove: noop, toggle: noop }
  }
};

const context = {
  window: { LTH_IA_CONFIG: {} },
  document: documentStub,
  localStorage: {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  },
  navigator: {},
  location: {},
  fetch: async () => ({ ok: true, headers: { get: () => '' }, json: async () => ({}) }),
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => fn(),
  console,
  Date,
  JSON,
  Math,
  Set,
  Map,
  URL,
  Blob,
  Uint8Array,
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary')
};
context.window.window = context.window;
context.window.document = documentStub;
context.window.localStorage = context.localStorage;
context.window.navigator = context.navigator;
context.window.requestAnimationFrame = context.requestAnimationFrame;
context.window.setTimeout = setTimeout;
context.window.clearTimeout = clearTimeout;
context.globalThis = context;

vm.runInNewContext(source, context, { filename: 'app.js' });
const api = context.window.LTH_IA_TEST_API;

assert.ok(api, 'test API missing');
assert.equal(typeof api.detectFreeSkillIntent, 'function');
assert.equal(typeof api.buildFreeSkillSystem, 'function');
assert.equal(typeof api.buildFreeSkillClarification, 'function');

const summarize = api.detectFreeSkillIntent('Resume este texto en puntos clave: La casa tiene tres cuartos y un patio grande.');
assert.equal(summarize.kind, 'summarize');
assert.equal(summarize.hasInlinePayload, true);

const translate = api.detectFreeSkillIntent('Traduce al ingles: buenos dias, familia.');
assert.equal(translate.kind, 'translate');
assert.equal(translate.targetLanguage, 'ingles');

const rewrite = api.detectFreeSkillIntent('Hazlo mas formal: hola, te escribo para pedir informes.');
assert.equal(rewrite.kind, 'rewrite');
assert.equal(rewrite.rewriteTone, 'formal');

const compare = api.detectFreeSkillIntent('Compara');
assert.equal(compare.kind, 'compare');
assert.match(api.buildFreeSkillClarification(compare), /dos opciones exactas/i);

const noSource = api.detectFreeSkillIntent('Corrigelo');
assert.equal(noSource.kind, 'rewrite');
assert.match(api.buildFreeSkillClarification(noSource), /texto exacto/i);

const plan = api.detectFreeSkillIntent('Dame un plan paso a paso para ahorrar y comprar una casa.');
const planSystem = api.buildFreeSkillSystem('BASE', plan);
assert.match(planSystem, /pasos numerados/i);
assert.match(planSystem, /primer paso accionable/i);

const explain = api.detectFreeSkillIntent('Explicame como funciona una hipoteca.');
const explainSystem = api.buildFreeSkillSystem('BASE', explain);
assert.match(explainSystem, /ejemplo breve/i);

console.log('free-skill-layer: 14/14 OK');
