const db = require('better-sqlite3')('C:/Users/user/.automaton/state.db');

// Check model registry
const reg = db.prepare('SELECT * FROM model_registry WHERE model_id=?').get('qwen2.5:0.5b');
console.log('Model registry:', JSON.stringify(reg, null, 2));

// Check latest turn
const turn = db.prepare('SELECT id,state,thinking FROM turns ORDER BY rowid DESC LIMIT 1').get();
console.log('\nLatest Turn:', turn.id, turn.state);
console.log('Thinking:', (turn.thinking||'').slice(0,200));
