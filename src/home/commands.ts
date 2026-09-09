import type { Command } from "../SlashMenu.js";

// Home's slash commands — the menu's single source of truth. Anything typed that does not start
// with "/" is a check-in.
//
// This is only the MENU. The switch in Home.tsx is what runs, and the two have to agree: a command
// here that the switch doesn't handle autocompletes and then says "unknown command", and one the
// switch handles that isn't here works but can't be discovered. Aliases kept for muscle memory
// (/newhabit, /habit new, /realizations) are deliberately absent — they run, they just don't need
// a second line in the menu.
export const HOME_COMMANDS: Command[] = [
  { name: "/habit", hint: "tick a habit by its number (/habit 2), or pick; add undo to untick", arg: true },
  { name: "/habits", hint: "every habit, with schedule, target and streak" },
  { name: "/habit add", hint: "add a habit — yes/no, a number, a question or a clock" },
  { name: "/habit edit", hint: "change one thing about a habit — target, schedule, the words that tick it", arg: true },
  { name: "/habit remove", hint: "archive a habit — its history stays, and adding it again brings it back", arg: true },
  { name: "/timer", hint: "the clock: done · pause · resume · discard · log <minutes>; add a number when several run", arg: true },
  { name: "/decision", hint: "record a decision" },
  { name: "/insight", hint: "log a realization" },
  { name: "/reminder", hint: "save a line to be reminded of" },
  { name: "/journal", hint: "recent entries (or /journal YYYY-MM-DD)", arg: true },
  { name: "/reports", hint: "daily reports (or /reports YYYY-MM-DD, or a number from the list)", arg: true },
  { name: "/signals", hint: "signals week by week (← → to page); /signals YYYY-MM-DD for a day, latest for the last read", arg: true },
  { name: "/read", hint: "the last 7 days' emotional read" },
  { name: "/decisions", hint: "recent decisions" },
  { name: "/reminders", hint: "your reminders" },
  { name: "/insights", hint: "recent realizations" },
  { name: "/world", hint: "the people and things Coen knows about; /world add to name one yourself", arg: true },
  { name: "/home", hint: "the Home tab" },
  { name: "/close", hint: "close this tab (Esc does too)" },
  { name: "/clear", hint: "close every tab and clear the screen" },
  { name: "/refresh", hint: "reload the screen" },
  { name: "/fresh", hint: "close every tab and don't restore them next time" },
  { name: "/chat", hint: "open the chat" },
  { name: "/theme", hint: "change theme — syncs to dashboard", arg: true },
  { name: "/config", hint: "show config + connection" },
  { name: "/help", hint: "list commands" },
  { name: "/exit", hint: "quit" },
];

// A short list for the /decision picker. The dashboard has ~40 types (coen1-web/src/types/
// decisions.ts); these are the ones a person records for themselves. Anything else can be typed.
export const DECISION_TYPE_ITEMS: { label: string; value: string }[] = [
  { label: "Other", value: "other" },
  { label: "Personal growth", value: "personal_growth" },
  { label: "Work / life balance", value: "work_life_balance" },
  { label: "Values alignment", value: "values_alignment" },
  { label: "Founder commitment", value: "founder_commitment" },
  { label: "Spending", value: "spending" },
  { label: "Process", value: "process" },
  { label: "Tooling", value: "tooling" },
  { label: "Hiring", value: "hiring" },
  { label: "Product roadmap", value: "product_roadmap" },
  { label: "Partnership", value: "partnership" },
  { label: "Risk mitigation", value: "risk_mitigation" },
  { label: "Strategic direction", value: "strategic_direction" },
];
