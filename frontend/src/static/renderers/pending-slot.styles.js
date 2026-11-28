// @ts-check
// PendingSlot's stylesheet. The `--record-*` tokens it reads are owned by
// editor.css's `:root`, shared with the answer message whose blocks the slot
// stands in for.

export const pendingSlotStyles = /* css */ `
  .pending-slot {
    display: flex;
    align-items: center;
    gap: 10px;
    width: fit-content;
    padding: 9px 12px;
    border: 1px dashed var(--record-border-color);
    border-radius: var(--record-radius);
    background: var(--record-background);
    color: var(--record-accent);
    font-family: var(--theme-uiFont);
    font-size: calc(var(--doc-size) * 0.72);
    user-select: none;
    -webkit-user-select: none;
  }

  .pending-slot__dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--record-accent);
    opacity: 0.8;
    animation: pending-slot-pulse 1.2s ease-in-out infinite;
  }

  .pending-slot__elapsed {
    font-variant-numeric: tabular-nums;
  }

  @keyframes pending-slot-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pending-slot__dot {
      animation: none;
      opacity: 0.8;
    }
  }
`
