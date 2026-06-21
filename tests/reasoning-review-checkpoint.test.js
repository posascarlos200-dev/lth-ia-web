const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const documentStub = {
  readyState: 'loading', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, classList: { add: noop, remove: noop, toggle: noop } }),
  body: { appendChild: noop, classList: { add: noop, remove: noop, toggle: noop } }
};
const context = {
  window: { LTH_IA_CONFIG: {} }, document: documentStub,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: {}, location: {}, fetch: async () => ({ ok: true, headers: { get: () => '' }, json: async () => ({}) }),
  setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console, Date, JSON, Math, Set, Map, URL, Blob, Uint8Array, AbortController,
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary')
};
context.window.window = context.window;
context.window.document = documentStub;
context.window.localStorage = context.localStorage;
context.window.navigator = context.navigator;
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'app.js' });

const api = context.window.LTH_IA_TEST_API;
const pending = {
  id: 'chat_reason', title: 'Razonamiento', updated: 1,
  messages: [{
    id: 'answer_1', role: 'assistant', content: '_Verificando y puliendo la respuesta…_', ts: 10,
    reasoningReview: { status: 'pending', original: 'pedido', improved: 'pedido mejorado', draft: 'borrador valioso', specialistModel: 'modelo-a', attempts: 0, createdAt: 10 }
  }]
};
const stored = api.serializeConvoForCache(pending);
assert.equal(stored.messages[0].reasoningReview.draft, 'borrador valioso');
assert.equal(stored.messages[0].reasoningReview.status, 'pending');

const completed = {
  id: 'chat_reason', title: 'Razonamiento', updated: 2,
  messages: [{
    id: 'answer_1', role: 'assistant', content: 'respuesta final corregida', ts: 10,
    reasoningReview: { status: 'complete', attempts: 1, createdAt: 10, completedAt: 20 }
  }]
};
const merged = api.mergeConvoCollections([pending], [completed]);
assert.equal(merged[0].messages.length, 1, 'el checkpoint y el resultado no deben duplicarse');
assert.equal(merged[0].messages[0].content, 'respuesta final corregida');
assert.equal(merged[0].messages[0].reasoningReview.status, 'complete');

console.log('reasoning review checkpoint: OK');
