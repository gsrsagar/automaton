const db = require('better-sqlite3')('C:\\Users\\user\\.automaton\\state.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));
for (const t of tables) {
  const cols = db.prepare("PRAGMA table_info(" + t.name + ")").all();
  console.log(t.name + ':', cols.map(c => c.name).join(', '));
}

console.log('\n--- Last 3 inbox_messages ---');
const inboxCols = db.prepare("PRAGMA table_info(inbox_messages)").all();
console.log('inbox_messages columns:', inboxCols.map(c => c.name).join(', '));

const msgs = db.prepare("SELECT * FROM inbox_messages ORDER BY rowid DESC LIMIT 3").all();
for (const m of msgs) {
  console.log(JSON.stringify(m));
}

console.log('\n--- Last 3 turns ---');
const turnsCols = db.prepare("PRAGMA table_info(turns)").all();
console.log('turns columns:', turnsCols.map(c => c.name).join(', '));
const turns = db.prepare("SELECT * FROM turns ORDER BY rowid DESC LIMIT 3").all();
for (const t of turns) {
  console.log(JSON.stringify(t));
}
