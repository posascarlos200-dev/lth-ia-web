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
  AbortController,
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
assert.equal(typeof api.buildDeviceMemoryRecallBlock, 'function');
assert.equal(typeof api.mergeConvoCollections, 'function');
assert.equal(typeof api.serializeConvoForCache, 'function');

const convo = {
  id: 'chat_1',
  title: 'Chat',
  updated: Date.now(),
  messages: [
    { id: 'u1', role: 'user', content: 'Me llamo Carlos Posas.', ts: 1 },
    { id: 'a1', role: 'assistant', content: 'Mucho gusto, Carlos.', ts: 2 },
    { id: 'u2', role: 'user', content: 'Tomo el cafe sin azucar.', ts: 3 },
    { id: 'a2', role: 'assistant', content: 'Perfecto, cafe sin azucar.', ts: 4 },
    { id: 'u3', role: 'user', content: 'Mi meta es comprar una casa.', ts: 5 },
    { id: 'a3', role: 'assistant', content: 'Queda guardado tu objetivo.', ts: 6 },
    { id: 'u4', role: 'user', content: 'Seguimos con otro tema.', ts: 7 },
    { id: 'a4', role: 'assistant', content: 'Claro.', ts: 8 },
    { id: 'u5', role: 'user', content: 'Mensaje reciente 1', ts: 9 },
    { id: 'a5', role: 'assistant', content: 'Mensaje reciente 2', ts: 10 },
    { id: 'u6', role: 'user', content: 'Mensaje reciente 3', ts: 11 },
    { id: 'a6', role: 'assistant', content: 'Mensaje reciente 4', ts: 12 },
    { id: 'u7', role: 'user', content: 'Mensaje reciente 5', ts: 13 }
  ]
};

const recallCoffee = api.buildDeviceMemoryRecallBlock(convo, 'Como tomo el cafe?');
assert.match(recallCoffee, /sin azucar/i);
assert.match(recallCoffee, /MEMORIA LOCAL DEL DISPOSITIVO/i);

const recallName = api.buildDeviceMemoryRecallBlock(convo, 'Cual es mi apellido?');
assert.match(recallName, /Carlos Posas/);

const merged = api.mergeConvoCollections([
  { id: 'chat_1', title: 'Chat', updated: 10, messages: [{ id: 'm1', role: 'user', content: 'hola', ts: 1 }] }
], [
  { id: 'chat_1', title: 'Chat', updated: 20, messages: [{ id: 'm2', role: 'assistant', content: 'que tal', ts: 2 }] }
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].messages.length, 2);
assert.equal(merged[0].updated, 20);

const longConvo = {
  id: 'chat_2',
  title: 'Largo',
  updated: 50,
  messages: Array.from({ length: 25 }, (_, i) => ({ id: 'x' + i, role: i % 2 ? 'assistant' : 'user', content: 'mensaje ' + i, ts: i + 1 }))
};
const cached = api.serializeConvoForCache(longConvo);
assert.equal(cached.messages.length, 18);
assert.equal(cached.messages[0].content, 'mensaje 7');

console.log('device-memory-layer: 10/10 OK');
