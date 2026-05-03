// Centralized date math + day constants used across the app.
// Everything here is local-time. ISO strings are "YYYY-MM-DD" (no time/zone).

export const DAYS = [
  { key: "mon", label: "Monday", short: "Mon" },
  { key: "tue", label: "Tuesday", short: "Tue" },
  { key: "wed", label: "Wednesday", short: "Wed" },
  { key: "thu", label: "Thursday", short: "Thu" },
  { key: "fri", label: "Friday", short: "Fri" },
  { key: "sat", label: "Saturday", short: "Sat" },
  { key: "sun", label: "Sunday", short: "Sun" },
];

export const VALID_DAY_KEYS = new Set(DAYS.map((d) => d.key));

// Index this with new Date().getDay() (0=Sun, 1=Mon, ..., 6=Sat).
export const DAY_KEY_BY_GETDAY = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

const DAY_OFFSET_FROM_MONDAY = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

export function dayOffsetFromMonday(dayKey) {
  return DAY_OFFSET_FROM_MONDAY[dayKey] ?? 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function mondayOf(date) {
  const d = new Date(date);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse "YYYY-MM-DD" as a local-midnight Date so day arithmetic doesn't drift
// across timezones.
export function parseISO(iso) {
  if (!iso || typeof iso !== "string") return null;
  return new Date(iso + "T00:00:00");
}

export function addDays(date, n) {
  const r = new Date(date);
  r.setDate(r.getDate() + n);
  return r;
}

// Whole-day count from a → b. Negative if b is before a. Tolerant of DST
// because we round.
export function daysBetween(a, b) {
  const aMid = new Date(a);
  const bMid = new Date(b);
  aMid.setHours(0, 0, 0, 0);
  bMid.setHours(0, 0, 0, 0);
  return Math.round((bMid.getTime() - aMid.getTime()) / MS_PER_DAY);
}

export function weeksBetween(a, b) {
  return Math.ceil(daysBetween(a, b) / 7);
}

// Inclusive list of weeks (each item is the Monday of that week) spanning
// from mondayOf(startDate) to mondayOf(endDate). If endDate is before
// startDate, returns just [mondayOf(startDate)].
export function weeksFromTo(startDate, endDate) {
  const startMon = mondayOf(startDate);
  const endMon = endDate ? mondayOf(endDate) : startMon;
  const out = [];
  let cur = startMon;
  // Cap to prevent runaway loops if the deadline is wildly far out.
  let safety = 520; // ~10 years of weeks
  while (cur.getTime() <= endMon.getTime() && safety-- > 0) {
    out.push({ start: new Date(cur), isoStart: isoDate(cur) });
    cur = addDays(cur, 7);
  }
  if (out.length === 0) {
    out.push({ start: startMon, isoStart: isoDate(startMon) });
  }
  return out;
}

export function todayKey() {
  return DAY_KEY_BY_GETDAY[new Date().getDay()];
}

export function thisWeekDates() {
  const monday = mondayOf(new Date());
  return DAYS.map((d, i) => ({ ...d, date: addDays(monday, i) }));
}

export function formatLongDate(d) {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function formatShortDate(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "23 days", "3 weeks", "Mar 15", "Overdue 4d", or null if no deadline.
// Ranges: <14d → "N day(s)", 14–89d → "N weeks", ≥90d → calendar date,
// negative → "Overdue Nd".
export function formatTimeRemaining(deadlineIso) {
  if (!deadlineIso) return null;
  const deadline = parseISO(deadlineIso);
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = daysBetween(today, deadline);
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return "Due today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 90) return `${Math.ceil(days / 7)} weeks`;
  return formatShortDate(deadline);
}

// Color tone for the time-remaining pill. Returns one of "red", "amber",
// "neutral", "overdue".
export function timeRemainingTone(deadlineIso) {
  if (!deadlineIso) return "neutral";
  const deadline = parseISO(deadlineIso);
  if (!deadline) return "neutral";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = daysBetween(today, deadline);
  if (days < 0) return "overdue";
  if (days <= 7) return "red";
  if (days <= 21) return "amber";
  return "neutral";
}

// ─── Habit cadence helpers ──────────────────────────────────────────────
//
// Cadence shapes (matched on `kind`):
//   { kind: "daily" }
//   { kind: "weekly_count", count: number }
//   { kind: "weekdays", days: ["mon","wed","fri"] }
//
// All inputs are local-time. `completions` is the full
// `state.habitCompletions[]` array (we filter by habitId here so callers
// don't have to pre-filter).

function _dayKey(date) {
  return DAY_KEY_BY_GETDAY[date.getDay()];
}

// Whether a habit expects completion on a given local date.
export function isExpectedOn(habit, date) {
  if (!habit || !habit.cadence) return false;
  const c = habit.cadence;
  if (c.kind === "daily") return true;
  if (c.kind === "weekdays") {
    return Array.isArray(c.days) && c.days.includes(_dayKey(date));
  }
  if (c.kind === "weekly_count") {
    // Every day is "completable" — the habit doesn't care which day, just
    // that there are N completions per ISO week.
    return true;
  }
  return false;
}

// Build a Map<isoDate, completion[]> indexed by date. Cheaper than
// re-scanning the completions array for every isCompletedOn() call.
export function indexCompletionsByDate(completions, habitId) {
  const byDate = new Map();
  for (const c of completions || []) {
    if (!c || !c.date) continue;
    if (habitId && c.habitId !== habitId) continue;
    if (!byDate.has(c.date)) byDate.set(c.date, []);
    byDate.get(c.date).push(c);
  }
  return byDate;
}

export function isCompletedOn(habit, byDate, date) {
  const list = byDate.get(isoDate(date));
  if (!list) return false;
  return list.some((c) => c.habitId === habit.id);
}

// Number of completions for a habit in a given Mon-Sun week.
export function completionsInWeek(habit, byDate, weekMonday) {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    if (isCompletedOn(habit, byDate, addDays(weekMonday, i))) count += 1;
  }
  return count;
}

// For weekly_count: how is THIS week tracking against the target?
// Returns { completed, target } or null for non-weekly_count habits.
// Used to render "1/3 this week" alongside the streak number.
export function thisWeekProgress(habit, completions) {
  if (!habit || habit.cadence?.kind !== "weekly_count") return null;
  const byDate = indexCompletionsByDate(completions, habit.id);
  const monday = mondayOf(new Date());
  const completed = completionsInWeek(habit, byDate, monday);
  return {
    completed,
    target: Math.max(1, habit.cadence.count || 1),
  };
}

// Current streak ending today.
//
// daily:        consecutive prior days completed; today "in progress" if not
//               yet done (does not break streak until tomorrow).
// weekdays:     same, but skipping non-expected days (they neither count nor
//               break the streak).
// weekly_count: consecutive PRIOR ISO weeks where completions ≥ count. The
//               current (incomplete) week is in-progress and excluded — it
//               doesn't count as a hit yet, but doesn't break the streak
//               either. See thisWeekProgress() for the in-progress display.
export function currentStreak(habit, completions) {
  if (!habit) return 0;
  const byDate = indexCompletionsByDate(completions, habit.id);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const c = habit.cadence || {};

  if (c.kind === "weekly_count") {
    const target = Math.max(1, c.count || 1);
    // Walk back starting from the week BEFORE this one.
    let cur = addDays(mondayOf(today), -7);
    let streak = 0;
    for (let i = 0; i < 520; i++) {
      // 10-year cap
      if (completionsInWeek(habit, byDate, cur) >= target) {
        streak += 1;
        cur = addDays(cur, -7);
      } else {
        break;
      }
    }
    return streak;
  }

  // daily / weekdays: count back from today (or yesterday if today is
  // expected-but-not-yet-done so we don't decrement mid-day).
  let day = new Date(today);
  if (isExpectedOn(habit, day) && !isCompletedOn(habit, byDate, day)) {
    day = addDays(day, -1);
  }
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    if (!isExpectedOn(habit, day)) {
      day = addDays(day, -1);
      continue;
    }
    if (isCompletedOn(habit, byDate, day)) {
      streak += 1;
      day = addDays(day, -1);
    } else {
      break;
    }
  }
  return streak;
}

// All-time longest streak. Walks every relevant date from the earliest
// completion through today and tracks runs.
export function longestStreak(habit, completions) {
  if (!habit) return 0;
  const dates = (completions || [])
    .filter((c) => c && c.habitId === habit.id && c.date)
    .map((c) => c.date);
  if (dates.length === 0) return 0;
  const byDate = indexCompletionsByDate(completions, habit.id);
  const c = habit.cadence || {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (c.kind === "weekly_count") {
    const target = Math.max(1, c.count || 1);
    // Earliest completion week → exclude current (in-progress) week.
    const sorted = [...new Set(dates)].sort();
    const earliest = mondayOf(parseISO(sorted[0]));
    const lastClosedMonday = addDays(mondayOf(today), -7);
    let cur = new Date(earliest);
    let best = 0;
    let run = 0;
    for (let i = 0; i < 520; i++) {
      if (cur > lastClosedMonday) break;
      if (completionsInWeek(habit, byDate, cur) >= target) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
      cur = addDays(cur, 7);
    }
    return best;
  }

  // daily / weekdays — walk every date from earliest to today, counting
  // expected-and-completed runs. Non-expected days are skipped silently.
  const sorted = [...dates].sort();
  let day = parseISO(sorted[0]);
  if (!day) return 0;
  let best = 0;
  let run = 0;
  for (let i = 0; i < 4000; i++) {
    if (day > today) break;
    if (isExpectedOn(habit, day)) {
      if (isCompletedOn(habit, byDate, day)) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    day = addDays(day, 1);
  }
  return best;
}

// Last-N day strip. Oldest-first array of
//   { date: Date, expected: bool, completed: bool }.
// Use for the per-card 30-day strip and the 90-day heatmap.
export function lastN(habit, completions, n) {
  if (!habit) return [];
  const byDate = indexCompletionsByDate(completions, habit.id);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cells = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    cells.push({
      date: d,
      iso: isoDate(d),
      expected: isExpectedOn(habit, d),
      completed: isCompletedOn(habit, byDate, d),
    });
  }
  return cells;
}
