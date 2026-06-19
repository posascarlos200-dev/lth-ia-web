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
assert.equal(typeof api.normalizeResearchQuery, 'function');
assert.equal(typeof api.detectFreeResearchIntent, 'function');
assert.equal(typeof api.buildFreeResearchContextBlock, 'function');

const stable = api.detectFreeResearchIntent('Quien fue Nikola Tesla?');
assert.equal(stable.matched, true);
assert.equal(stable.freshness, 'stable');
assert.match(stable.query, /Nikola Tesla/i);

const volatile = api.detectFreeResearchIntent('Precio del bitcoin hoy');
assert.equal(volatile.matched, true);
assert.equal(volatile.freshness, 'volatile');
assert.match(volatile.query, /bitcoin/i);

const normalized = api.normalizeResearchQuery('Por favor investiga que es la energia solar?');
assert.equal(normalized, 'la energia solar');

const contextBlock = api.buildFreeResearchContextBlock({
  query: 'nikola tesla',
  freshness: 'volatile',
  sources: [
    {
      title: 'Nikola Tesla',
      source: 'Wikipedia ES',
      url: 'https://es.wikipedia.org/wiki/Nikola_Tesla',
      summary: 'Inventor e ingeniero electrico de origen serbio.'
    },
    {
      title: 'Corriente alterna',
      source: 'Wikipedia ES',
      url: 'https://es.wikipedia.org/wiki/Corriente_alterna',
      summary: 'Sistema electrico asociado a Tesla y Westinghouse.'
    }
  ]
});
assert.match(contextBlock, /INVESTIGACION FREE/i);
assert.match(contextBlock, /Nikola Tesla/);
assert.match(contextBlock, /https:\/\/es\.wikipedia\.org\/wiki\/Nikola_Tesla/);
assert.match(contextBlock, /sensible al tiempo/i);
assert.match(contextBlock, /cita las URLs/i);

// Segunda fuente: DuckDuckGo Instant Answer
assert.equal(typeof api.parseDuckDuckGoResults, 'function');
const ddg = api.parseDuckDuckGoResults({
  Heading: 'Nikola Tesla',
  AbstractText: 'Nikola Tesla fue un inventor e ingeniero electrico serbio-estadounidense.',
  AbstractURL: 'https://duckduckgo.com/Nikola_Tesla',
  RelatedTopics: [
    { Text: 'Corriente alterna - sistema electrico de Tesla', FirstURL: 'https://duckduckgo.com/Corriente_alterna' },
    { Nada: true }
  ]
}, 'nikola tesla');
assert.ok(ddg.length >= 2, 'DDG debe devolver abstract + relacionado');
assert.equal(ddg[0].source, 'DuckDuckGo');
assert.match(ddg[0].summary, /inventor e ingeniero/i);
assert.equal(ddg[0].url, 'https://duckduckgo.com/Nikola_Tesla');
assert.match(ddg[1].title, /Corriente alterna/);
assert.equal(api.parseDuckDuckGoResults(null, 'x').length, 0);

console.log('free-research-layer: 17/17 OK');
