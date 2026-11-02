import { getStroke } from 'perfect-freehand';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, inFile, outFile, freqArg = '0.7', gainArg = '1.0', widthMode = 'ladder'] = process.argv;
const FREQ = Number(freqArg), GAIN = Number(gainArg);
const d = JSON.parse(readFileSync(inFile, 'utf8'));
const W = 1404, H = Math.round(W / d.note.pageAspect);
const BASE = { 1: 0.0012, 2: 0.0024, 3: 0.0045 };
const CHUNK = 10;
// tone bands: fraction of speckle kept (dot density). darkness → band index
const BANDS = [0.12, 0.22, 0.34, 0.48, 0.64, 0.82, 0.96];
function pathFrom(o) {
  if (!o.length) return '';
  let s = `M${o[0][0].toFixed(1)},${o[0][1].toFixed(1)}`;
  for (let i = 1; i < o.length; i++) {
    const [x1, y1] = o[i - 1], [x2, y2] = o[i];
    s += `Q${x1.toFixed(1)},${y1.toFixed(1)} ${((x1 + x2) / 2).toFixed(1)},${((y1 + y2) / 2).toFixed(1)}`;
  }
  return s + 'Z';
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
// one shared noise, one threshold per band: alpha = step(noise > t), t from the band's keep fraction
const COV = [[1.0,-0.05],[0.98,0],[0.95,0.04],[0.88,0.08],[0.79,0.12],[0.68,0.16],[0.57,0.20],[0.45,0.25],[0.34,0.30],[0.23,0.36],[0.14,0.42],[0.05,0.55]]; // measured: keep fraction → threshold, chain below, turbulence 1.1 (rsvg)
const filters = BANDS.map((f, i) => {
  const keep = Math.min(1, f * GAIN); let k = 1; while (k < COV.length - 1 && COV[k][0] > keep) k++;
  const [c0, t0] = COV[k - 1], [c1, t1] = COV[k]; const t = t0 + (t1 - t0) * ((c0 - keep) / (c0 - c1 || 1));
  const slope = 40, icpt = -slope * t;
  return `<filter id="b${i}" x="0" y="0" width="1" height="1"><feTurbulence type="turbulence" baseFrequency="${FREQ}" numOctaves="2" seed="11" result="n"/><feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="o"/><feComponentTransfer in="o" result="s"><feFuncR type="linear" slope="${slope}" intercept="${icpt.toFixed(2)}"/></feComponentTransfer><feColorMatrix in="s" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter>`;
});
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<defs>${filters.join('')}</defs>`, `<rect width="100%" height="100%" fill="white"/>`];
const groups = BANDS.map(() => []);
for (const s of d.strokes) {
  const base = BASE[s.widthClass] * W;
  if (s.tool === 'pen') {
    const pts = s.points.map(p => [p.x * W, p.y * W, p.pressure]);
    const penSize = widthMode === 'ladder' ? (4.2 + 0.76 * base) / 1.675 : base * 1.35;
    out.push(`<path d="${pathFrom(getStroke(pts, { size: penSize, thinning: 0.75, smoothing: 0.5, streamline: 0.3, simulatePressure: false, last: true }))}" fill="#000"/>`);
    continue;
  }
  const P = s.points;
  for (let i = 0; i < P.length; i += CHUNK) {
    const seg = P.slice(Math.max(0, i - 1), i + CHUNK + 1);
    if (seg.length < 2) continue;
    const p = mean(seg.map(q => q.pressure)), tilt = mean(seg.map(q => q.tiltX));
    const t = Math.max(0, (tilt - 15) / 10);
    const size = widthMode === 'ladder' ? (4.2 + 1.09 * base) * Math.pow(Math.min(1, p / 0.8), 0.8) : widthMode === 'narrow' ? base * 1.4 * (0.8 + 0.4 * p) : base * 1.2 * (1 + 0.9 * t * t) * (1.1 - 0.4 * p);
    const dark = Math.min(1, 0.10 + 0.95 * Math.pow(p, 1.3));               // c's tone curve
    let band = 0; while (band < BANDS.length - 1 && dark > BANDS[band]) band++;
    const o = getStroke(seg.map(q => [q.x * W, q.y * W, q.pressure]), { size, thinning: widthMode === 'ladder' ? 0 : 0.3, smoothing: 0.5, streamline: 0.2, simulatePressure: false, last: true, start: { taper: 0, cap: true }, end: { taper: 0, cap: true } });
    groups[band].push(`<path d="${pathFrom(o)}"/>`);
  }
}
groups.forEach((g, i) => { if (g.length) out.push(`<g fill="#000" filter="url(#b${i})">`, ...g, `</g>`); });
out.push('</svg>');
writeFileSync(outFile, out.join('\n'));
console.log(groups.map(g => g.length).join('/'), 'chunks per band', (out.join('\n').length / 1024).toFixed(0), 'KB');
