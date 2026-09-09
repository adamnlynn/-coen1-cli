import { createContext, useContext } from "react";

// Mirror of the dashboard ColorScheme union (coen1-web/src/types/preferences.ts).
export type ColorScheme =
  | "default" | "signal" | "coen1" | "ocean" | "forest" | "sunset"
  | "retrowave" | "vaporwave" | "terminal" | "neon" | "cyberpunk" | "amber" | "custom";

// Per-scheme accent hex — pulled from the dashboard's themeIcons active colors so
// the terminal identity matches the dashboard. `custom` is derived at runtime from
// the user's customTheme.brandPrimary HSL.
export const ACCENTS: Record<Exclude<ColorScheme, "custom">, string> = {
  default: "#8b5cf6",
  signal: "#e9a23b",
  coen1: "#7c3aed",
  ocean: "#3b82f6",
  forest: "#22c55e",
  sunset: "#f97316",
  retrowave: "#db2777",
  vaporwave: "#f9a8d4",
  terminal: "#4ade80",
  neon: "#06b6d4",
  cyberpunk: "#eab308",
  amber: "#f59e0b",
};

// Schemes offered in the /theme picker (custom is set from the dashboard color picker).
export const SELECTABLE_SCHEMES: { scheme: Exclude<ColorScheme, "custom">; label: string }[] = [
  { scheme: "signal", label: "Signal (amber)" },
  { scheme: "coen1", label: "Coen 1 (purple)" },
  { scheme: "default", label: "Default (violet)" },
  { scheme: "ocean", label: "Ocean (blue)" },
  { scheme: "forest", label: "Forest (green)" },
  { scheme: "sunset", label: "Sunset (orange)" },
  { scheme: "neon", label: "Neon (cyan)" },
  { scheme: "cyberpunk", label: "Cyberpunk (yellow)" },
  { scheme: "amber", label: "Amber (gold)" },
  { scheme: "retrowave", label: "Retrowave (pink)" },
  { scheme: "vaporwave", label: "Vaporwave (rose)" },
  { scheme: "terminal", label: "Terminal (matrix)" },
];

export interface Palette {
  accent: string; // brand identity — prompt ❯, ◆ coen, borders, titles, tool chips
  accentDim: string; // muted accent — note prefix
  dim: string; // hue-tinted gray — hints, status meta, thinking…
  text: string; // your typed text — kept near-white for readability
  success: string;
  warning: string;
  error: string;
}

// ─── colour math ─────────────────────────────────────────────────────────────
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + 360) % 360;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Parse a dashboard HSL string like "38 82% 56%" to hex. */
export function hslStringToHex(hsl: string): string {
  const parts = hsl.replace(/%/g, "").trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return ACCENTS.signal;
  return hslToHex(parts[0], parts[1], parts[2]);
}

/** Shortest-path hue interpolation: base → target by amount [0..1]. */
function mixHue(base: number, target: number, amount: number): number {
  let d = ((target - base + 540) % 360) - 180;
  return base + d * amount;
}

// Build a full palette from an accent. Status colours are tinted toward the accent
// hue (the chosen "accent + status tints") but pinned to lightness ≥58 so they stay
// legible on a dark terminal — we just fixed a contrast bug and won't regress it.
export function buildPalette(accentHex: string): Palette {
  const [h, s] = hexToHsl(accentHex);
  return {
    accent: accentHex,
    accentDim: hslToHex(h, clamp(s * 0.85, 0, 100), 50),
    dim: hslToHex(h, 20, 62),
    text: "#f4f4f5",
    success: hslToHex(mixHue(145, h, 0.18), 58, 58),
    warning: hslToHex(mixHue(42, h, 0.18), 82, 60),
    error: hslToHex(mixHue(0, h, 0.12), 75, 64),
  };
}

export function paletteFor(scheme: ColorScheme, customHsl?: string | null): Palette {
  const accent =
    scheme === "custom" && customHsl ? hslStringToHex(customHsl) : ACCENTS[scheme as Exclude<ColorScheme, "custom">] ?? ACCENTS.signal;
  return buildPalette(accent);
}

export const DEFAULT_SCHEME: ColorScheme = "signal";
export const DEFAULT_PALETTE: Palette = paletteFor(DEFAULT_SCHEME);

// ─── react context ───────────────────────────────────────────────────────────
export interface ThemeCtx {
  scheme: ColorScheme;
  palette: Palette;
  /** Apply a scheme locally; when sync, also write it back to the dashboard. */
  applyScheme: (scheme: ColorScheme, sync?: boolean) => Promise<boolean>;
}

export const ThemeContext = createContext<ThemeCtx>({
  scheme: DEFAULT_SCHEME,
  palette: DEFAULT_PALETTE,
  applyScheme: async () => true,
});

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
