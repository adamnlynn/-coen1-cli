import { POSITIVE_EMOTIONS, NEGATIVE_EMOTIONS, CANONICAL_MARKERS } from "./marker-valence.generated.js";

/**
 * How a marker score is read. One definition, because three things now depend on it: Home's
 * rendering, the tool registry's JSON, and the life snapshot. These are the web's numbers
 * (coen1-web/src/lib/emotional-read.ts) and the lists are generated from the same taxonomy —
 * nothing here decides anything about the person, it only says which markers earned a mention.
 */

// Marker scores are banded: ~20 low, ~50 "mentioned, unremarkable", 72+ emphasized. Only scores
// STRICTLY above the band earn a mention (coen1-web NEUTRAL_BAND).
export const NEUTRAL_BAND = 50;

export function intensityWord(score: number): "Clear" | "Present" | "Subtle" {
  if (score >= 72) return "Clear";
  if (score >= 50) return "Present";
  return "Subtle";
}

const LIFTING = new Set(POSITIVE_EMOTIONS);
const WEIGHING = new Set(NEGATIVE_EMOTIONS);

export type Nature = "lifting" | "weighing" | "neither";
export function natureOf(marker: string): Nature {
  if (LIFTING.has(marker)) return "lifting";
  if (WEIGHING.has(marker)) return "weighing";
  return "neither";
}

/** "authentic_safety" → "Authentic safety". Labels are words, not keys. */
export function markerLabel(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One scored marker as the tools hand it back. */
export interface ScoredMarker {
  marker: string;
  intensity: "clear" | "present" | "subtle";
  score: number;
}

/**
 * Split one day's markers into the three groups the dashboard shows, keeping only what is
 * strictly above the neutral band, strongest first. Port of coen1-api lib/life-reads.js
 * readMatrix — the `_`-prefixed composites are skipped and a marker that has since been retired
 * from the taxonomy cannot come back through an old row.
 */
export function readMatrix(avgs: Record<string, unknown> | null | undefined): {
  lifting: ScoredMarker[];
  weighing: ScoredMarker[];
  worth_noticing: ScoredMarker[];
} {
  const out = { lifting: [] as ScoredMarker[], weighing: [] as ScoredMarker[], worth_noticing: [] as ScoredMarker[] };
  if (!avgs || typeof avgs !== "object") return out;
  const entries: ScoredMarker[] = [];
  for (const [key, value] of Object.entries(avgs)) {
    if (key.startsWith("_")) continue;
    if (!CANONICAL_MARKERS.has(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value <= NEUTRAL_BAND) continue;
    entries.push({ marker: key, intensity: intensityWord(value).toLowerCase() as ScoredMarker["intensity"], score: Math.round(value) });
  }
  entries.sort((a, b) => b.score - a.score);
  for (const e of entries) {
    const n = natureOf(e.marker);
    out[n === "neither" ? "worth_noticing" : n].push(e);
  }
  return out;
}

/** The two composites and burnout risk, as the dashboard's personalStatus.ts reads them. */
export function composites(avgs: Record<string, unknown> | null | undefined): {
  positive_signal: number | null;
  negative_signal: number | null;
  burnout_risk: number | null;
} {
  const c = ((avgs as Record<string, Record<string, unknown>> | null)?._composites ?? {}) as Record<string, unknown>;
  const h = ((avgs as Record<string, Record<string, unknown>> | null)?._human_metrics ?? {}) as Record<string, unknown>;
  const r1 = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
  return {
    positive_signal: r1(c.positive_signal),
    negative_signal: r1(c.negative_signal),
    burnout_risk: r1(h.burnout_risk),
  };
}

/**
 * A read in a few words: the markers above the band, strongest first, as labels.
 *
 * Home puts this in a note, `coen pulse --wait` prints it, and the daemon hands it to the onRead
 * hook as COEN_SUMMARY. One definition so the three say the same thing.
 */
export function topMarkers(signals: Record<string, number> | null | undefined, max = 3): string[] {
  if (!signals) return [];
  return Object.entries(signals)
    .filter(([k, v]) => !k.startsWith("_") && typeof v === "number" && v > NEUTRAL_BAND)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => markerLabel(k));
}
