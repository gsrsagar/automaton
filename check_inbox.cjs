const fs = require('fs');
const code = fs.readFileSync('C:\\Users\\user\\Documents\\AI Agents\\automaton\\dist\\agent\\loop.js', 'utf8');

// Find all occurrences of inbox_messages status checks
const regex = /inbox_messages WHERE status[^"]*/g;
let match;
while ((match = regex.exec(code)) !== null) {
  console.log(`Position ${match.index}: ${match[0]}`);
}
