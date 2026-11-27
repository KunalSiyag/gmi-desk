// Renders the app icon (GMI's Dino on a black GMI tile) from the same art as the in-app Dino.
// Usage: node --experimental-strip-types scripts/make-icon.mjs   (needs ffmpeg built with librsvg for the PNG)
// Output: build/icon.svg and build/icon.png (512x512; electron-builder's default icon location).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dinoSvg } from '../src/renderer/components/brand/dino-art.ts';

const dino = dinoSvg('icon')
  .replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"', '<svg x="86" y="78" width="340" height="340" viewBox="0 0 128 128"')
  // The floor shadow becomes a faint lime light on the black tile, like the dark theme.
  .replace('fill="#000" opacity=".18"', 'fill="#ddea4d" opacity=".12"');

const grid = [];
for (let v = 56; v < 512; v += 40) {
  grid.push(`<path d="M${v} 16V496M16 ${v}H496"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<clipPath id="tile"><rect x="16" y="16" width="480" height="480" rx="108"/></clipPath>
<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ddea4d" stop-opacity=".22"/><stop offset="1" stop-color="#ddea4d" stop-opacity="0"/></radialGradient>
<radialGradient id="fade" cx="50%" cy="50%" r="50%"><stop offset=".25" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect x="16" y="16" width="480" height="480" rx="108" fill="#050505"/>
<g clip-path="url(#tile)">
<g stroke="url(#fade)" stroke-width="2">${grid.join('')}</g>
<circle cx="256" cy="250" r="210" fill="url(#glow)"/>
</g>
<rect x="17" y="17" width="478" height="478" rx="107" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="2"/>
${dino}
</svg>
`;

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.svg', svg);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00000000:s=512x512,format=rgba', '-i', 'build/icon.svg', '-filter_complex', '[0][1]overlay=format=auto', '-frames:v', '1', 'build/icon.png']);
console.log('[make-icon] wrote build/icon.svg and build/icon.png');
