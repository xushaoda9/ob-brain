const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const target = path.join(project, 'dist', 'ob-brain');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
if (manifest.id !== 'ob-brain') throw new Error('Unexpected plugin ID');
fs.mkdirSync(target, { recursive: true });
for (const name of ['manifest.json', 'main.js', 'styles.css', 'LICENSE']) {
  fs.copyFileSync(path.join(project, name), path.join(target, name));
}
console.log('Plugin built at ' + target);
