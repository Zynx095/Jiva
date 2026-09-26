/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: '#0A0A0A',
        surface: '#1A1A1A',
        primary: '#3B82F6',
        accent: '#10B981',
      }
    },
  },
  plugins: [],
}
