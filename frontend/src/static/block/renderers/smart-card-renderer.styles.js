// @ts-check
// smart-card-renderer.styles.js — SmartCardRenderer's stylesheet, a sibling
// module per the styles-file-geography convention (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a renderer file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<kind>-renderer.styles.js` sibling module, imported into the class's
// `static styles`. This module is renderer-internal — nothing outside
// smart-card-renderer.js imports it.
//
// Carried verbatim from input.css's former `.smart-card-card`/`.smart-card-card__*`
// rule set (moved here in the same change per the spec — style carriage is
// never a separate pass). NOTE: like ai-block's CSS living in editor.css
// rather than input.css, this kind's rules lived in input.css (the tailwind-
// built stylesheet), NOT editor.css — verified before moving anything. Since
// input.css changed, `frontend/`'s tailwind build must be re-run (see the P4
// sweep notes) — this stylesheet needs no such build itself.
//
// Already used only theme vars (--theme-fg2/fg3/bgLight/accent/border/border2)
// — no hardcoded colour literals needed converting, unlike several other
// kinds' carried-over rgba() box-shadows.

export const smartCardStyles = /* css */ `
  .smart-card-card {
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    padding: 12px;
    margin: 4px 0;
    cursor: pointer;
    transition: border-color 0.15s ease;
    background: var(--theme-bgDark);
    width: 100%;
    box-sizing: border-box;
  }

  .smart-card-card:hover {
    border-color: var(--theme-border2);
  }

  .smart-card-card--pending {
    opacity: 0.7;
  }

  /* Row 1: link icon + site name */
  .smart-card-card__meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }

  .smart-card-card__icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--theme-fg3);
    flex-shrink: 0;
    font-size: 10px;
  }

  .smart-card-card__site {
    font-size: 11px;
    color: var(--theme-fg3);
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  /* Row 2: thumbnail + text content */
  .smart-card-card__body {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .smart-card-card__thumb {
    width: 72px;
    height: 72px;
    min-width: 72px;
    border-radius: 5px;
    background: var(--theme-bgLight);
    object-fit: cover;
    flex-shrink: 0;
  }

  .smart-card-card__thumb--placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--theme-fg3);
    font-size: 11px;
  }

  .smart-card-card__thumb--spinner {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .smart-card-card__content {
    flex: 1;
    min-width: 0;
  }

  .smart-card-card__title {
    font-weight: 600;
    color: var(--theme-accent);
    margin-bottom: 3px;
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .smart-card-card__description {
    font-size: 11px;
    color: var(--theme-fg2);
    line-height: 1.4;
    margin-bottom: 5px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .smart-card-card__url {
    font-size: 10px;
    color: var(--theme-fg3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Spinner reused from web-clip-block__spinner's animation shape */
  .smart-card-card__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--theme-border2);
    border-top-color: var(--theme-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
`
