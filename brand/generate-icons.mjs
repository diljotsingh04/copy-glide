// Generates every icon the apps need from the master SVGs in /brand.
//   npm run icons
// Outputs are committed, so normal builds don't need to run this.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'brand');
const icon = fs.readFileSync(path.join(BRAND, 'logo-icon.svg'), 'utf8');
const tray = fs.readFileSync(path.join(BRAND, 'tray.svg'), 'utf8');

function png(svg, size, out) {
  const data = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log(`  ${path.relative(ROOT, out)} (${size}px)`);
}

const traySvg = (fill, trail) => {
  const defs = fill.startsWith('url')
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7DF0FF"/><stop offset=".5" stop-color="#8B7CFF"/><stop offset="1" stop-color="#E58BFF"/></linearGradient></defs>`
    : '';
  return tray.replace('<g ', `${defs}<g `).replace('fill="FILL"', `fill="${fill}"`).replace('stroke="TRAIL"', `stroke="${trail}"`);
};

console.log('Desktop');
const desktop = path.join(ROOT, 'apps', 'desktop');
png(icon, 1024, path.join(desktop, 'build', 'icon.png')); // electron-builder makes .ico/.icns from this
png(icon, 256, path.join(desktop, 'assets', 'icon.png')); // window icon
for (const [name, fill, trail] of [
  ['tray-on', 'url(#g)', '#7DF0FF'],
  ['tray-off', '#9A9DB0', '#9A9DB0'],
  ['trayTemplate', '#000000', '#000000'], // macOS menu bar (auto light/dark)
]) {
  png(traySvg(fill, trail), 16, path.join(desktop, 'assets', `${name}.png`));
  png(traySvg(fill, trail), 32, path.join(desktop, 'assets', `${name}@2x.png`));
}

console.log('Web');
const pub = path.join(ROOT, 'apps', 'web', 'public');
fs.mkdirSync(pub, { recursive: true });
fs.copyFileSync(path.join(BRAND, 'logo-icon.svg'), path.join(pub, 'favicon.svg'));
fs.mkdirSync(path.join(ROOT, 'apps', 'web', 'src', 'assets'), { recursive: true });
fs.copyFileSync(path.join(BRAND, 'logo-icon.svg'), path.join(ROOT, 'apps', 'web', 'src', 'assets', 'logo.svg'));
png(icon, 32, path.join(pub, 'favicon-32.png'));
png(icon, 180, path.join(pub, 'apple-touch-icon.png'));
png(icon, 192, path.join(pub, 'icon-192.png'));
png(icon, 512, path.join(pub, 'icon-512.png'));

console.log('Brand previews');
png(icon, 512, path.join(BRAND, 'logo-icon-512.png'));
