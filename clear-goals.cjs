const Database = require('better-sqlite3');
const db = new Database('C:/Users/user/.automaton/state.db');
db.pragma('foreign_keys = OFF');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Clear orchestrator state
for (const table of ['tasks', 'goals', 'workers', 'task_dependencies']) {
  if (tables.find(t => t.name === table)) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`Cleared ${table}`);
  }
}

// Clear KV entries related to orchestrator
db.prepare("DELETE FROM kv WHERE key LIKE '%orchestrator%' OR key LIKE '%goal%' OR key LIKE '%task%'").run();
console.log('Cleared orchestrator KV entries');

db.pragma('foreign_keys = ON');
db.close();
console.log('Done');
