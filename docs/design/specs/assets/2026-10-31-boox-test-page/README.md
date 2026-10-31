# Boox Note Air 2 test page, 2026-10-31 (spike A of #205, epic #204)

The first fixture of the kind §5.5 of the live-ink design describes: a real page as SieveInk
exports it, beside the bitmap the tablet itself drew.

| File | What |
|---|---|
| `boox-page-strokes.json` | 74 strokes, 17,044 points: pen handwriting and pencil writing plus a shaded square. Per point: x, y (page units, width = 1), pressure (0..1 of 4095), tMillis, tiltX, tiltY (degrees), size. |
| `boox-tablet-render.png` | 1404×1693, what the Onyx engines (fountain for pen, charcoal V2 for pencil) drew for that page. The look-and-feel reference for the Sieve lens. |
| `crude-render-from-points.png` | A 40-line throwaway render of the JSON (`crude-render.py`: width from pressure only, no tilt, no grain). Handwriting matches the tablet at a glance; pencil shading does not — tilt-driven width, grey tone and grain are what the lens has to add. |
| `crude-render.py` | The throwaway. Run with `python3 -I crude-render.py boox-page-strokes.json out.svg`, then `rsvg-convert`. |
