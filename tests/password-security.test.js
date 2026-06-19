const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workspace = path.resolve(root, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const edge = fs.readFileSync(path.join(workspace, 'supabase', 'functions', '_shared', 'lth-ia-password-security.ts'), 'utf8');
const migration = fs.readFileSync(path.join(workspace, 'supabase', 'migrations', '20260619170000_lth_ia_password_reset_and_login_throttle.sql'), 'utf8');

assert.match(html, /id="forgotPasswordBtn"/);
assert.match(html, /id="resetForm"/);
assert.match(app, /'auth\.login'/);
assert.match(app, /'password\.request'/);
assert.match(app, /'password\.complete'/);
assert.match(edge, /900 - \(Date\.now\(\) - startedAt\)/);
assert.match(edge, /attempts >= 5/);
assert.match(edge, /interval '15 minutes'|retryAfter: 900/);
assert.match(edge, /reset-pin:/);
assert.doesNotMatch(edge, /console\.log\([^)]*password/i);
assert.match(migration, /enable row level security/g);
assert.match(migration, /revoke all .* anon, authenticated/);
assert.match(migration, /lth_ia_web_record_login_failure/);

console.log('password-security: 13/13 OK');
