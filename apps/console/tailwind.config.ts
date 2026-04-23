// Tailwind config for apps/console. RTL-aware via logical properties
// + the `[dir="rtl"]:` variant attribute selector. Content paths cover
// the App Router tree.

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // System stack — Arabic-safe. shadcn/ui typography lands later.
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Noto Sans Arabic",
          "Roboto",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#e0eaff",
          200: "#c6d6ff",
          500: "#3559e8",
          600: "#2946c9",
          700: "#2139a5",
          900: "#162266",
        },
      },
    },
  },
  plugins: [],
};

export default config;
