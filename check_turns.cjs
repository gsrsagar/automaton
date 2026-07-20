const Database = require('better-sqlite3');
const db = new Database('C:/Users/user/.automaton/state.db');
const turns = db.prepare("SELECT id, state, input_source, thinking, created_at FROM turns WHERE state != 'running' ORDER BY created_at DESC LIMIT 5").all();
turns.forEach(t => console.log(t.id, '|', t.state, '|', t.input_source, '|', t.created_at, '|', (t.thinking || '').substring(0, 200)));
console.log('---running---');
const running = db.prepare("SELECT id, state, input_source, created_at FROM turns WHERE state = 'running' ORDER BY created_at DESC").all();
running.forEach(t => console.log('RUNNING:', t.id, '|', t.input_source, '|', t.created_at));
