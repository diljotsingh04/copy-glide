// Copies the built web app (apps/web/dist) into apps/desktop/renderer for packaging.
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../../web/dist');
const dest = path.resolve(__dirname, '../renderer');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('apps/web/dist not found. Run `npm run build -w @clipsync/web` first.');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log('Copied renderer to', dest);
