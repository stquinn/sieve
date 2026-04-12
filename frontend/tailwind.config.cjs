/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  corePlugins: {
    // Don't let Tailwind's base reset fight our hand-crafted editor CSS
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // Tokyo Night palette as design tokens
        tn: {
          bg:        '#1a1b26',
          'bg-dark': '#16161e',
          'bg-alt':  '#1e2030',
          border:    '#2a2b3d',
          'border-2':'#3b4261',
          muted:     '#565f89',
          subtle:    '#3b3d57',
          text:      '#c0caf5',
          'text-dim':'#a9b1d6',
          blue:      '#7aa2f7',
          cyan:      '#7dcfff',
          green:     '#9ece6a',
          yellow:    '#e0af68',
          orange:    '#ff9e64',
          red:       '#f7768e',
          purple:    '#bb9af7',
          teal:      '#2ac3de',
        },
      },
    },
  },
  plugins: [],
}
