const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const perTurn = Number(source.match(/const SPECIALIST_TURN_TOKENS = (\d+);/)?.[1] || 0);
const maxParts = Number(source.match(/const SPECIALIST_MAX_PARTS = (\d+);/)?.[1] || 0);

assert.ok(perTurn >= 4000 && perTurn < 6000, 'cada tramo debe ser potente y terminar antes del limite de la Edge Function');
assert.ok(maxParts >= 12, 'MAX debe poder construir respuestas extensas mediante muchas continuaciones');
assert.match(source, /reasoningBudgetTokens:\s*needWeb \? 2000 : 1400/, 'el juez debe tener un presupuesto explicito de razonamiento');
assert.match(source, /if \(opts\.reasoningBudgetTokens\) payload\.reasoningBudgetTokens = opts\.reasoningBudgetTokens;/, 'el presupuesto debe llegar al backend');
assert.match(source, /function specialistContinuationMessages\(/, 'las respuestas truncadas deben continuar con contexto');
assert.match(source, /evt\.partialText/, 'un timeout debe conservar el texto parcial recibido');
assert.match(source, /streamError\.partialText = full/, 'el recuperador debe recibir el texto parcial');
assert.match(source, /isRecoverableSpecialistStreamError\(error\)/, 'los cortes temporales deben activar reintentos automaticos');

console.log('Mady MAX stream resilience: OK');
