# Boox Note Air 2 width / tilt / pressure ladder, 2026-11-02 (#204 phase 1 fixture)

The calibration page: the same marks at every width class and tool, five pencil strokes from upright to flat, five from light to hard. Measured on the tablet's own PNG (dark-pixel run perpendicular to each stroke, median over ~25 samples), not judged by eye.

| File | What |
|---|---|
| `boox-page-strokes.json` | 46 strokes, 7,063 points: "PEN" + a line at classes 1/2/3; "PENCIL" + a line at classes 1/2/3; the tilt ladder (pencil class 2, tiltX 20–32°, tiltY 3–49°); the pressure ladder (pencil class 2, mean pressure 0.23 / 0.50 / 0.83 / 0.97 / 0.97 — three distinct levels, it is hard to hold five by hand). |
| `boox-tablet-render.png` | 1404×1693, what the Onyx engines drew. |
| `perfect-freehand-render.png` | `../2026-10-31-boox-test-page/perfect-freehand-render.mjs` in its default `ladder` mode, the rules below. Widths match class for class; the pressure ladder matches in width progression and speckle. |

## What the tablet does (measured, page width 1404 px, nominal class widths 1.7 / 3.4 / 6.3 px)

| | class 1 | class 2 | class 3 | rule |
|---|---|---|---|---|
| pen width at p≈0.95 | 5.5 px | 6.5 px | 9.0 px | **≈ 4.2 + 0.76 × nominal** — affine, not proportional |
| pencil width at p≈0.98 | 6.0 px | 8.0 px | 11.0 px | **≈ 4.2 + 1.09 × nominal** |

| pencil, class 2 | p = 0.23 | 0.50 | 0.83 | 0.97 |
|---|---|---|---|---|
| width | 2 px | 6 px | 8 px | 8 px |
| look | sparse speckle | grainy grey | nearly solid | solid |

**Tilt has no effect on width:** the tilt ladder renders 7–8 px throughout (and the architect, drawing it, "tilt had little effect"). The tilt-driven width tuned on the first fixture was fitting noise; it is removed.

## The renderer rules this fixes (`ladder` mode)

- **Pen:** perfect-freehand `size = (4.2 + 0.76·nominal) / 1.675`, thinning 0.75 (so the width at p≈0.95 is the measured one), one outline per stroke.
- **Pencil:** 10-point chunks; width `(4.2 + 1.09·nominal) × min(1, p/0.8)^0.8`, constant within a chunk (thinning 0), no tilt term; tone = dot density in seven bands (darkness 0.10 + 0.95·p^1.3 picks the band). The `.mjs` thresholds a feTurbulence mask per band (baseFrequency 0.7); `docs/ink-contract.md` §Rendering draws each band as a deterministic vector dot pattern instead, which keeps its look at every display size.
