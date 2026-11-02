// Harvest the live session from the Go hub's replay and write it as a fixture page (the SieveInk export format).
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [,, outFile = 'live-page.json', waitMs = '2500', skipSeq = '0'] = process.argv;
const ws = new WebSocket('ws://127.0.0.1:8765/ws');
const recs = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (Array.isArray(m)) recs.push(...m); };
ws.onerror = e => { console.error('ws error', e.message ?? e); process.exit(1); };
setTimeout(() => {
  ws.close();
  let aspect = 0.8293, t0 = null;
  const strokes = new Map(), order = [];
  for (const r of recs) {
    if (r.t === 'clock') { if (r.aspect) aspect = r.aspect; continue; }
    if (r.t === 'begin') { if (r.s <= Number(skipSeq)) continue; if (t0 === null) t0 = r.tm; strokes.set(r.s, { id: randomUUID(), tool: r.tool, widthClass: r.w, startMillis: r.tm - t0, t0: r.tm, points: [] }); order.push(r.s); continue; }
    const s = strokes.get(r.s);
    if (!s) continue;
    if (r.t === 'point') s.points.push({ x: r.x, y: r.y, pressure: r.p, tMillis: r.tm - s.t0, tiltX: r.tx ?? 0, tiltY: r.ty ?? 0, size: 0 });
    else if (r.t === 'remove') strokes.delete(r.s);
  }
  const out = { note: { id: randomUUID(), created: new Date().toISOString(), title: '', pageAspect: aspect, template: null },
    strokes: order.filter(k => strokes.has(k)).map(k => { const { t0, ...s } = strokes.get(k); return s; }) };
  writeFileSync(outFile, JSON.stringify(out));
  const tools = {}; for (const s of out.strokes) tools[s.tool] = (tools[s.tool] || 0) + 1;
  console.log(recs.length, 'records →', out.strokes.length, 'strokes', JSON.stringify(tools), out.strokes.reduce((n, s) => n + s.points.length, 0), 'points, aspect', aspect);
  process.exit(0);
}, Number(waitMs));
