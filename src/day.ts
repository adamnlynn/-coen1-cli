/** "2026-09-06" from an ISO timestamp or date, in this machine's timezone — the person is sitting
 *  at the terminal, so that is their day. Shared by Home's rendering and the tool registry. */
export function dayOf(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Today, as YYYY-MM-DD. */
export const today = (): string => dayOf(new Date().toISOString());

/** The one shape a date argument may take. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "1432" — the local hour and minute of an ISO timestamp. Used in mirror filenames, where two
 *  entries on the same day need to sort and not collide. */
export function hhmmOf(iso: string | null | undefined): string {
  if (!iso) return "0000";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "0000";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d)
    .replace(":", "");
}
