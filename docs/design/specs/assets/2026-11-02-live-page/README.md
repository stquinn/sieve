# Boox Note Air 2 live page, 2026-11-02 (spike C of #205, epic #204)

The second fixture of the kind §5.5 of the live-ink design describes, and the first page drawn **while streaming live** over BLE L2CAP to a browser. Exported with SieveInk's Export button right after.

| File | What |
|---|---|
| `boox-page-strokes.json` | 89 strokes, 22,850 points: pen handwriting and sketch, pencil shading at a wider tilt range than the first fixture (tiltX 0–63°, mean 37°; the first was 12–34°). All width class 2. |
| `boox-tablet-render.png` | 1404×1693, what the Onyx engines drew. The look-and-feel reference. |
| `perfect-freehand-render-narrow.png` | The first fixture's renderer (`../2026-10-31-boox-test-page/perfect-freehand-render.mjs`) with pencil width **narrow** (1.4× nominal × (0.8+0.4p), no tilt term): `node perfect-freehand-render.mjs boox-page-strokes.json out.svg 0.7 1.0 narrow`. Hatching renders as individual textured lines like the tablet's. The tilt-driven width tuned on the first fixture (`1+0.9·t²`) turns this page's hatching into a blob: it extrapolated outside the tilt range it was tuned on. Width-versus-tilt needs a tilt-ladder fixture before any tilt term returns. |
| `harvest-live-session.mjs` | How the same page was ALSO reconstructed from the live stream: it reads the Go live server's replay over its WebSocket and writes this JSON format. Against the export, the live-harvested page matched 76/76 strokes in tool and point count with a maximum coordinate difference of 1.5e-5 of the page width (the 16-bit wire quantisation): **the live stream is the export.** |
