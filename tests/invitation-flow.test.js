const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const store = new Map();
const context = {
  window: {},
  localStorage: {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invite: { status: 'pending' } }) }),
  setTimeout,
  clearTimeout,
  console,
  Error,
  Date,
  JSON,
  Object,
  String,
  Set,
};
context.window.window = context.window;

const source = fs.readFileSync(path.join(__dirname, '..', 'invitations.js'), 'utf8');
vm.runInNewContext(source, context, { filename: 'invitations.js' });
const api = context.window.LTHInviteApi;

assert.equal(api.passwordError('C0rrecta!MuyLarga', 'persona@example.com'), '');
assert.match(api.passwordError('123456', 'persona@example.com'), /12 caracteres/);
assert.match(api.passwordError('Persona2026!', 'persona@example.com'), /no contener tu correo/);
assert.match(api.passwordError('AAAAaaaa1111', 'persona@example.com'), /un símbolo/);

api.saveTracker({ requestToken: 'opaque-token-123' }, 'User@Example.com');
assert.equal(api.loadTracker().email, 'user@example.com');
assert.equal(api.loadTracker().requestToken, 'opaque-token-123');
api.clearTracker();
assert.equal(api.loadTracker(), null);

assert.equal(api.viewModel({ status: 'pending' }).title, 'Solicitud pendiente');
assert.equal(api.viewModel({ status: 'code_sent' }).title, 'PIN enviado');
assert.equal(api.viewModel({ status: 'locked' }).title, 'Solicitud bloqueada');
assert.equal(api.viewModel({ status: 'expired' }).title, 'PIN vencido');

(async () => {
  const response = await api.call('https://example.test/invites', 'publishable', 'invite.status', { requestToken: 'opaque' });
  assert.equal(response.invite.status, 'pending');
  console.log('invitation-flow: 13/13 OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
