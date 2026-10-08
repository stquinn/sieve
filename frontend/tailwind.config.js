/** @type {import('tailwindcss').Config} */
module.exports = {
  // vendor/ holds minified third-party bundles: any token in them that looks
  // like a utility class (prettier.js has `m-2`) would otherwise become a rule.
  content: ['./src/templates/**/*.html', './src/static/**/*.js', '!./src/static/vendor/**', './src/index.html'],
  corePlugins: {
    // Don't let Tailwind's base reset fight our hand-crafted editor CSS
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // All colours are driven by CSS Custom Properties injected at boot
        // from the active theme JSON file. See vault/theme.go + App.tsx.
        tn: {
          bg:        'var(--theme-bg)',
          'bg-dark': 'var(--theme-bgDark)',
          'bg-alt':  'var(--theme-bgAlt)',
          border:    'var(--theme-border)',
          'border-2':'var(--theme-border2)',
          muted:     'var(--theme-muted)',
          subtle:    'var(--theme-subtle)',
          text:      'var(--theme-text)',
          'text-dim':'var(--theme-textDim)',
          blue:      'var(--theme-accentPrimary)',
          cyan:      'var(--theme-accentCyan)',
          green:     'var(--theme-accentGreen)',
          yellow:    'var(--theme-accentYellow)',
          orange:    'var(--theme-accentOrange)',
          red:       'var(--theme-accentRed)',
          purple:    'var(--theme-accentPurple)',
          teal:      'var(--theme-accentTeal)',
        },
      },
      fontFamily: {
        editor: ['var(--theme-editorFont)'],
        ui:     ['var(--theme-uiFont)'],
        mono:   ['var(--theme-monoFont)'],
      },
    },
  },
  plugins: [],
}
