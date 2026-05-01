
/**
 * Detects if the current platform is macOS.
 */
export const isMac = () => {
  return navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
};

/**
 * Checks if the primary modifier key (Cmd on Mac, Ctrl on others) is pressed.
 */
export const isMod = (e: KeyboardEvent | React.KeyboardEvent | MouseEvent | React.MouseEvent) => {
  return isMac() ? e.metaKey : e.ctrlKey;
};

/**
 * Returns the human-readable name for the primary modifier key.
 */
export const getModKey = () => {
  return isMac() ? 'Cmd' : 'Ctrl';
};
