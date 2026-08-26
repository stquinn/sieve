// @ts-check
// command-badges.styles.js — CommandBadges' stylesheet, carried via
// RendererStyleRegistry. Colours are --theme-* vars only.
//
// The slot rules live here too: the status bar donates the mount point, but
// CommandBadges owns the region — it populates it, and the :empty hide is badge
// behaviour.

export const commandBadgesStyles = `
  /* The status-bar slot CommandBadges mounts into (#55). */
  .status-bar__command-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    border-left: 1px solid var(--theme-border2);
    padding-left: 0.75rem;
    height: 16px;
    box-sizing: border-box;
  }
  .status-bar__command-badges:empty {
    display: none;
  }

  /* Command badge (#55): one pill per correlated command job. */
  .command-badge {
    background: var(--theme-bgAlt);
    color: var(--theme-accentCyan);
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  /* State accents — class-driven, no inline colour. Pending keeps the base
     cyan; running progress is the status-bar jobs spinner (commands paint
     there uniformly like every JobEngine job), NOT a second spinner here. */
  .command-badge--holding { color: var(--theme-accentGreen); }
  .command-badge--error { color: var(--theme-accentRed); }
`
