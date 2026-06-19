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
assert.equal(typeof api.normalizeBrain, 'function');
assert.equal(typeof api.extractBrainFromUserMessage, 'function');
assert.equal(typeof api.buildBrainContextBlock, 'function');
assert.equal(typeof api.detectCrisisIntent, 'function');

let brain = api.normalizeBrain();
brain = api.extractBrainFromUserMessage(brain, 'Me llamo Carlos Posas.');
brain = api.extractBrainFromUserMessage(brain, 'Tomo el cafe sin azucar.');
brain = api.extractBrainFromUserMessage(brain, 'Recuerdame que tengo cafe a las 2:20 pm.');
brain = api.extractBrainFromUserMessage(brain, 'Quiero comprar una casa para mi familia.');

assert.equal(brain.user_profile.name_for_this_chat, 'Carlos');
assert.equal(brain.user_profile.full_name, 'Carlos Posas');
assert.ok(brain.preferences.some((item) => /sin azucar/i.test(item)));
assert.ok(brain.commitments.some((item) => /2:20\s*pm/i.test(item)));
assert.match(brain.user_goal, /comprar una casa/i);

const contextBlock = api.buildBrainContextBlock({ brain }, 'Que recuerdas de mi?');
assert.match(contextBlock, /Carlos Posas/);
assert.match(contextBlock, /sin azucar/i);
assert.match(contextBlock, /2:20\s*pm/i);
assert.match(contextBlock, /comprar una casa/i);
assert.doesNotMatch(contextBlock, /con azucar/i);
assert.doesNotMatch(contextBlock, /carro/i);

const crisis = api.detectCrisisIntent('Quiero suicidarme hoy');
assert.equal(crisis.matched, true);
assert.match(crisis.response, /988/);
assert.match(crisis.response, /911/);

console.log('memory-crisis: 12/12 OK');
