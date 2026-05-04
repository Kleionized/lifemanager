// Plan view — Today / Week / Term / Stats / Rules / Edit. Renders against
// a Convex bundle (plan + schedules + lectures + days + tracking + rules)
// loaded by the parent. Custom-built liquid-glass calendar, gantt, and
// stats components — nothing here is a CSS port from the source HTML.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { isoDate, parseISO, addDays, daysBetween, mondayOf } from "./dates";

// ──────────────── Constants ────────────────

// Category id "lnat" is preserved (existing data references it) but the
// user-visible label is "Startup" — the broader thing the user is actually
// working on, of which LNAT is one expression.
const CATEGORIES = [
  { id: "finals", label: "Finals", goalCategory: true },
  { id: "essays", label: "Essays", goalCategory: false },
  { id: "lnat", label: "Startup", goalCategory: true },
  { id: "fitness", label: "Fitness", goalCategory: true },
  { id: "life", label: "Life", goalCategory: false },
  { id: "rest", label: "Rest", goalCategory: false },
  { id: "lecture", label: "Lectures", goalCategory: false },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const ENERGY_LEVELS = [
  {
    id: "high",
    label: "High energy",
    sub: "Full schedule — finals + startup + gym",
  },
  {
    id: "low",
    label: "Tired / low energy",
    sub: "Lighter blocks, longer rest",
  },
  {
    id: "moderate",
    label: "Moderately ill",
    sub: "Audiobook + naps, no real work",
  },
  { id: "sick", label: "Sick / unwell", sub: "Nothing. Sleep is the work." },
  {
    id: "free",
    label: "Free day",
    sub: "No plan. Default for Sundays.",
  },
];

// Energy ids that produce zero blocks on the timetable.
const NO_BLOCKS_ENERGIES = new Set(["sick", "free"]);

const ENERGY_BY_ID = Object.fromEntries(ENERGY_LEVELS.map((e) => [e.id, e]));

const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TIMELINE_START_MIN = 6 * 60; // 06:00
const TIMELINE_END_MIN = 23 * 60; // 23:00
const TIMELINE_SPAN_MIN = TIMELINE_END_MIN - TIMELINE_START_MIN;
// Google-Calendar-style row height. 1.4 px/min → 84px/hour, comfortable for
// 30-minute blocks to be readable without crowding.
const PX_PER_MIN = 1.4;
const HOUR_PX = 60 * PX_PER_MIN;
const TIMELINE_HEIGHT_PX = TIMELINE_SPAN_MIN * PX_PER_MIN;
const HOURS = Array.from({ length: 18 }, (_, i) => 6 + i); // 06..23

const TABS = [
  { id: "today", label: "Today", icon: "solar:sun-2-bold-duotone" },
  { id: "week", label: "Week", icon: "solar:calendar-bold-duotone" },
  { id: "term", label: "Term", icon: "solar:calendar-search-bold-duotone" },
  { id: "stats", label: "Stats", icon: "solar:chart-2-bold-duotone" },
  { id: "rules", label: "Rules", icon: "solar:checklist-bold-duotone" },
  { id: "edit", label: "Edit", icon: "solar:pen-bold-duotone" },
];

// ──────────────── Helpers ────────────────

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const fmtMin = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const blockKey = (b) => `${b.s}_${b.e}_${b.c}`;

// Term math — week 1 is the week of `startDate` (a Monday).
function termWeekOf(plan, date) {
  if (!plan?.startDate) return 1;
  const start = parseISO(plan.startDate);
  if (!start) return 1;
  const days = daysBetween(start, date);
  if (days < 0) return 1;
  return Math.max(
    1,
    Math.min(plan.weekCount || 8, Math.floor(days / 7) + 1)
  );
}

// Phase computed from the plan's phaseShiftWeek + active phaseOverride.
function effectivePhaseFor(plan, date) {
  const ovr = plan?.phaseOverride;
  if (ovr === "essay" || ovr === "revision") return ovr;
  const shift = plan?.phaseShiftWeek ?? Math.ceil((plan?.weekCount || 8) / 2);
  const w = termWeekOf(plan, date);
  return w < shift ? "essay" : "revision";
}

// Pick a schedule from the bundle for a given (energy, phase). Falls back
// to phase="" if a phase-specific row doesn't exist (e.g. low/moderate
// don't split by phase). Sick / free always render no blocks.
function scheduleFor(schedules, energy, phase) {
  if (!schedules) return null;
  if (NO_BLOCKS_ENERGIES.has(energy)) return null;
  const exact = schedules.find(
    (s) => s.energy === energy && s.phase === phase
  );
  if (exact) return exact;
  const noPhase = schedules.find((s) => s.energy === energy && s.phase === "");
  return noPhase || null;
}

// Default energy for a date when the user hasn't picked yet. Sundays are
// "free" days with zero blocks; everything else alternates high/low
// anchored to the plan start.
function defaultEnergyFor(plan, date) {
  if (date.getDay() === 0) return "free";
  if (!plan?.startDate) return "high";
  const start = parseISO(plan.startDate);
  if (!start) return "high";
  const days = daysBetween(start, date);
  if (days < 0) return "high";
  return days % 2 === 0 ? "high" : "low";
}

// Build the layout-ready event list for a single date.
function eventsForDate(bundle, date) {
  const dateIso = isoDate(date);
  const dow = date.getDay();
  const dayRow = bundle.days.find((d) => d.date === dateIso);
  const energy = dayRow?.energy || defaultEnergyFor(bundle.plan, date);

  const events = [];
  // Schedule template blocks — only when this energy level has a
  // schedule. Sick / free skip the schedule.
  if (!NO_BLOCKS_ENERGIES.has(energy)) {
    const phase = effectivePhaseFor(bundle.plan, date);
    const sched = scheduleFor(bundle.schedules, energy, phase);
    if (sched) {
      for (const b of sched.blocks) {
        events.push({
          ...b,
          startMin: toMin(b.s),
          endMin: toMin(b.e),
        });
      }
    }
  }
  // Lectures and tutorials are fixed commitments tied to a specific
  // date. They show regardless of energy level — even on free or sick
  // days, the lecture still happens at its scheduled time.
  const lec = bundle.lectures.find((l) => l.dow === dow);
  if (lec) {
    for (const b of lec.blocks) {
      events.push({
        ...b,
        startMin: toMin(b.s),
        endMin: toMin(b.e),
      });
    }
  }
  // Lectures are fixed commitments. Instead of dropping a 90-minute
  // schedule block because its tail clashes with a lecture, slice the
  // schedule block into the segment(s) that don't overlap. Then fill
  // any remaining > 25-minute gaps with a generic study block (or lunch
  // if it lands in the lunch window).
  const lectureSpans = events.filter((e) => e.c === "lecture");
  const scheduleSpans = events.filter((e) => e.c !== "lecture");
  const trimmed = trimAroundLectures(scheduleSpans, lectureSpans);
  const filled = fillGaps([...lectureSpans, ...trimmed]);
  return {
    energy,
    dateIso,
    events: layoutColumns(filled),
  };
}

// Cut each schedule block around lecture overlaps. If a lecture sits in
// the middle, the block splits into two segments (before/after). If the
// remainder is shorter than ~15 min after slicing, drop that fragment —
// it's not enough time to be worth showing.
function trimAroundLectures(scheduleEvents, lectureEvents) {
  const out = [];
  for (const ev of scheduleEvents) {
    let segments = [{ s: ev.startMin, e: ev.endMin }];
    for (const lec of lectureEvents) {
      const next = [];
      for (const seg of segments) {
        if (lec.endMin <= seg.s || lec.startMin >= seg.e) {
          next.push(seg);
        } else {
          if (lec.startMin > seg.s) next.push({ s: seg.s, e: lec.startMin });
          if (lec.endMin < seg.e) next.push({ s: lec.endMin, e: seg.e });
        }
      }
      segments = next;
    }
    for (const seg of segments) {
      const dur = seg.e - seg.s;
      if (dur < 15) continue;
      out.push({
        ...ev,
        startMin: seg.s,
        endMin: seg.e,
        s: fmtMin(seg.s),
        e: fmtMin(seg.e),
        d: `${dur}m`,
      });
    }
  }
  return out;
}

// Walk the timeline; for each gap >= 5 min between scheduled events,
// close it by *adjusting the existing blocks* rather than inserting a
// new filler. If the next block is a lecture (its start time is a hard
// constraint), the previous block extends to meet it. Otherwise, the
// next block starts earlier so it abuts the previous one. Two adjacent
// lectures with a gap between them are left alone — both are fixed.
function fillGaps(events) {
  if (events.length < 2) return events;
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin);
  const out = sorted.map((e) => ({ ...e }));
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i];
    const next = out[i + 1];
    const gap = next.startMin - cur.endMin;
    if (gap < 5) continue;
    const prevIsLecture = cur.c === "lecture";
    const nextIsLecture = next.c === "lecture";
    if (prevIsLecture && nextIsLecture) continue;
    if (nextIsLecture) {
      cur.endMin = next.startMin;
      cur.e = fmtMin(cur.endMin);
      cur.d = `${cur.endMin - cur.startMin}m`;
    } else {
      next.startMin = cur.endMin;
      next.s = fmtMin(next.startMin);
      next.d = `${next.endMin - next.startMin}m`;
    }
  }
  return out;
}

// Pack overlapping events into columns. Each event gets `col` and
// `totalCols` so the calendar can compute width = (1/totalCols) and
// left = col * width.
function layoutColumns(events) {
  const sorted = [...events].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin
  );
  const out = [];
  let group = [];
  let groupEnd = 0;

  function flush() {
    const cols = [];
    for (const ev of group) {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] <= ev.startMin) {
          ev.col = i;
          cols[i] = ev.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev.col = cols.length;
        cols.push(ev.endMin);
      }
    }
    for (const ev of group) ev.totalCols = cols.length;
    out.push(...group);
  }

  for (const ev of sorted) {
    if (group.length === 0) {
      group.push(ev);
      groupEnd = ev.endMin;
    } else if (ev.startMin < groupEnd) {
      group.push(ev);
      groupEnd = Math.max(groupEnd, ev.endMin);
    } else {
      flush();
      group = [ev];
      groupEnd = ev.endMin;
    }
  }
  if (group.length) flush();
  return out;
}

// Tracking lookup — { dateIso → { blockKey → status } }.
function indexTracking(tracking) {
  const ix = new Map();
  for (const t of tracking || []) {
    if (!ix.has(t.date)) ix.set(t.date, new Map());
    ix.get(t.date).set(t.blockKey, t);
  }
  return ix;
}

// ──────────────── Sub-component: category-tinted glass event ────────────────

function categoryStyleFor(catId) {
  return {
    backgroundColor: `var(--plan-${catId}-fill)`,
    color: `var(--plan-${catId}-text)`,
  };
}

function CalendarEvent({
  event,
  status,
  isNow,
  onClick,
}) {
  const top = (event.startMin - TIMELINE_START_MIN) * PX_PER_MIN;
  const heightRaw = (event.endMin - event.startMin) * PX_PER_MIN;
  const height = Math.max(20, heightRaw - 2);
  const widthPct = 100 / event.totalCols;
  const leftPct = event.col * widthPct;
  const isShort = heightRaw < 32;
  const time = `${fmtMin(event.startMin)}–${fmtMin(event.endMin)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={["plan-event", isNow ? "is-now" : ""].join(" ")}
      data-status={status?.status || ""}
      style={{
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${leftPct}% + 1px)`,
        width: `calc(${widthPct}% - 4px)`,
        textAlign: "left",
        ...categoryStyleFor(event.c),
      }}
      title={`${event.t} · ${time}`}
    >
      <div className="plan-event-title font-medium truncate">{event.t}</div>
      {!isShort && (
        <div className="text-[11px] opacity-75 truncate mt-0.5">{time}</div>
      )}
    </button>
  );
}

// ──────────────── Sub-component: vertical timetable (1 or N cols) ────────────────

function NowLine({ nowMin }) {
  if (nowMin < TIMELINE_START_MIN || nowMin > TIMELINE_END_MIN) return null;
  const top = (nowMin - TIMELINE_START_MIN) * PX_PER_MIN;
  return <div className="plan-now-line" style={{ top: `${top}px` }} />;
}

function TimeColumn() {
  return (
    <div className="border-r border-black/10 dark:border-white/10 select-none">
      <div className="h-11 sticky top-0 z-[3] bg-transparent" />
      {HOURS.map((h, i) => (
        <div
          key={h}
          className={[
            "text-[11px] text-neutral-500 dark:text-neutral-400 text-right pr-2.5 pt-1.5",
            i === 0 ? "" : "border-t border-black/10 dark:border-white/10",
          ].join(" ")}
          style={{ height: `${HOUR_PX}px` }}
        >
          {String(h).padStart(2, "0")}:00
        </div>
      ))}
    </div>
  );
}

function DayHeader({ label, dom, energy, isToday }) {
  return (
    <div
      className={[
        "h-11 sticky top-0 z-[2] flex items-center justify-center gap-2 text-[13px] font-medium border-b backdrop-blur-md border-black/10 dark:border-white/10",
        isToday
          ? "text-neutral-900 dark:text-neutral-100"
          : "text-neutral-600 dark:text-neutral-400",
      ].join(" ")}
    >
      <span>{label}</span>
      <span
        className={[
          "inline-flex items-center justify-center text-[12px] rounded-full",
          isToday
            ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900 w-6 h-6"
            : "text-neutral-700 dark:text-neutral-200 font-semibold",
        ].join(" ")}
      >
        {dom}
      </span>
      {energy && (
        <span
          className={[
            "ml-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded",
            energy === "sick"
              ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : energy === "free"
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : energy === "moderate"
                  ? "bg-pink-500/15 text-pink-700 dark:text-pink-300"
                  : energy === "low"
                    ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
          ].join(" ")}
        >
          {energy}
        </span>
      )}
    </div>
  );
}

function DayColumn({
  date,
  events,
  energy,
  isToday,
  trackingForDate,
  nowMin,
  currentEvent,
  onEventClick,
}) {
  const dateIso = isoDate(date);
  const dom = String(date.getDate());
  const dayLabel = DAY_SHORT[date.getDay()];
  return (
    <div className="relative min-w-0 border-l border-black/10 dark:border-white/10 first:border-l-0">
      <DayHeader
        label={dayLabel}
        dom={dom}
        energy={energy}
        isToday={isToday}
      />
      <div
        className="relative"
        style={{
          height: `${TIMELINE_HEIGHT_PX}px`,
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.07) 0.5px, transparent 0.5px)",
          backgroundSize: `100% ${HOUR_PX}px`,
          backgroundRepeat: "repeat-y",
        }}
      >
        {NO_BLOCKS_ENERGIES.has(energy) && events.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {energy === "free" ? "Free day." : "Rest day."}
          </div>
        ) : (
          events.map((ev) => {
            const status = trackingForDate?.get(blockKey(ev));
            const isNow =
              isToday && currentEvent && blockKey(currentEvent) === blockKey(ev);
            return (
              <CalendarEvent
                key={blockKey(ev)}
                event={ev}
                status={status}
                isNow={isNow}
                onClick={() => onEventClick(ev, dateIso)}
              />
            );
          })
        )}
        {isToday && <NowLine nowMin={nowMin} />}
      </div>
    </div>
  );
}

function DayCalendar({
  date,
  events,
  energy,
  isToday,
  trackingForDate,
  nowMin,
  currentEvent,
  onEventClick,
}) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (7 - 6) * HOUR_PX - 12;
    }
  }, []);
  return (
    <div
      ref={scrollRef}
      className="overflow-auto border-t border-black/10 dark:border-white/10 -mx-10"
      style={{ height: "calc(100vh - 7rem)" }}
    >
      <div
        className="grid"
        style={{ gridTemplateColumns: "64px 1fr", minWidth: "100%" }}
      >
        <TimeColumn />
        <DayColumn
          date={date}
          events={events}
          energy={energy}
          isToday={isToday}
          trackingForDate={trackingForDate}
          nowMin={nowMin}
          currentEvent={currentEvent}
          onEventClick={onEventClick}
        />
      </div>
    </div>
  );
}

function WeekCalendar({
  monday,
  bundle,
  trackingByDate,
  nowMin,
  currentEvent,
  onEventClick,
  todayIso,
}) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (7 - 6) * HOUR_PX - 12;
    }
  }, []);
  // Mon–Sat only. Sundays are intentionally omitted from the week view —
  // they're free days with no plan, so they'd just render as a blank
  // column eating real estate.
  const cols = useMemo(() => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const d = addDays(monday, i);
      const computed = eventsForDate(bundle, d);
      out.push({ date: d, ...computed });
    }
    return out;
  }, [monday, bundle]);
  return (
    <div
      ref={scrollRef}
      className="overflow-auto border-t border-black/10 dark:border-white/10 -mx-10 -mt-3"
      style={{ height: "calc(100vh - 6rem)" }}
    >
      <div
        className="grid"
        style={{ gridTemplateColumns: "64px 1fr", minWidth: "960px" }}
      >
        <TimeColumn />
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(6, minmax(140px,1fr))" }}
        >
          {cols.map((c) => (
            <DayColumn
              key={isoDate(c.date)}
              date={c.date}
              events={c.events}
              energy={c.energy}
              isToday={isoDate(c.date) === todayIso}
              trackingForDate={trackingByDate.get(isoDate(c.date))}
              nowMin={nowMin}
              currentEvent={currentEvent}
              onEventClick={onEventClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────── Now card (current block + progress + next) ────────────────

function NowCard({ events, nowMin, energy, noBlocks }) {
  if (noBlocks) {
    const isFree = energy === "free";
    return (
      <div className="lg-card rounded-2xl px-6 py-5">
        <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {isFree ? "Free day" : "Sick day"}
        </div>
        <div className="text-base font-medium mt-1">
          {isFree
            ? "No plan today. Do whatever feels right."
            : "Rest. That is the schedule."}
        </div>
        <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-3 pt-3 border-t border-black/10 dark:border-white/10">
          Tomorrow: resume normal plan.
        </div>
      </div>
    );
  }
  const items = [...events].sort((a, b) => a.startMin - b.startMin);
  const overlapping = items.filter(
    (it) => nowMin >= it.startMin && nowMin < it.endMin
  );
  const current =
    overlapping.find((o) => o.c === "lecture") || overlapping[0] || null;
  let next = null;
  if (current) {
    next = items.find((it) => it.startMin >= current.endMin) || null;
  } else {
    next = items.find((it) => it.startMin > nowMin) || null;
  }

  let label, title, time, progressPct, nextEl;
  if (current) {
    const sm = current.startMin;
    const em = current.endMin;
    progressPct = Math.round(((nowMin - sm) / (em - sm)) * 100);
    label = `Right now · ${CATEGORY_BY_ID[current.c]?.label || current.c}`;
    title = current.t;
    time = `${fmtMin(sm)}–${fmtMin(em)} · ${progressPct}% through`;
    nextEl = next ? (
      <>
        Next: <b className="text-neutral-900 dark:text-neutral-100">{next.t}</b>{" "}
        at {fmtMin(next.startMin)}
      </>
    ) : (
      "Next: end of the day. Sleep at 22:30."
    );
  } else if (next) {
    label = "Up next";
    title = next.t;
    time = `Starts ${fmtMin(next.startMin)} · ${next.d || ""}`;
    progressPct = 0;
    const mins = next.startMin - nowMin;
    nextEl =
      mins > 0 ? (
        <>
          <b className="text-neutral-900 dark:text-neutral-100">{mins} min</b>{" "}
          until this block.
        </>
      ) : (
        "Starting any moment now."
      );
  } else {
    label = "After hours";
    title =
      nowMin < TIMELINE_START_MIN
        ? "Day hasn't started."
        : "Day's done. Wind down.";
    time = "";
    progressPct = nowMin < TIMELINE_START_MIN ? 0 : 100;
    nextEl = items[0] ? (
      <>
        Tomorrow's first block:{" "}
        <b className="text-neutral-900 dark:text-neutral-100">{items[0].t}</b>{" "}
        at {fmtMin(items[0].startMin)}
      </>
    ) : (
      "Tomorrow's first block: —"
    );
  }

  const cat = current?.c;
  const accentVar = cat ? `var(--plan-${cat}-ac)` : "rgb(38 38 38)";
  return (
    <div className="lg-card rounded-2xl px-6 py-5">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div className="text-lg font-medium mt-1">{title}</div>
      {time && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          {time}
        </div>
      )}
      <div
        className="mt-3 h-1 rounded-full overflow-hidden"
        style={{ background: "rgba(0,0,0,0.08)" }}
      >
        <div
          className="h-full transition-all duration-700 ease-out"
          style={{
            width: `${Math.max(0, Math.min(100, progressPct))}%`,
            background: accentVar,
          }}
        />
      </div>
      <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10 text-xs text-neutral-500 dark:text-neutral-400">
        {nextEl}
      </div>
    </div>
  );
}

// ──────────────── Energy / phase toggle bar ────────────────

function PillToggle({ options, value, onChange, size = "md" }) {
  return (
    <div
      className={[
        "inline-flex gap-1 p-1 rounded-lg lg-card",
        size === "sm" ? "" : "",
      ].join(" ")}
    >
      {options.map((opt) => {
        const on = opt.id === value;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={[
              "px-3 rounded-md transition-all duration-150",
              size === "sm" ? "text-[12px] py-1" : "text-[13px] py-1.5",
              on
                ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900 shadow-sm"
                : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────── Energy picker modal ────────────────

function EnergyPicker({ open, onClose, onPick, suggestedId, dayLabel }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="lg-card rounded-2xl p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">How are you today?</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          {dayLabel} · suggested:{" "}
          <span className="text-neutral-900 dark:text-neutral-100 font-medium">
            {ENERGY_BY_ID[suggestedId]?.label}
          </span>{" "}
          (alternating rhythm)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
          {ENERGY_LEVELS.map((l) => {
            const isSuggested = l.id === suggestedId;
            return (
              <button
                key={l.id}
                onClick={() => onPick(l.id)}
                className={[
                  "lg-task rounded-xl px-3 py-3 text-left transition-all",
                  isSuggested ? "ring-1 ring-blue-500/50" : "",
                ].join(" ")}
              >
                <div className="text-sm font-semibold">{l.label}</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
                  {l.sub}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ──────────────── Tracking modal ────────────────

function TrackingModal({ open, ev, dateIso, currentStatus, onClose, onSet }) {
  if (!open || !ev) return null;
  const STATUSES = [
    {
      id: "completed",
      label: "Completed",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    },
    {
      id: "half",
      label: "Half-followed",
      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
    },
    {
      id: "missed",
      label: "Missed",
      cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40",
    },
  ];
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="lg-card rounded-2xl p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{ev.t}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          {ev.s}–{ev.e} · {ev.d} ·{" "}
          {CATEGORY_BY_ID[ev.c]?.label || ev.c}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-4">
          How did this go?
        </p>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {STATUSES.map((s) => {
            const active = currentStatus === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSet(s.id)}
                className={[
                  "px-3 py-2 rounded-md text-sm font-medium border transition-all",
                  active
                    ? s.cls
                    : "lg-task border-transparent text-neutral-700 dark:text-neutral-300",
                ].join(" ")}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {currentStatus && (
            <button
              className="px-3 py-1.5 rounded-md text-xs text-neutral-600 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
              onClick={() => onSet("clear")}
            >
              Clear
            </button>
          )}
          <button
            className="px-3 py-1.5 rounded-md text-xs text-neutral-600 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────── Today view ────────────────

function TodayView({ bundle, goals, todayDate, nowMin, openTracking, mut }) {
  const todayIso = isoDate(todayDate);
  const dayRow = bundle.days.find((d) => d.date === todayIso);
  const energy = dayRow?.energy || defaultEnergyFor(bundle.plan, todayDate);
  const phase = effectivePhaseFor(bundle.plan, todayDate);
  const week = termWeekOf(bundle.plan, todayDate);
  const { events } = eventsForDate(bundle, todayDate);
  const trackingByDate = useMemo(
    () => indexTracking(bundle.tracking),
    [bundle.tracking]
  );
  const trackingForDate = trackingByDate.get(todayIso);

  const sortedItems = [...events].sort((a, b) => a.startMin - b.startMin);
  const overlapping = sortedItems.filter(
    (it) => nowMin >= it.startMin && nowMin < it.endMin
  );
  const currentEvent =
    overlapping.find((o) => o.c === "lecture") || overlapping[0] || null;

  const subtitle = `${DAY_FULL[todayDate.getDay()]} · Week ${week} · ${phase === "essay" ? "Essay" : "Revision"} · ${ENERGY_BY_ID[energy]?.label?.split(" ")[0] || energy}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap text-xs text-neutral-500 dark:text-neutral-400">
        <span>{subtitle}</span>
        <PillToggle
          size="sm"
          options={ENERGY_LEVELS.map((e) => ({ id: e.id, label: e.label.split(" ")[0] }))}
          value={energy}
          onChange={(id) =>
            mut.setDayEnergy({
              planId: bundle.plan._id,
              date: todayIso,
              energy: id,
            })
          }
        />
        <PillToggle
          size="sm"
          options={[
            { id: "auto", label: "Auto" },
            { id: "essay", label: "Essay" },
            { id: "revision", label: "Revision" },
          ]}
          value={bundle.plan.phaseOverride || "auto"}
          onChange={(id) =>
            mut.updatePlan({
              id: bundle.plan._id,
              phaseOverride: id,
            })
          }
        />
      </div>

      {NO_BLOCKS_ENERGIES.has(energy) && events.length === 0 ? (
        <div className="border border-black/10 dark:border-white/10 rounded-md p-12 text-center">
          <div className="inline-block px-3 py-1.5 rounded-md text-sm bg-neutral-200/60 dark:bg-neutral-800/60 text-neutral-700 dark:text-neutral-300">
            No schedule today.
          </div>
          <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
            {energy === "free"
              ? "Free day. Do whatever feels right — no targets, no quota. The plan resumes tomorrow."
              : "Sleep is the work. Hydrate, rest, send one message to your co-founder, then close Slack. Resume tomorrow — don't catch up."}
          </p>
        </div>
      ) : (
        <DayCalendar
          date={todayDate}
          events={events}
          energy={energy}
          isToday={true}
          trackingForDate={trackingForDate}
          nowMin={nowMin}
          currentEvent={currentEvent}
          onEventClick={(ev, dateIso) => openTracking(ev, dateIso)}
        />
      )}
    </div>
  );
}

// ──────────────── Week view ────────────────

function WeekView({ bundle, todayDate, nowMin, openTracking }) {
  const todayIso = isoDate(todayDate);
  const monday = mondayOf(todayDate);
  const sortedItems = useMemo(() => {
    const { events } = eventsForDate(bundle, todayDate);
    return [...events].sort((a, b) => a.startMin - b.startMin);
  }, [bundle, todayDate]);
  const overlapping = sortedItems.filter(
    (it) => nowMin >= it.startMin && nowMin < it.endMin
  );
  const currentEvent =
    overlapping.find((o) => o.c === "lecture") || overlapping[0] || null;
  const trackingByDate = useMemo(
    () => indexTracking(bundle.tracking),
    [bundle.tracking]
  );
  return (
    <WeekCalendar
      monday={monday}
      bundle={bundle}
      trackingByDate={trackingByDate}
      nowMin={nowMin}
      currentEvent={currentEvent}
      onEventClick={(ev, dateIso) => openTracking(ev, dateIso)}
      todayIso={todayIso}
    />
  );
}

function CategoryLegend({ goals, bundle }) {
  const goalLinks = bundle?.plan?.goalLinks || {};
  const goalById = goals
    ? Object.fromEntries(goals.map((g) => [g.id, g]))
    : {};
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {CATEGORIES.map((c) => {
        const linkedGoal = goalById[goalLinks[c.id]];
        return (
          <span
            key={c.id}
            className="inline-flex items-center gap-2 lg-task rounded-md px-2.5 py-1 text-[11px]"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: `var(--plan-${c.id}-ac)` }}
            />
            <span className="text-neutral-700 dark:text-neutral-300">
              {c.label}
            </span>
            {linkedGoal && (
              <span className="text-neutral-500 dark:text-neutral-500">
                · {linkedGoal.title}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ──────────────── Term view ────────────────

function TermView({ bundle, todayDate, goals }) {
  const plan = bundle.plan;
  const weekCount = plan.weekCount || 8;
  const phaseShift = plan.phaseShiftWeek ?? Math.ceil(weekCount / 2);
  const examWeek = plan.examWeek;
  const currentWeek = termWeekOf(plan, todayDate);
  const weeks = Array.from({ length: weekCount }, (_, i) => i + 1);

  const goalLinks = plan.goalLinks || {};
  const goalById = goals
    ? Object.fromEntries(goals.map((g) => [g.id, g]))
    : {};

  // Tracking per week to drive a finals-intensity ramp.
  const tracking = bundle.tracking || [];
  const finalsScores = weeks.map((w) => {
    const weekStart = addDays(parseISO(plan.startDate), (w - 1) * 7);
    const weekEnd = addDays(weekStart, 7);
    const inWeek = tracking.filter((t) => {
      if (t.category !== "finals") return false;
      const td = parseISO(t.date);
      return td && td >= weekStart && td < weekEnd;
    });
    const c = inWeek.filter((t) => t.status === "completed").length;
    const h = inWeek.filter((t) => t.status === "half").length;
    const total = inWeek.length;
    return total > 0 ? (c + 0.5 * h) / total : 0;
  });

  const RAMP = [
    "rgba(29,158,117,0.10)",
    "rgba(29,158,117,0.18)",
    "rgba(29,158,117,0.30)",
    "rgba(29,158,117,0.45)",
    "rgba(29,158,117,0.60)",
    "rgba(29,158,117,0.78)",
    "rgba(29,158,117,0.90)",
    "rgba(29,158,117,1.00)",
  ];
  const TX_RAMP = [
    "#0F6E56",
    "#0F6E56",
    "#0F6E56",
    "#0E624D",
    "#0D5642",
    "#0C4A38",
    "#0B3E2E",
    "#0A3325",
  ];

  const Cell = ({ children, style }) => (
    <div
      className="border-l border-t border-black/10 dark:border-white/10 last:border-r-0 relative h-10"
      style={style}
    >
      {children}
    </div>
  );

  const phaseFor = (w) => {
    if (w === examWeek) return "exam";
    return w < phaseShift ? "essay" : "revision";
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {plan.name} at a glance
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
          {weekCount} weeks. Phase shift at week {phaseShift}.
          {examWeek ? ` Exams in week ${examWeek}.` : ""}
        </p>
      </header>
      <div className="lg-card rounded-xl p-5 overflow-x-auto">
        <div
          className="relative"
          style={{
            display: "grid",
            gridTemplateColumns: `120px repeat(${weekCount}, minmax(58px, 1fr))`,
            minWidth: "640px",
          }}
        >
          <div className="text-xs text-neutral-500 dark:text-neutral-400 pb-2">
            Trinity Term · {weekCount} weeks
          </div>
          {weeks.map((w) => (
            <div
              key={w}
              className={[
                "text-xs text-center pb-2 border-b border-black/10 dark:border-white/10",
                w === currentWeek
                  ? "text-neutral-900 dark:text-neutral-100 font-semibold"
                  : "text-neutral-500 dark:text-neutral-400",
              ].join(" ")}
            >
              W{w}
            </div>
          ))}

          {/* Phase row */}
          <RowLabel>Phase</RowLabel>
          {weeks.map((w) => {
            const p = phaseFor(w);
            const fill =
              p === "exam"
                ? "rgba(204, 51, 68, 0.18)"
                : p === "essay"
                  ? "var(--plan-essays-fill)"
                  : "var(--plan-finals-fill)";
            const text =
              p === "exam"
                ? "#9C2530"
                : p === "essay"
                  ? "var(--plan-essays-text)"
                  : "var(--plan-finals-text)";
            return (
              <Cell key={w}>
                <CellFill bg={fill} text={text}>
                  {p}
                </CellFill>
              </Cell>
            );
          })}

          <RowLabel>Finals</RowLabel>
          {weeks.map((w, i) => {
            if (w === examWeek)
              return (
                <Cell key={w}>
                  <CellFill
                    bg="rgba(204, 51, 68, 0.20)"
                    text="#9C2530"
                    bold
                  >
                    exams
                  </CellFill>
                </Cell>
              );
            const score = finalsScores[i];
            const bandIdx = Math.min(7, Math.floor(score * 8));
            return (
              <Cell key={w}>
                <CellFill bg={RAMP[bandIdx]} text={TX_RAMP[bandIdx]}>
                  finals
                </CellFill>
              </Cell>
            );
          })}

          <RowLabel>Essays</RowLabel>
          {weeks.map((w) =>
            w < phaseShift ? (
              <Cell key={w}>
                <CellFill
                  bg="var(--plan-essays-fill)"
                  text="var(--plan-essays-text)"
                >
                  essays
                </CellFill>
              </Cell>
            ) : (
              <Cell key={w} />
            )
          )}

          <RowLabel>LNAT</RowLabel>
          {weeks.map((w) =>
            w === examWeek ? (
              <Cell key={w}>
                <CellFill bg="rgba(204, 51, 68, 0.10)" text="#9C2530">
                  paused
                </CellFill>
              </Cell>
            ) : (
              <Cell key={w}>
                <CellFill
                  bg="var(--plan-lnat-fill)"
                  text="var(--plan-lnat-text)"
                >
                  build
                </CellFill>
              </Cell>
            )
          )}

          <RowLabel>Fitness</RowLabel>
          {weeks.map((w) =>
            w === examWeek ? (
              <Cell key={w}>
                <CellFill bg="rgba(204, 51, 68, 0.10)" text="#9C2530">
                  light
                </CellFill>
              </Cell>
            ) : (
              <Cell key={w}>
                <CellFill
                  bg="var(--plan-fitness-fill)"
                  text="var(--plan-fitness-text)"
                >
                  lift
                </CellFill>
              </Cell>
            )
          )}

          <RowLabel>Milestones</RowLabel>
          {weeks.map((w) =>
            w === phaseShift ? (
              <Cell key={w}>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="absolute top-full mt-1 text-[10px] text-rose-600 whitespace-nowrap">
                    phase shift
                  </span>
                </div>
              </Cell>
            ) : w === examWeek ? (
              <Cell key={w}>
                <CellFill bg="#cc3344" text="#fff" bold>
                  EXAM
                </CellFill>
              </Cell>
            ) : (
              <Cell key={w} />
            )
          )}

          {/* Vertical "you are here" line. */}
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-neutral-700 dark:border-neutral-300 pointer-events-none"
            style={{
              left: `calc(120px + ((100% - 120px) / ${weekCount}) * (${currentWeek - 0.5}))`,
            }}
          />
        </div>
      </div>

      {/* Goal link summary card. */}
      {Object.keys(goalLinks).length > 0 && (
        <div className="lg-card rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Linked goals</h3>
          <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Object.entries(goalLinks).map(([cat, gid]) => {
              const goal = goalById[gid];
              if (!goal) return null;
              return (
                <li
                  key={cat}
                  className="lg-task rounded-lg px-3 py-2"
                  style={categoryStyleFor(cat)}
                >
                  <div className="text-[11px] uppercase tracking-wider opacity-70">
                    {CATEGORY_BY_ID[cat]?.label}
                  </div>
                  <div className="text-sm font-semibold">{goal.title}</div>
                  {goal.targetDate && (
                    <div className="text-[11px] opacity-75 mt-0.5">
                      target {goal.targetDate}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function RowLabel({ children }) {
  return (
    <div className="text-xs text-neutral-500 dark:text-neutral-400 py-3 px-2 flex items-center border-t border-black/10 dark:border-white/10">
      {children}
    </div>
  );
}
function CellFill({ children, bg, text, bold }) {
  return (
    <div
      className="absolute inset-1 rounded text-[10px] flex items-center justify-center"
      style={{
        background: bg,
        color: text,
        border: "0.5px solid rgba(0,0,0,0.10)",
        fontWeight: bold ? 600 : 400,
      }}
    >
      {children}
    </div>
  );
}

// ──────────────── Stats view ────────────────

function StatsView({ bundle }) {
  const all = bundle.tracking || [];
  if (all.length === 0) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
            How well you've followed the plan.
          </p>
        </header>
        <div className="lg-card rounded-xl p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Nothing tracked yet. Click any block in <b>Today</b> or <b>Week</b>{" "}
          to mark it completed, half-followed, or missed — your stats will
          show up here.
        </div>
      </div>
    );
  }
  const completed = all.filter((x) => x.status === "completed").length;
  const half = all.filter((x) => x.status === "half").length;
  const missed = all.filter((x) => x.status === "missed").length;
  const total = all.length;
  const score = Math.round(((completed + 0.5 * half) / total) * 100);
  const daysTracked = new Set(all.map((x) => x.date)).size;

  const today = new Date();
  const days = [];
  let maxTotal = 1;
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const ds = isoDate(d);
    const dc = all.filter((x) => x.date === ds && x.status === "completed").length;
    const dh = all.filter((x) => x.date === ds && x.status === "half").length;
    const dm = all.filter((x) => x.date === ds && x.status === "missed").length;
    const tot = dc + dh + dm;
    if (tot > maxTotal) maxTotal = tot;
    days.push({ d, ds, completed: dc, half: dh, missed: dm, total: tot, isToday: i === 0 });
  }

  const cats = {};
  for (const e of all) {
    if (!cats[e.category]) cats[e.category] = { c: 0, h: 0, m: 0 };
    if (e.status === "completed") cats[e.category].c++;
    else if (e.status === "half") cats[e.category].h++;
    else if (e.status === "missed") cats[e.category].m++;
  }
  const catOrder = ["finals", "essays", "lnat", "fitness", "life", "rest", "lecture"];
  const sevenAgo = addDays(today, -7);
  const recent = all
    .filter((x) => {
      if (x.status === "completed") return false;
      const d = parseISO(x.date);
      return d && d >= sevenAgo;
    })
    .sort((a, b) => (b.date + b.blockKey).localeCompare(a.date + a.blockKey))
    .slice(0, 10);

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
          How well you've followed the plan.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Completion score"
          value={`${score}%`}
          sub={`Across ${total} tracked block${total === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Days tracked"
          value={String(daysTracked)}
          sub={`${daysTracked === 1 ? "day" : "days"} of data`}
        />
        <div className="lg-card rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            Breakdown
          </div>
          <div
            className="flex h-1.5 mt-3 rounded-full overflow-hidden"
            style={{ background: "rgba(0,0,0,0.07)" }}
          >
            <span
              style={{ width: `${pct(completed, total)}%`, background: "var(--plan-completed)" }}
            />
            <span
              style={{ width: `${pct(half, total)}%`, background: "var(--plan-half)" }}
            />
            <span
              style={{ width: `${pct(missed, total)}%`, background: "var(--plan-missed)" }}
            />
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
            {completed} done · {half} half · {missed} missed
          </div>
        </div>
      </div>

      <section>
        <h3 className="text-sm font-semibold mb-2">Last 14 days</h3>
        <div
          className="lg-card rounded-xl p-4"
          style={{ display: "grid", gridTemplateColumns: "repeat(14, 1fr)", gap: "8px", height: "180px" }}
        >
          {days.map((d) => {
            if (d.total === 0) {
              return (
                <div
                  key={d.ds}
                  className="flex flex-col items-center justify-end"
                >
                  <div className="w-full max-w-[24px] h-0.5 rounded-sm bg-black/10 dark:bg-white/10" />
                  <div className={["text-[10px] mt-1", d.isToday ? "text-neutral-900 dark:text-neutral-100 font-semibold" : "text-neutral-500 dark:text-neutral-400"].join(" ")}>
                    {d.d.getDate()}
                  </div>
                </div>
              );
            }
            const heightPct = Math.round((d.total / maxTotal) * 100);
            return (
              <div
                key={d.ds}
                className="flex flex-col items-center justify-end"
                title={`${d.ds}: ${d.completed} done · ${d.half} half · ${d.missed} missed`}
              >
                <div
                  className="w-full max-w-[24px] flex flex-col-reverse rounded-t overflow-hidden"
                  style={{ height: `${heightPct}%`, minHeight: "2px" }}
                >
                  {d.completed > 0 && (
                    <span style={{ flex: d.completed, background: "var(--plan-completed)" }} />
                  )}
                  {d.half > 0 && (
                    <span style={{ flex: d.half, background: "var(--plan-half)" }} />
                  )}
                  {d.missed > 0 && (
                    <span style={{ flex: d.missed, background: "var(--plan-missed)" }} />
                  )}
                </div>
                <div className={["text-[10px] mt-1", d.isToday ? "text-neutral-900 dark:text-neutral-100 font-semibold" : "text-neutral-500 dark:text-neutral-400"].join(" ")}>
                  {d.d.getDate()}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2">By category</h3>
        <div className="lg-card rounded-xl px-5 py-3">
          {catOrder
            .filter((c) => cats[c])
            .map((c, i) => {
              const b = cats[c];
              const ct = b.c + b.h + b.m;
              const sc = ct > 0 ? Math.round(((b.c + 0.5 * b.h) / ct) * 100) : 0;
              return (
                <div
                  key={c}
                  className={[
                    "grid items-center py-2.5 gap-3",
                    i > 0 ? "border-t border-black/10 dark:border-white/10" : "",
                  ].join(" ")}
                  style={{ gridTemplateColumns: "100px 1fr 64px" }}
                >
                  <div className="text-sm font-medium">
                    {CATEGORY_BY_ID[c]?.label || c}
                  </div>
                  <div
                    className="h-2 rounded-full overflow-hidden"
                    style={{ background: "rgba(0,0,0,0.07)" }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${sc}%`,
                        background: `var(--plan-${c}-ac)`,
                      }}
                    />
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 text-right">
                    {sc}% · {ct}
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      {recent.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2">
            Recent — half / missed (last 7 days)
          </h3>
          <div className="lg-card rounded-xl">
            {recent.map((r, i) => {
              const d = parseISO(r.date);
              const ds = `${DAY_SHORT[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
              const time = r.blockKey.split("_")[0];
              return (
                <div
                  key={`${r.date}-${r.blockKey}`}
                  className={[
                    "grid items-center py-3 px-4 gap-3 text-sm",
                    i > 0 ? "border-t border-black/10 dark:border-white/10" : "",
                  ].join(" ")}
                  style={{ gridTemplateColumns: "100px 1fr 100px" }}
                >
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {ds} · {time}
                  </div>
                  <div className="font-medium truncate">{r.blockTitle}</div>
                  <div
                    className={[
                      "text-[11px] uppercase tracking-wider text-right",
                      r.status === "missed"
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-amber-600 dark:text-amber-400",
                    ].join(" ")}
                  >
                    {r.status}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="lg-card rounded-xl p-4">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div className="text-3xl font-semibold mt-1.5 tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          {sub}
        </div>
      )}
    </div>
  );
}

// ──────────────── Rules view ────────────────

function RulesView({ bundle, goals }) {
  const goalLinks = bundle.plan.goalLinks || {};
  const goalById = goals
    ? Object.fromEntries(goals.map((g) => [g.id, g]))
    : {};

  const goalCardCats = ["finals", "lnat", "fitness"];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Goals & rules</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
          What this term is for, and how to decide when things go sideways.
        </p>
      </header>

      <section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {goalCardCats.map((cat, i) => {
            const linked = goalById[goalLinks[cat]];
            const fallback = {
              finals: {
                title: "Finals",
                hours: "~18–20 hrs/week · hard deadline",
                note: "Non-negotiable. The reason this term exists.",
              },
              lnat: {
                title: "LNAT Prep",
                hours: "~14–16 hrs/week · early-stage startup",
                note: "Real building time, not the leftovers of the day.",
              },
              fitness: {
                title: "Fitness, muscle gain",
                hours: "4 lifts/week · 45 min · progressive overload",
                note: "Compound lifts, walks on off-days, recovery matters.",
              },
            }[cat];
            return (
              <div
                key={cat}
                className="lg-task rounded-xl p-4"
                style={categoryStyleFor(cat)}
              >
                <div className="text-[11px] uppercase tracking-wider opacity-70">
                  Goal {i + 1}
                </div>
                <h3 className="text-base font-semibold mt-1">
                  {linked?.title || fallback.title}
                </h3>
                <div className="text-xs opacity-75 mb-2">{fallback.hours}</div>
                <p className="text-sm leading-relaxed">
                  {linked?.description || fallback.note}
                </p>
                {linked?.targetDate && (
                  <div className="text-[11px] opacity-70 mt-2">
                    target {linked.targetDate}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2">Decision rules</h3>
        <div className="space-y-2">
          {bundle.rules.map((r) => (
            <div
              key={r._id}
              className="lg-card rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-4"
            >
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-1">
                  if
                </div>
                <p className="text-sm leading-relaxed">{r.ifText}</p>
              </div>
              <div>
                <div
                  className="text-[10px] uppercase tracking-widest mb-1"
                  style={{ color: "var(--plan-finals-ac)" }}
                >
                  then
                </div>
                <p className="text-sm leading-relaxed">{r.thenText}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section
        className="lg-task rounded-xl p-5"
        style={categoryStyleFor("rest")}
      >
        <h3 className="text-base font-semibold mb-2">Sick day rules</h3>
        <ul className="text-sm space-y-1 list-disc pl-5 leading-relaxed">
          <li>No targets. No study quota, no LNAT deadlines, no gym.</li>
          <li>Sleep is the work. Naps count.</li>
          <li>Hydrate, eat what feels good. Soup, fruit, electrolytes.</li>
          <li>Send one message to LNAT co-founder so nothing's blocked, then close Slack.</li>
          <li>
            Optional only: 30 min audiobook tied to finals, lying down. If that
            feels like effort, skip.
          </li>
          <li>Reset, don't catch up. Tomorrow resume normal plan. Don't double-stack.</li>
        </ul>
      </section>
    </div>
  );
}

// ──────────────── Edit view ────────────────

function EditView({ bundle, goals, mut }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Edit plan</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
          Tune the term, the schedules, lectures, rules, and goal links.
        </p>
      </header>
      <PlanSettingsCard bundle={bundle} mut={mut} />
      <GoalLinksCard bundle={bundle} goals={goals} mut={mut} />
      <SchedulesEditorCard bundle={bundle} mut={mut} />
      <LecturesEditorCard bundle={bundle} mut={mut} />
      <RulesEditorCard bundle={bundle} mut={mut} />
    </div>
  );
}

function PlanSettingsCard({ bundle, mut }) {
  const plan = bundle.plan;
  const [name, setName] = useState(plan.name);
  const [startDate, setStartDate] = useState(plan.startDate);
  const [weekCount, setWeekCount] = useState(plan.weekCount);
  const [phaseShift, setPhaseShift] = useState(plan.phaseShiftWeek ?? "");
  const [examWeek, setExamWeek] = useState(plan.examWeek ?? "");

  useEffect(() => {
    setName(plan.name);
    setStartDate(plan.startDate);
    setWeekCount(plan.weekCount);
    setPhaseShift(plan.phaseShiftWeek ?? "");
    setExamWeek(plan.examWeek ?? "");
  }, [plan]);

  const save = () => {
    mut.updatePlan({
      id: plan._id,
      name,
      startDate,
      weekCount: Number(weekCount) || plan.weekCount,
      phaseShiftWeek: phaseShift === "" ? undefined : Number(phaseShift),
      examWeek: examWeek === "" ? undefined : Number(examWeek),
    });
  };

  return (
    <section className="lg-card rounded-xl p-5">
      <h3 className="text-sm font-semibold mb-3">Term settings</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm"
          />
        </Field>
        <Field label="Start date (Monday)">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full px-3 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm"
          />
        </Field>
        <Field label="Number of weeks">
          <input
            type="number"
            min="1"
            max="52"
            value={weekCount}
            onChange={(e) => setWeekCount(e.target.value)}
            className="w-full px-3 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm"
          />
        </Field>
        <Field label="Phase shift week">
          <input
            type="number"
            min="1"
            value={phaseShift}
            onChange={(e) => setPhaseShift(e.target.value)}
            placeholder="auto (mid-term)"
            className="w-full px-3 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm"
          />
        </Field>
        <Field label="Exam week (optional)">
          <input
            type="number"
            min="1"
            value={examWeek}
            onChange={(e) => setExamWeek(e.target.value)}
            placeholder="—"
            className="w-full px-3 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm"
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={save}
          className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          Save
        </button>
      </div>
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

function GoalLinksCard({ bundle, goals, mut }) {
  const goalLinks = bundle.plan.goalLinks || {};
  const linkable = CATEGORIES.filter((c) => c.goalCategory);
  return (
    <section className="lg-card rounded-xl p-5">
      <h3 className="text-sm font-semibold mb-1">Linked goals</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
        Tie a category to one of your goals. The linked goal shows up on Term
        and Rules views, and a completed Finals block will encourage progress
        on its goal.
      </p>
      <div className="space-y-2">
        {linkable.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3"
            style={categoryStyleFor(c.id)}
          >
            <div
              className="w-24 px-2.5 py-1.5 rounded-md text-[12px] font-medium"
              style={categoryStyleFor(c.id)}
            >
              {c.label}
            </div>
            <select
              value={goalLinks[c.id] || ""}
              onChange={(e) =>
                mut.setGoalLink({
                  id: bundle.plan._id,
                  category: c.id,
                  goalId: e.target.value || undefined,
                })
              }
              className="flex-1 px-2.5 py-1.5 rounded-md bg-white/60 dark:bg-neutral-900/60 border border-black/10 dark:border-white/10 text-sm text-neutral-900 dark:text-neutral-100"
            >
              <option value="">— not linked —</option>
              {(goals || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

function SchedulesEditorCard({ bundle, mut }) {
  const COMBOS = [
    { energy: "high", phase: "essay", label: "High energy · Essay phase" },
    { energy: "high", phase: "revision", label: "High energy · Revision phase" },
    { energy: "low", phase: "", label: "Low energy" },
    { energy: "moderate", phase: "", label: "Moderate (mildly ill)" },
  ];
  const [confirming, setConfirming] = useState(false);
  const onReset = async () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setConfirming(false);
    await mut.resetDefaults({ planId: bundle.plan._id });
  };
  return (
    <section className="lg-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Schedule templates</h3>
        <button
          onClick={onReset}
          className={[
            "text-xs px-2.5 py-1 rounded-md transition-colors",
            confirming
              ? "bg-rose-600 text-white hover:bg-rose-700"
              : "text-neutral-600 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5",
          ].join(" ")}
          title="Replaces every schedule + lecture with the canonical defaults. Tracking, energy choices, rules, and goal links are preserved."
        >
          {confirming ? "Confirm reset" : "Reset to defaults"}
        </button>
      </div>
      <div className="space-y-2">
        {COMBOS.map((cb) => {
          const sched = bundle.schedules.find(
            (s) => s.energy === cb.energy && s.phase === cb.phase
          );
          return (
            <ScheduleEditor
              key={`${cb.energy}-${cb.phase}`}
              label={cb.label}
              energy={cb.energy}
              phase={cb.phase}
              blocks={sched?.blocks || []}
              onSave={(blocks) =>
                mut.upsertSchedule({
                  planId: bundle.plan._id,
                  energy: cb.energy,
                  phase: cb.phase,
                  blocks,
                })
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function ScheduleEditor({ label, blocks: initialBlocks, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialBlocks);
  useEffect(() => setDraft(initialBlocks), [initialBlocks]);

  const update = (i, key, val) => {
    setDraft((d) =>
      d.map((b, j) => (j === i ? { ...b, [key]: val } : b))
    );
  };
  const add = () => {
    setDraft((d) => [
      ...d,
      { s: "08:00", e: "09:00", t: "New block", c: "rest", d: "60m" },
    ]);
  };
  const remove = (i) => {
    setDraft((d) => d.filter((_, j) => j !== i));
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialBlocks);

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {draft.length} block{draft.length === 1 ? "" : "s"}
          <Icon
            icon={open ? "solar:alt-arrow-up-linear" : "solar:alt-arrow-down-linear"}
            className="inline ml-1.5 w-3.5 h-3.5"
          />
        </span>
      </button>
      {open && (
        <div className="p-3 space-y-1.5 bg-black/[0.02] dark:bg-white/[0.02]">
          {draft.map((b, i) => (
            <div
              key={i}
              className="grid items-center gap-2"
              style={{
                gridTemplateColumns: "60px 60px 1fr 100px 60px 28px",
              }}
            >
              <input
                type="time"
                value={b.s}
                onChange={(e) => update(i, "s", e.target.value)}
                className="px-1.5 py-1 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-xs"
              />
              <input
                type="time"
                value={b.e}
                onChange={(e) => update(i, "e", e.target.value)}
                className="px-1.5 py-1 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-xs"
              />
              <input
                value={b.t}
                onChange={(e) => update(i, "t", e.target.value)}
                placeholder="Block title"
                className="px-2 py-1 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-xs"
              />
              <select
                value={b.c}
                onChange={(e) => update(i, "c", e.target.value)}
                className="px-1.5 py-1 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-xs"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                value={b.d}
                onChange={(e) => update(i, "d", e.target.value)}
                placeholder="60m"
                className="px-1.5 py-1 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-xs"
              />
              <button
                type="button"
                className="text-neutral-500 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400"
                onClick={() => remove(i)}
                aria-label="Remove block"
              >
                <Icon icon="solar:trash-bin-trash-bold-duotone" className="w-4 h-4" />
              </button>
            </div>
          ))}
          <div className="flex justify-between mt-3">
            <button
              type="button"
              onClick={add}
              className="lg-add rounded-md px-3 py-1.5 text-xs"
            >
              + Add block
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              disabled={!dirty}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-40"
            >
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LecturesEditorCard({ bundle, mut }) {
  return (
    <section className="lg-card rounded-xl p-5">
      <h3 className="text-sm font-semibold mb-3">Recurring lectures</h3>
      <div className="space-y-2">
        {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
          const lec = bundle.lectures.find((l) => l.dow === dow);
          return (
            <ScheduleEditor
              key={dow}
              label={DAY_FULL[dow]}
              energy="lecture"
              phase=""
              blocks={lec?.blocks || []}
              onSave={(blocks) =>
                mut.upsertLectures({
                  planId: bundle.plan._id,
                  dow,
                  blocks,
                })
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function RulesEditorCard({ bundle, mut }) {
  const [adding, setAdding] = useState(false);
  const [ifT, setIfT] = useState("");
  const [thenT, setThenT] = useState("");
  const submitNew = () => {
    if (!ifT.trim() || !thenT.trim()) return;
    mut.addRule({
      planId: bundle.plan._id,
      ifText: ifT.trim(),
      thenText: thenT.trim(),
    });
    setIfT("");
    setThenT("");
    setAdding(false);
  };
  return (
    <section className="lg-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Decision rules</h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-blue-600 hover:underline"
        >
          {adding ? "Cancel" : "+ Add rule"}
        </button>
      </div>
      {adding && (
        <div className="lg-task rounded-lg p-3 mb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
              if
            </div>
            <textarea
              rows={2}
              value={ifT}
              onChange={(e) => setIfT(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-sm"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
              then
            </div>
            <textarea
              rows={2}
              value={thenT}
              onChange={(e) => setThenT(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-sm"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              onClick={submitNew}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs"
            >
              Add rule
            </button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {bundle.rules.map((r) => (
          <RuleRow key={r._id} rule={r} mut={mut} />
        ))}
      </div>
    </section>
  );
}

function RuleRow({ rule, mut }) {
  const [editing, setEditing] = useState(false);
  const [ifT, setIfT] = useState(rule.ifText);
  const [thenT, setThenT] = useState(rule.thenText);
  useEffect(() => {
    setIfT(rule.ifText);
    setThenT(rule.thenText);
  }, [rule.ifText, rule.thenText]);
  const save = () => {
    mut.updateRule({ id: rule._id, ifText: ifT, thenText: thenT });
    setEditing(false);
  };
  return (
    <div className="lg-task rounded-lg p-3 grid grid-cols-1 sm:grid-cols-[1fr,1fr,auto] gap-3 items-center">
      {editing ? (
        <>
          <textarea
            rows={2}
            value={ifT}
            onChange={(e) => setIfT(e.target.value)}
            className="px-2 py-1.5 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-sm"
          />
          <textarea
            rows={2}
            value={thenT}
            onChange={(e) => setThenT(e.target.value)}
            className="px-2 py-1.5 rounded bg-white/70 dark:bg-neutral-900/70 border border-black/10 dark:border-white/10 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-2.5 py-1 rounded-md text-xs text-neutral-600 dark:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
              if
            </div>
            <p className="text-sm leading-relaxed">{rule.ifText}</p>
          </div>
          <div>
            <div
              className="text-[10px] uppercase tracking-widest mb-1"
              style={{ color: "var(--plan-finals-ac)" }}
            >
              then
            </div>
            <p className="text-sm leading-relaxed">{rule.thenText}</p>
          </div>
          <div className="flex gap-2 self-start">
            <button
              onClick={() => setEditing(true)}
              className="px-2 py-1 rounded text-xs text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
              aria-label="Edit"
            >
              <Icon icon="solar:pen-linear" className="w-4 h-4" />
            </button>
            <button
              onClick={() => mut.deleteRule({ id: rule._id })}
              className="px-2 py-1 rounded text-xs text-neutral-500 hover:text-rose-600 dark:hover:text-rose-400"
              aria-label="Delete"
            >
              <Icon icon="solar:trash-bin-trash-linear" className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────── Top-level PlanView ────────────────

export default function PlanView({ planSubView, setPlanSubView, bundle, goals }) {
  // Mutations bundled into a single `mut` object so children don't each take
  // their own props for every server call.
  const mUpdatePlan = useMutation(api.plans.updatePlan);
  const mSetGoalLink = useMutation(api.plans.setGoalLink);
  const mUpsertSchedule = useMutation(api.plans.upsertSchedule);
  const mUpsertLectures = useMutation(api.plans.upsertLectures);
  const mSetDayEnergy = useMutation(api.plans.setDayEnergy);
  const mSetTracking = useMutation(api.plans.setTracking);
  const mAddRule = useMutation(api.plans.addRule);
  const mUpdateRule = useMutation(api.plans.updateRule);
  const mDeleteRule = useMutation(api.plans.deleteRule);
  const mResetDefaults = useMutation(api.plans.resetTrinityDefaults);

  const mut = useMemo(
    () => ({
      updatePlan: (a) => mUpdatePlan(a),
      setGoalLink: (a) => mSetGoalLink(a),
      upsertSchedule: (a) => mUpsertSchedule(a),
      upsertLectures: (a) => mUpsertLectures(a),
      setDayEnergy: (a) => mSetDayEnergy(a),
      setTracking: (a) => mSetTracking(a),
      addRule: (a) => mAddRule(a),
      updateRule: (a) => mUpdateRule(a),
      deleteRule: (a) => mDeleteRule(a),
      resetDefaults: (a) => mResetDefaults(a),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Re-render tick — drives the now-line and now-card every minute.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  const todayDate = useMemo(() => new Date(), [tick]);
  const nowMin = todayDate.getHours() * 60 + todayDate.getMinutes();

  // Pop the energy picker if today doesn't have a row yet.
  const todayIso = isoDate(todayDate);
  const todayRow = bundle.days.find((d) => d.date === todayIso);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerSeenRef = useRef(false);
  useEffect(() => {
    if (pickerSeenRef.current) return;
    if (!bundle?.days) return;
    pickerSeenRef.current = true;
    // Sundays are always moderate by default — the picker's contribution
    // would just be a confirmation click. Skip it.
    if (todayDate.getDay() === 0) return;
    if (!todayRow) {
      // Brief delay so the page paints first.
      const id = setTimeout(() => setPickerOpen(true), 250);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.days?.length]);

  // Tracking modal state.
  const [trackingModal, setTrackingModal] = useState(null);
  const trackingByDate = useMemo(
    () => indexTracking(bundle.tracking),
    [bundle.tracking]
  );
  const openTracking = (ev, dateIso) => {
    const cur = trackingByDate.get(dateIso)?.get(blockKey(ev));
    setTrackingModal({
      ev,
      dateIso,
      currentStatus: cur?.status || null,
    });
  };

  return (
    <div className="space-y-6">
      <PlanTabs current={planSubView} onChange={setPlanSubView} planName={bundle.plan.name} />

      {planSubView === "today" && (
        <TodayView
          bundle={bundle}
          goals={goals}
          todayDate={todayDate}
          nowMin={nowMin}
          openTracking={openTracking}
          mut={mut}
        />
      )}
      {planSubView === "week" && (
        <WeekView
          bundle={bundle}
          todayDate={todayDate}
          nowMin={nowMin}
          openTracking={openTracking}
        />
      )}
      {planSubView === "term" && (
        <TermView bundle={bundle} todayDate={todayDate} goals={goals} />
      )}
      {planSubView === "stats" && <StatsView bundle={bundle} />}
      {planSubView === "rules" && (
        <RulesView bundle={bundle} goals={goals} />
      )}
      {planSubView === "edit" && (
        <EditView bundle={bundle} goals={goals} mut={mut} />
      )}

      <EnergyPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        suggestedId={defaultEnergyFor(bundle.plan, todayDate)}
        dayLabel={`${DAY_FULL[todayDate.getDay()]}, ${todayDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
        onPick={(id) => {
          mut.setDayEnergy({
            planId: bundle.plan._id,
            date: todayIso,
            energy: id,
          });
          setPickerOpen(false);
        }}
      />

      <TrackingModal
        open={!!trackingModal}
        ev={trackingModal?.ev}
        dateIso={trackingModal?.dateIso}
        currentStatus={trackingModal?.currentStatus}
        onClose={() => setTrackingModal(null)}
        onSet={(status) => {
          if (!trackingModal) return;
          const ev = trackingModal.ev;
          mut.setTracking({
            planId: bundle.plan._id,
            date: trackingModal.dateIso,
            blockKey: blockKey(ev),
            blockTitle: ev.t,
            category: ev.c,
            status,
          });
          setTrackingModal(null);
        }}
      />
    </div>
  );
}

function PlanTabs({ current, onChange, planName }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mr-3">
        {planName}
      </div>
      {TABS.map((t) => {
        const on = t.id === current;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={[
              "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] transition-all",
              on
                ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900 shadow-sm"
                : "lg-task text-neutral-700 dark:text-neutral-300",
            ].join(" ")}
          >
            <Icon icon={t.icon} className="w-3.5 h-3.5" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
