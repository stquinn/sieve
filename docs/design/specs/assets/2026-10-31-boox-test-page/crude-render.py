import json, sys, math
d = json.load(open(sys.argv[1])); out = sys.argv[2]
W = 1404; aspect = d['note']['pageAspect']; H = round(W / aspect)
BASE = {1: 0.0012, 2: 0.0024, 3: 0.0045}
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect width="100%" height="100%" fill="white"/>']
for s in d['strokes']:
    pts = s['points']; base = BASE[s['widthClass']] * W
    pen = s['tool'] == 'pen'
    color = '#000' if pen else '#222'
    # outline polygon with width following pressure (pen 0.6+0.8p, pencil 0.7+0.6p), drawn as filled quads per segment
    for a, b in zip(pts, pts[1:]):
        ax, ay, bx, by = a['x']*W, a['y']*W, b['x']*W, b['y']*W
        wa = base * ((0.6 + 0.8*a['pressure']) if pen else (0.7 + 0.6*a['pressure']))
        wb = base * ((0.6 + 0.8*b['pressure']) if pen else (0.7 + 0.6*b['pressure']))
        dx, dy = bx-ax, by-ay; L = math.hypot(dx, dy)
        if L == 0: continue
        nx, ny = -dy/L, dx/L
        op = 1.0 if pen else 0.35 + 0.55*a['pressure']
        parts.append(f'<polygon fill="{color}" fill-opacity="{op:.2f}" points="{ax+nx*wa/2:.2f},{ay+ny*wa/2:.2f} {bx+nx*wb/2:.2f},{by+ny*wb/2:.2f} {bx-nx*wb/2:.2f},{by-ny*wb/2:.2f} {ax-nx*wa/2:.2f},{ay-ny*wa/2:.2f}"/>')
        parts.append(f'<circle fill="{color}" fill-opacity="{op:.2f}" cx="{bx:.2f}" cy="{by:.2f}" r="{wb/2:.2f}"/>')
parts.append('</svg>')
open(out, 'w').write('\n'.join(parts))
print(W, H, len(d['strokes']))
