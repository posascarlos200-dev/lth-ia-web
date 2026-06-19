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
assert.equal(typeof api.extractEntities, 'function');
assert.equal(typeof api.detectBrainConflicts, 'function');
assert.equal(typeof api.mergeBrain, 'function');

// --- Recuerdos por entidad: extraccion determinista ---
const personEnts = api.extractEntities('Mi esposa se llama Ana y mi jefe es Carlos.');
const person = personEnts.find((e) => e.type === 'persona');
assert.ok(person, 'debe detectar una persona');
assert.equal(person.name, 'Ana');
assert.equal(person.note, 'esposa');

const placeEnts = api.extractEntities('Vivo en Tegucigalpa desde hace anios.');
const place = placeEnts.find((e) => e.type === 'lugar');
assert.ok(place, 'debe detectar un lugar');
assert.match(place.name, /Tegucigalpa/);

// La meta entra como entidad meta al pasar por el brain
const brainWithGoal = api.extractBrainFromUserMessage({}, 'Mi meta es comprar una casa este anio.');
const metaEnt = (brainWithGoal.entities || []).find((e) => e.type === 'meta');
assert.ok(metaEnt, 'el objetivo debe quedar como entidad meta');

// Las entidades aparecen en el bloque de memoria del chat
const brainWithPerson = api.extractBrainFromUserMessage({}, 'Mi esposa se llama Ana.');
const block = api.buildBrainContextBlock(brainWithPerson, 'que le gusta?');
assert.match(block, /Entidades recordadas/i);
assert.match(block, /persona:Ana/);

// --- Contradicciones: memoria local vs servidor ---
const conflicts = api.detectBrainConflicts(
  { user_profile: { full_name: 'Carlos Posas' }, user_goal: 'comprar una casa' },
  { user_profile: { full_name: 'Juan Perez' }, user_goal: 'comprar una casa' }
);
assert.ok(conflicts.length >= 1, 'debe detectar contradiccion de nombre');
assert.match(conflicts[0], /Nombre/);
assert.match(conflicts[0], /Carlos Posas/);
assert.match(conflicts[0], /Juan Perez/);

// Sin contradiccion cuando coinciden (ignorando acentos/mayusculas)
const noConflict = api.detectBrainConflicts(
  { user_profile: { full_name: 'José' } },
  { user_profile: { full_name: 'jose' } }
);
assert.equal(noConflict.length, 0, 'mismo valor normalizado no es contradiccion');

// mergeBrain conserva la version mas nueva pero registra la contradiccion
const merged = api.mergeBrain(
  { user_profile: { full_name: 'Carlos Posas' }, updated_at: 100 },
  { user_profile: { full_name: 'Juan Perez' }, updated_at: 200 }
);
assert.equal(merged.user_profile.full_name, 'Juan Perez', 'gana el mas reciente');
assert.ok(merged.conflicts.length >= 1, 'el merge guarda la contradiccion');
assert.match(merged.conflicts[0], /Nombre/);

// El bloque de memoria expone las contradicciones para que Mady pregunte
const conflictBlock = api.buildBrainContextBlock(merged, 'como me llamo?');
assert.match(conflictBlock, /CONTRADICCIONES SIN RESOLVER/i);

// Entidades se unen al hacer merge (sin duplicar por tipo+nombre)
const mergedEntities = api.mergeBrain(
  { entities: [{ type: 'persona', name: 'Ana', note: 'esposa', updated_at: 100 }], updated_at: 100 },
  { entities: [{ type: 'persona', name: 'Ana', note: 'esposa', updated_at: 200 }, { type: 'lugar', name: 'Lima', updated_at: 200 }], updated_at: 200 }
);
const personCount = mergedEntities.entities.filter((e) => e.type === 'persona' && e.name === 'Ana').length;
assert.equal(personCount, 1, 'no duplica la misma entidad');
assert.ok(mergedEntities.entities.some((e) => e.type === 'lugar' && e.name === 'Lima'), 'conserva la entidad nueva');

// --- Recall ligado a entidad: "esposa" (relacion) recupera mensajes sobre Ana ---
const convo = {
  id: 'chat_ent',
  title: 'Chat',
  updated: Date.now(),
  brain: { entities: [{ type: 'persona', name: 'Ana', note: 'esposa', updated_at: 1 }] },
  messages: [
    { id: 'u1', role: 'user', content: 'A Ana le encanta el chocolate amargo.', ts: 1 },
    { id: 'a1', role: 'assistant', content: 'Anotado.', ts: 2 },
    { id: 'u2', role: 'user', content: 'Tema distinto cualquiera.', ts: 3 },
    { id: 'a2', role: 'assistant', content: 'Ok.', ts: 4 },
    { id: 'u3', role: 'user', content: 'Reciente 1', ts: 5 },
    { id: 'a3', role: 'assistant', content: 'Reciente 2', ts: 6 },
    { id: 'u4', role: 'user', content: 'Reciente 3', ts: 7 },
    { id: 'a4', role: 'assistant', content: 'Reciente 4', ts: 8 },
    { id: 'u5', role: 'user', content: 'Reciente 5', ts: 9 }
  ]
};
const recall = api.buildDeviceMemoryRecallBlock(convo, 'Que le gusta a mi esposa?');
assert.match(recall, /chocolate amargo/i, 'la relacion esposa->Ana debe recuperar el mensaje');

console.log('entity-memory-layer: 18/18 OK');
