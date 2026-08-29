/** @type {import('tailwindcss').Config} */
// Snehal Printers palette — warm terracotta/rust + amber, printing-press feel.
// Keeps the same semantic class names (navy/royal/amber) as the base platform
// so components don't need per-usage rewrites — only the hex values changed.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy:   { DEFAULT: '#7C2D12', 50: '#FEF3EC', 100: '#FCDFC8', 200: '#F7B98C', 300: '#F0904F', 400: '#DB6420', 500: '#7C2D12', 600: '#63240E', 700: '#4A1B0B', 800: '#321207', 900: '#190904' },
        royal:  { DEFAULT: '#C2410C', 50: '#FFF3EB', 100: '#FEDDC7', 200: '#FDB98A', 300: '#FB934C', 400: '#EA6A16', 500: '#C2410C', 600: '#9A340A', 700: '#732707', 800: '#4D1A05', 900: '#260D02' },
        amber:  { DEFAULT: '#F97316', 50: '#FFF7ED', 600: '#EA580C' },
        slate:  { 50: '#F8FAFC', 100: '#F1F5F9', 200: '#E2E8F0', 300: '#CBD5E1', 400: '#94A3B8', 500: '#64748B', 600: '#475569', 700: '#334155', 800: '#1E293B', 900: '#0F172A' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        card:  '0 1px 3px 0 rgba(124,45,18,0.08), 0 1px 2px -1px rgba(124,45,18,0.06)',
        panel: '0 4px 24px 0 rgba(124,45,18,0.10)',
      },
    },
  },
  plugins: [],
}
