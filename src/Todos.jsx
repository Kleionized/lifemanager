import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  DAYS,
  VALID_DAY_KEYS,
  DAY_KEY_BY_GETDAY,
  dayOffsetFromMonday,
  mondayOf,
  isoDate,
  parseISO,
  addDays,
  daysBetween,
  weeksFromTo,
  todayKey,
  thisWeekDates,
  formatLongDate,
  formatShortDate,
  formatTimeRemaining,
  timeRemainingTone,
} from "./dates.js";
import { useDataLayer } from "./dataLayer.js";
import PlanView from "./PlanView.jsx";

const solar = (name) => (props) =>
  <Icon icon={`solar:${name}-bold-duotone`} {...props} />;

const Sun = solar("sun");
const Moon = solar("moon");
const CalendarDays = ({ className = "", ...rest }) => (
  <Icon
    icon="solar:calendar-mark-bold-duotone"
    className={`calendar-icon ${className}`}
    {...rest}
  />
);
const Target = solar("target");
const Plus = solar("add-circle");
const Trash2 = solar("trash-bin-trash");
const ChartIcon = ({ className = "", ...rest }) => (
  <Icon
    icon="solar:layers-minimalistic-bold-duotone"
    className={className}
    {...rest}
  />
);
const GoalsIcon = ({ className = "", ...rest }) => (
  <Icon
    icon="solar:cup-star-bold-duotone"
    className={className}
    {...rest}
  />
);
const HabitIcon = ({ className = "", ...rest }) => (
  <Icon icon="solar:repeat-bold-duotone" className={className} {...rest} />
);
const SidebarIcon = (props) => (
  <Icon icon="solar:sidebar-minimalistic-linear" {...props} />
);
// Plan view's sidebar icon. Defined as a stable top-level constant
// so re-renders of <Sidebar> don't pass a *new* component reference
// each pass — that would unmount/remount the <Icon> and produce the
// brief icon flash the user saw on every parent render.
const PlanSidebarIcon = (props) => (
  <Icon icon="solar:notebook-bold-duotone" {...props} />
);

const STORAGE_KEY = "todos_v3";
const LEGACY_STORAGE_KEY = "todos_v2";
const LEGACY_V1_STORAGE_KEY = "todos_v1";
const THEME_KEY = "todos_v1_theme";
const VIEW_KEY = "todos_v1_view";
const SIDEBAR_KEY = "todos_v1_sidebar";
const WEEKLY_MODE_KEY = "todos_v1_weekly_mode";
const COLLAPSED_KEY = "todos_v1_collapsed";

const TYPE_STYLES = {
  project:
    "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60",
  goal:
    "bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-950/60 dark:text-violet-300 dark:hover:bg-violet-900/60",
};

const TYPE_DOT = {
  project: "bg-blue-500",
  goal: "bg-violet-500",
};

const TYPE_ICON_COLOR = {
  project: "text-blue-500 dark:text-blue-400",
  goal: "text-violet-500 dark:text-violet-400",
};

// Color tags for daily tasks. The hex is used inline for the row's
// left-edge accent (CSS-class-name approach doesn't work — Tailwind
// only generates classes it sees literally in source). Keep this
// list in sync with the picker UI in TaskRow.
const TASK_COLORS = [
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "emerald", label: "Green", hex: "#10b981" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "rose", label: "Rose", hex: "#f43f5e" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "teal", label: "Teal", hex: "#14b8a6" },
  { id: "slate", label: "Slate", hex: "#64748b" },
];
const TASK_COLOR_HEX = Object.fromEntries(
  TASK_COLORS.map((c) => [c.id, c.hex])
);

const PROJECT_ICONS = [
  "target",
  "rocket",
  "book-bookmark",
  "notes",
  "notebook",
  "document-text",
  "code-square",
  "code-2",
  "terminal",
  "palette",
  "paint-roller",
  "music-note",
  "music-notes",
  "headphones-round-sound",
  "heart",
  "heart-pulse",
  "dumbbells",
  "running-2",
  "basketball",
  "case-minimalistic",
  "case-round",
  "shop",
  "home-2",
  "buildings",
  "city",
  "chart-square",
  "graph-up",
  "pie-chart",
  "bell",
  "alarm",
  "star",
  "star-shine",
  "flag",
  "flag-2",
  "lightbulb",
  "lightbulb-bolt",
  "atom",
  "test-tube",
  "calculator",
  "chat-round-line",
  "users-group-rounded",
  "user-circle",
  "leaf",
  "cup-hot",
  "fork-spoon",
  "plate",
  "moon-stars",
  "sun-fog",
  "compass",
  "map",
  "map-point-wave",
  "wallet",
  "card",
  "dollar-minimalistic",
  "gift",
  "calendar",
  "calendar-mark",
  "clock-circle",
  "alarm-turn-off",
  "camera",
  "gallery",
  "video-library",
  "tv",
  "gamepad",
  "puzzle",
  "magic-stick",
  "crown",
  "medal-star",
  "cup-star",
  "shield-check",
  "lock-keyhole",
  "key",
  "tag",
  "bookmark",
];

const ProjectIconRender = ({ name, className }) => (
  <Icon
    icon={`solar:${name || "target"}-bold-duotone`}
    className={className}
  />
);

// Maps a project's "Week N" index to the current calendar week, defensively
// running mondayOf() in case startMonday isn't actually a Monday in storage.
// Only meaningful for legacy goal-shaped projects (weeks[]); new project shape
// keys tasks by absolute date.
function currentWeekIndexOf(project) {
  if (!project.startMonday) return -1;
  const start = mondayOf(parseISO(project.startMonday));
  const todayMon = mondayOf(new Date());
  return Math.round(
    (todayMon.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
}

function sameView(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "project") {
    return a.id === b.id && (a.week || null) === (b.week || null);
  }
  // Plan sub-tab switches re-use the same chrome — skip the 180ms fade.
  if (a.type === "plan") return true;
  return true;
}

function makeEmptyWeek() {
  return {
    id: crypto.randomUUID(),
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
}

function makeTask(title) {
  return {
    id: crypto.randomUUID(),
    title,
    done: false,
    createdAt: Date.now(),
  };
}

function makeProject(title, type) {
  const startMonday = isoDate(mondayOf(new Date()));
  if (type === "goal") {
    // Goals keep the legacy week-bucketed shape until they get their own
    // restructure. Projects get the new dated-tasks shape below.
    return {
      id: crypto.randomUUID(),
      title,
      type,
      createdAt: Date.now(),
      startMonday,
      icon: "flag",
      weeks: [makeEmptyWeek()],
    };
  }
  return {
    id: crypto.randomUUID(),
    title,
    type: "project",
    createdAt: Date.now(),
    startMonday,
    icon: "target",
    mainGoal: "",
    deadline: null,
    milestones: {}, // { [isoMonday]: text }
    tasks: [], // [{ id, title, done, createdAt, date, order, children? }]
  };
}

const DEFAULT_STATE = {
  daily: [],
  weekly: [],
  projects: [],
  goals: [],
  habits: [],
  habitCompletions: [],
};

const HABIT_CADENCE_KINDS = ["daily", "weekdays", "weekly_count"];
const GOAL_STATUSES = ["active", "paused", "done", "archived"];

function sanitizeTask(t) {
  if (!t || !t.id || typeof t.title !== "string") return null;
  const out = {
    id: t.id,
    title: t.title,
    done: !!t.done,
    createdAt: t.createdAt || Date.now(),
  };
  if (Array.isArray(t.children)) {
    const kids = t.children.map(sanitizeTask).filter(Boolean);
    if (kids.length) out.children = kids;
  }
  return out;
}

// Flatten a project's legacy `weeks[i][dayKey]: Task[]` shape into a flat
// `tasks: Task[]` with each task carrying an absolute `date` (ISO YYYY-MM-DD).
// Defensive: `startMonday` field name might lie, so re-anchor with mondayOf().
function flattenLegacyWeeksToDatedTasks(legacyWeeks, startMondayIso) {
  const tasks = [];
  if (!Array.isArray(legacyWeeks) || legacyWeeks.length === 0) return tasks;
  const startBase = parseISO(startMondayIso) || mondayOf(new Date());
  const start = mondayOf(startBase);
  legacyWeeks.forEach((w, weekIdx) => {
    if (!w) return;
    const weekStart = addDays(start, 7 * weekIdx);
    DAYS.forEach((d) => {
      const arr = Array.isArray(w[d.key]) ? w[d.key] : [];
      const date = isoDate(addDays(weekStart, dayOffsetFromMonday(d.key)));
      arr.forEach((raw, idx) => {
        const sanitized = sanitizeTask(raw);
        if (!sanitized) return;
        tasks.push({ ...sanitized, date, order: idx });
      });
    });
  });
  return tasks;
}

function sanitizeWeek(w) {
  const week = makeEmptyWeek();
  if (!w) return week;
  if (typeof w.id === "string") week.id = w.id;
  for (const d of DAYS) {
    if (Array.isArray(w[d.key])) {
      week[d.key] = w[d.key]
        .map(sanitizeTask)
        .filter(Boolean);
    }
  }
  return week;
}

function sanitizeGoals(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => {
      if (!g || !g.id || typeof g.title !== "string") return null;
      return {
        id: g.id,
        title: g.title,
        description: typeof g.description === "string" ? g.description : "",
        targetDate:
          typeof g.targetDate === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(g.targetDate)
            ? g.targetDate
            : null,
        status: GOAL_STATUSES.includes(g.status) ? g.status : "active",
        progress:
          typeof g.progress === "number" && g.progress >= 0 && g.progress <= 100
            ? g.progress
            : null,
        projectIds: Array.isArray(g.projectIds)
          ? g.projectIds.filter((id) => typeof id === "string")
          : [],
        createdAt: g.createdAt || Date.now(),
      };
    })
    .filter(Boolean);
}

function sanitizeHabit(h) {
  if (!h || !h.id || typeof h.title !== "string") return null;
  let cadence = h.cadence;
  if (!cadence || !HABIT_CADENCE_KINDS.includes(cadence.kind)) {
    cadence = { kind: "daily" };
  } else if (cadence.kind === "weekly_count") {
    const count = Number.isFinite(cadence.count)
      ? Math.max(1, Math.min(14, Math.floor(cadence.count)))
      : 3;
    cadence = { kind: "weekly_count", count };
  } else if (cadence.kind === "weekdays") {
    const days = Array.isArray(cadence.days)
      ? cadence.days.filter((d) => VALID_DAY_KEYS.has(d))
      : [];
    cadence = { kind: "weekdays", days: days.length ? days : ["mon"] };
  }
  return {
    id: h.id,
    title: h.title,
    createdAt: h.createdAt || Date.now(),
    cadence,
    autoGenerateTodo: !!h.autoGenerateTodo,
    linkedProjectId:
      typeof h.linkedProjectId === "string" ? h.linkedProjectId : null,
  };
}

function sanitizeHabitCompletion(c) {
  if (!c || !c.id || typeof c.habitId !== "string") return null;
  if (!c.date || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return null;
  return {
    id: c.id,
    habitId: c.habitId,
    date: c.date,
    sourceTodoId:
      typeof c.sourceTodoId === "string" ? c.sourceTodoId : null,
    createdAt: c.createdAt || Date.now(),
  };
}

function sanitizeMilestones(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    // Key must look like an ISO date; value must be a string.
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function migrate(parsed) {
  const old = parsed || {};
  const out = {
    daily: Array.isArray(old.daily) ? old.daily : [],
    weekly: Array.isArray(old.weekly) ? old.weekly : [],
    projects: Array.isArray(old.projects) ? old.projects : [],
    goals: sanitizeGoals(old.goals),
    habits: Array.isArray(old.habits)
      ? old.habits.map(sanitizeHabit).filter(Boolean)
      : [],
    habitCompletions: Array.isArray(old.habitCompletions)
      ? old.habitCompletions.map(sanitizeHabitCompletion).filter(Boolean)
      : [],
  };

  const fallback = todayKey();
  out.weekly = out.weekly.map((item) =>
    item && VALID_DAY_KEYS.has(item.day) ? item : { ...item, day: fallback }
  );

  // Legacy `longterm[]` (very old shape) → projects with one week of tasks.
  if (Array.isArray(old.longterm)) {
    for (const item of old.longterm) {
      if (!item || !item.id) continue;
      const week = makeEmptyWeek();
      if (Array.isArray(item.children)) {
        for (const child of item.children) {
          if (child && child.title) {
            week.mon.push({
              id: child.id || crypto.randomUUID(),
              title: child.title,
              done: !!child.done,
              createdAt: child.createdAt || Date.now(),
            });
          }
        }
      }
      out.projects.push({
        id: item.id,
        title: item.title || "",
        type: item.type === "goal" ? "goal" : "project",
        createdAt: item.createdAt || Date.now(),
        startMonday: isoDate(
          mondayOf(new Date(item.createdAt || Date.now()))
        ),
        icon: "target",
        weeks: [week],
      });
    }
  }

  out.projects = out.projects
    .map((p) => {
      if (!p || !p.id) return null;
      const type = p.type === "goal" ? "goal" : "project";
      const startMonday =
        typeof p.startMonday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.startMonday)
          ? p.startMonday
          : isoDate(mondayOf(new Date(p.createdAt || Date.now())));
      const icon =
        typeof p.icon === "string" && PROJECT_ICONS.includes(p.icon)
          ? p.icon
          : type === "goal"
          ? "flag"
          : "target";

      if (type === "goal") {
        // Goals keep the legacy week-bucketed shape (per restructure plan).
        const weeks =
          Array.isArray(p.weeks) && p.weeks.length > 0
            ? p.weeks.map(sanitizeWeek)
            : [makeEmptyWeek()];
        return {
          id: p.id,
          title: typeof p.title === "string" ? p.title : "",
          type: "goal",
          createdAt: p.createdAt || Date.now(),
          startMonday,
          icon,
          weeks,
        };
      }

      // Projects move to dated-tasks shape.
      let tasks;
      let legacyWeeks;
      if (Array.isArray(p.tasks)) {
        // Already on v2.
        tasks = p.tasks
          .map((t) => {
            const s = sanitizeTask(t);
            if (!s) return null;
            const date =
              typeof t.date === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(t.date)
                ? t.date
                : isoDate(mondayOf(new Date()));
            const order = Number.isFinite(t.order) ? t.order : 0;
            return { ...s, date, order };
          })
          .filter(Boolean);
        legacyWeeks = Array.isArray(p._legacyWeeks)
          ? p._legacyWeeks
          : null;
      } else {
        // v1 → v2: flatten weeks[] into dated tasks. Keep a legacy shadow
        // for one release as a safety net.
        tasks = flattenLegacyWeeksToDatedTasks(p.weeks, startMonday);
        legacyWeeks = Array.isArray(p.weeks) ? p.weeks : null;
      }

      const next = {
        id: p.id,
        title: typeof p.title === "string" ? p.title : "",
        type: "project",
        createdAt: p.createdAt || Date.now(),
        startMonday,
        icon,
        mainGoal: typeof p.mainGoal === "string" ? p.mainGoal : "",
        deadline:
          typeof p.deadline === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(p.deadline)
            ? p.deadline
            : null,
        milestones: sanitizeMilestones(p.milestones),
        tasks,
      };
      if (legacyWeeks) next._legacyWeeks = legacyWeeks;
      return next;
    })
    .filter(Boolean);

  return out;
}

function sortDoneToBottom(items) {
  return [...items].sort((a, b) => Number(a.done) - Number(b.done));
}

function countDirect(items) {
  let done = 0;
  for (const it of items) if (it.done) done += 1;
  return { done, total: items.length };
}

// Count leaf "step" units beneath a top-level task. A step with no
// sub-steps counts as 1; a step with sub-steps contributes its sub-step
// count. Tasks with zero direct children return total=0.
function countLeafSteps(task) {
  const steps = task.children || [];
  if (steps.length === 0) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  for (const s of steps) {
    const subs = s.children || [];
    if (subs.length === 0) {
      total += 1;
      if (s.done) done += 1;
    } else {
      for (const ss of subs) {
        total += 1;
        if (ss.done) done += 1;
      }
    }
  }
  return { done, total };
}

function countWeek(week) {
  let done = 0;
  let total = 0;
  for (const d of DAYS) {
    const arr = week[d.key] || [];
    total += arr.length;
    done += arr.filter((t) => t.done).length;
  }
  return { done, total };
}

// Recursive task count — leaves at every depth count.
function countTasksDeep(tasks) {
  let done = 0;
  let total = 0;
  for (const t of tasks || []) {
    total += 1;
    if (t.done) done += 1;
    if (t.children?.length) {
      const sub = countTasksDeep(t.children);
      done += sub.done;
      total += sub.total;
    }
  }
  return { done, total };
}

function countProject(project) {
  if (project.type === "project") {
    return countTasksDeep(project.tasks || []);
  }
  // Legacy goal shape (week-bucketed).
  let done = 0;
  let total = 0;
  for (const w of project.weeks || []) {
    const c = countWeek(w);
    done += c.done;
    total += c.total;
  }
  return { done, total };
}

function updateAtPath(items, path, updater) {
  if (path.length === 0) return items;
  const [head, ...rest] = path;
  return items.map((item) => {
    if (item.id !== head) return item;
    if (rest.length === 0) return updater(item);
    return {
      ...item,
      children: updateAtPath(item.children || [], rest, updater),
    };
  });
}

function removeAtPath(items, path) {
  if (path.length === 0) return items;
  const [head, ...rest] = path;
  if (rest.length === 0) return items.filter((item) => item.id !== head);
  return items.map((item) => {
    if (item.id !== head) return item;
    return { ...item, children: removeAtPath(item.children || [], rest) };
  });
}

function addChildAtPath(items, path, child) {
  if (path.length === 0) return [...items, child];
  const [head, ...rest] = path;
  return items.map((item) => {
    if (item.id !== head) return item;
    if (rest.length === 0) {
      return { ...item, children: [...(item.children || []), child] };
    }
    return {
      ...item,
      children: addChildAtPath(item.children || [], rest, child),
    };
  });
}

// Insert/remove a habitCompletion row to mirror a tagged task's done state.
// Idempotent: at most one row per (habitId, date, sourceTodoId) tuple.
// Used by every task toggle that touches a habit-tagged task — keeps virtual
// completions (sourceTodoId === null) untouched so a virtual row toggle and
// a tagged-task toggle on the same day don't fight each other.
function syncHabitCompletion(existing, habitId, date, sourceTodoId, willBeDone) {
  if (willBeDone) {
    const has = existing.some(
      (c) =>
        c.habitId === habitId &&
        c.date === date &&
        c.sourceTodoId === sourceTodoId
    );
    if (has) return existing;
    return [
      ...existing,
      {
        id: crypto.randomUUID(),
        habitId,
        date,
        sourceTodoId: sourceTodoId || null,
        createdAt: Date.now(),
      },
    ];
  }
  return existing.filter(
    (c) =>
      !(
        c.habitId === habitId &&
        c.date === date &&
        c.sourceTodoId === sourceTodoId
      )
  );
}

// Build virtual habit rows for a given date. `linkedProjectId` filters:
//   undefined → habits with no linkedProjectId (Today view)
//   string    → habits linked to that project (project Daily Calendar)
// Dedup: skip habits that already have a tagged real task in the same
// (date) bucket, identified by `existingTaggedTaskHabitIds` — the tagged
// task wins the visual slot.
//
// SAFETY: each returned row has id `habit:${habitId}:${dateIso}`. That id
// MUST stay in the render tree only — never written into project.tasks,
// state.daily, undo history, etc. The TaskRow `kind === "habit"` branch
// guards mutations.
function buildVirtualHabitRows(
  habits,
  completions,
  dateIso,
  linkedProjectId,
  existingTaggedTaskHabitIds,
  onToggleHabitVirtual
) {
  if (!habits?.length) return [];
  const date = parseISO(dateIso);
  if (!date) return [];
  const out = [];
  for (const h of habits) {
    if (linkedProjectId === undefined) {
      if (h.linkedProjectId) continue;
    } else if (h.linkedProjectId !== linkedProjectId) {
      continue;
    }
    if (!h.autoGenerateTodo) continue;
    if (!isExpectedOn(h, date)) continue;
    if (existingTaggedTaskHabitIds && existingTaggedTaskHabitIds.has(h.id))
      continue;
    const done = completions.some(
      (c) =>
        c.habitId === h.id &&
        c.date === dateIso &&
        // Either a virtual completion (sourceTodoId === null) or any
        // tagged-task completion on the same day counts as "done" for the
        // virtual row's display.
        true
    );
    out.push({
      id: `habit:${h.id}:${dateIso}`,
      kind: "habit",
      isVirtual: true,
      habitId: h.id,
      title: h.title,
      cadence: h.cadence,
      done,
      date: dateIso,
      onToggle: () => onToggleHabitVirtual(h.id, dateIso),
    });
  }
  return out;
}

// Collect habitIds tagged on real tasks for a given date, used to dedup
// virtual rows. `tasks` is an iterable of task-shaped objects.
function collectTaggedHabitIdsForDate(tasks, dateIso) {
  const ids = new Set();
  const walk = (arr) => {
    for (const t of arr || []) {
      if (t.habitId && t.date === dateIso) ids.add(t.habitId);
      if (t.children?.length) walk(t.children);
    }
  };
  walk(tasks);
  return ids;
}

// Walks a path-keyed tree and returns the matched node (or null).
// Mirrors updateAtPath/removeAtPath/addChildAtPath traversal so we can
// read a task before mutating it (needed for habit-tag side effects on
// toggle: we have to know if the task has a habitId before we flip done).
function findAtPath(items, path) {
  if (!path || path.length === 0) return null;
  const [head, ...rest] = path;
  for (const item of items) {
    if (item.id !== head) continue;
    if (rest.length === 0) return item;
    return findAtPath(item.children || [], rest);
  }
  return null;
}

function bindTask(task, parentPath, handlers) {
  const path = [...parentPath, task.id];
  return {
    ...task,
    onToggle: () => handlers.toggle(path),
    onUpdate: (title) => handlers.update(path, title),
    onDelete: () => handlers.delete(path),
    onAddChild: (title) => handlers.addChild(path, title),
    onAddSibling: () => handlers.addAt(parentPath),
    onSchedule: handlers.schedule
      ? (dateIso) => handlers.schedule(path, dateIso)
      : undefined,
    // moveTo + setColor are on every level — the reorderTo mutation
    // operates within the task's parentId group, so it works for top
    // level, steps, and sub-steps without extra wiring.
    onMoveTo: handlers.moveTo
      ? (targetIndex) => handlers.moveTo(task.id, targetIndex)
      : undefined,
    onSetColor: handlers.setColor
      ? (color) => handlers.setColor(task.id, color)
      : undefined,
    children: (task.children || []).map((c) => bindTask(c, path, handlers)),
  };
}

export default function Todos() {
  // Convex-backed data + mutators. The hook reconstructs the legacy
  // {daily, weekly, projects, goals, habits, habitCompletions} shape from
  // flat parentId rows so the rest of this file is unchanged.
  const data = useDataLayer();
  const { state, ready, ui: serverUi } = data;
  const {
    addDaily, addDailyChild, addAtDaily, toggleDaily, updateDaily, deleteDaily,
    reorderDailyTo, setDailyColor,
    addWeekly, addWeeklyChild, addAtWeekly, toggleWeekly, updateWeekly, deleteWeekly,
    reorderWeeklyTo, setWeeklyColor,
    addProject, deleteProject, updateProjectTitle, cycleProjectType, setProjectIcon,
    addWeek, deleteWeek, addProjectTask, addProjectTaskChild, addAtProjectTask,
    toggleProjectTask, updateProjectTaskTitle, deleteProjectTask,
    setProjectMainGoal, setProjectDeadline, setProjectMilestone,
    addProjectDatedTask, addProjectDatedTaskChild, addAtProjectDatedTask,
    toggleProjectDatedTask, updateProjectDatedTaskTitle, deleteProjectDatedTask,
    setProjectTaskDate, reorderProjectDatedTask,
    addGoal, updateGoal, setGoalStatus, setGoalProgress,
    linkGoalToProject, unlinkGoalFromProject, deleteGoal,
    addHabit, updateHabit, setHabitCadence, setHabitLinkedProject,
    setHabitAutoGenerate, deleteHabit,
    addHabitCompletion, removeHabitCompletion, toggleHabitVirtual,
    setTaskHabitTag, importV3, popUndo,
    plansList, activePlan, planBundle, ensureTrinitySeed,
  } = data;

  const [view, setView] = useState({ type: "daily" });
  const [displayView, setDisplayView] = useState({ type: "daily" });
  const [fading, setFading] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  const showConfirm = (opts) => setConfirmState(opts);
  const [theme, setTheme] = useState("light");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [weeklyMode, setWeeklyMode] = useState("grid");
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Track the most recently edited top-level task id and step id
  // (depth 1) so Cmd+2 / Cmd+3 know where to append.
  const lastTaskIdRef = useRef(null);
  const lastStepIdRef = useRef(null);
  const [migrationStatus, setMigrationStatus] = useState(null);

  const dailyAddRef = useRef(null);
  const weeklyDayRefs = useRef({});
  const projectAddRefs = useRef({});
  const migrationRunRef = useRef(false);
  const planSeedRef = useRef(false);
  // First time the server `ui` row arrives, pull theme/view/etc. from it
  // so a second device sees the same prefs. Subsequent server updates are
  // ignored to avoid fighting with rapid local edits.
  const uiPulledRef = useRef(false);

  const weeklyDayRefSetters = useMemo(() => {
    const m = {};
    for (const d of DAYS) {
      m[d.key] = (el) => {
        if (el) weeklyDayRefs.current[d.key] = el;
      };
    }
    return m;
  }, []);

  const projectAddRefSetter = (key) => (el) => {
    if (el) projectAddRefs.current[key] = el;
  };

  useEffect(() => {
    // v3 state lives in Convex now. UI prefs (theme/view/sidebar/...) stay
    // in localStorage for instant first-paint without a network round trip.
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "dark" || t === "light") setTheme(t);
      else if (
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        setTheme("dark");
      }
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (
          v &&
          (v.type === "daily" ||
            v.type === "weekly" ||
            v.type === "overview" ||
            v.type === "goalspage" ||
            v.type === "plan" ||
            (v.type === "project" && typeof v.id === "string"))
        ) {
          setView(v);
        }
      }
    } catch {
      // ignore
    }
    try {
      const v = localStorage.getItem(SIDEBAR_KEY);
      if (v === "false") setSidebarOpen(false);
    } catch {
      // ignore
    }
    try {
      const m = localStorage.getItem(WEEKLY_MODE_KEY);
      if (m === "grid" || m === "list") setWeeklyMode(m);
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setCollapsedIds(new Set(arr));
      }
    } catch {
      // ignore
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // ignore
    }
  }, [view, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // ignore
    }
  }, [sidebarOpen, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(WEEKLY_MODE_KEY, weeklyMode);
    } catch {
      // ignore
    }
  }, [weeklyMode, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedIds]));
    } catch {
      // ignore
    }
  }, [collapsedIds, loaded]);

  const toggleCollapsed = (id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandId = (id) => {
    setCollapsedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  useEffect(() => {
    if (!loaded) return;
    if (view.type === "project") {
      const exists = state.projects.some((p) => p.id === view.id);
      if (!exists) setView({ type: "daily" });
    }
  }, [state.projects, view, loaded]);

  useEffect(() => {
    if (sameView(view, displayView)) return;
    // Swap views instantly. The 180ms cross-fade was responsible for
    // the perceived "flash" when navigating to Plan, which has more
    // visually-distinct content than the task views.
    setDisplayView(view);
    setFading(false);
  }, [view, displayView]);

  // First-load: hydrate local UI state from the server `ui` row. The
  // localStorage values were used for instant first-paint; once Convex
  // responds we adopt the cross-device value so opening the app on a new
  // device doesn't lose your last theme/view choice.
  useEffect(() => {
    if (uiPulledRef.current) return;
    if (!serverUi || serverUi._id === undefined) {
      // Either still loading, or the row doesn't exist yet (defaults).
      if (serverUi && serverUi._id === undefined) {
        // We have defaults, mark pulled so we start mirroring.
        uiPulledRef.current = true;
      }
      return;
    }
    uiPulledRef.current = true;
    if (
      serverUi.theme === "dark" ||
      serverUi.theme === "light"
    ) {
      setTheme(serverUi.theme);
    }
    if (typeof serverUi.sidebarOpen === "boolean") {
      setSidebarOpen(serverUi.sidebarOpen);
    }
    if (
      serverUi.weeklyMode === "grid" ||
      serverUi.weeklyMode === "list"
    ) {
      setWeeklyMode(serverUi.weeklyMode);
    }
    if (serverUi.view && typeof serverUi.view === "object") {
      setView(serverUi.view);
    }
  }, [serverUi]);

  // Write-through: mirror local pref changes to the server. Only fires
  // after `loaded` (so we don't clobber the server with the localStorage
  // bootstrap values) and after `uiPulledRef` (so we don't clobber the
  // server with values that haven't been reconciled with it yet).
  useEffect(() => {
    if (!loaded || !uiPulledRef.current) return;
    data.setTheme(theme);
  }, [theme, loaded]);
  useEffect(() => {
    if (!loaded || !uiPulledRef.current) return;
    data.setSidebarOpen(sidebarOpen);
  }, [sidebarOpen, loaded]);
  useEffect(() => {
    if (!loaded || !uiPulledRef.current) return;
    data.setWeeklyMode(weeklyMode);
  }, [weeklyMode, loaded]);
  useEffect(() => {
    if (!loaded || !uiPulledRef.current) return;
    data.setView(view);
  }, [view, loaded]);

  // ⌘Z routes through the server: every state-mutating mutation also writes
  // an inverse-op row in `undo_log`, and api.undo.pop replays the latest
  // inverse atomically.
  useEffect(() => {
    const handler = (e) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        const tag = e.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        popUndo({});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [popUndo]);

  // One-time migration of localStorage v3 → Convex. Runs once after the
  // user is signed in and Convex queries have loaded. If the import says
  // it's a no-op (server already has data), we still wipe v3 locally so
  // the next session doesn't try again.
  // First-time plan setup: if the user has no plan, seed the Trinity-term
  // defaults from the original life-plan HTML. Idempotent — the mutation
  // bails if a plan already exists.
  useEffect(() => {
    if (!ready) return;
    if (plansList === null) return;
    if (planSeedRef.current) return;
    if (plansList && plansList.length === 0) {
      planSeedRef.current = true;
      ensureTrinitySeed();
    } else if (plansList && plansList.length > 0) {
      planSeedRef.current = true;
    }
  }, [ready, plansList, ensureTrinitySeed]);

  useEffect(() => {
    if (!ready) return;
    if (migrationRunRef.current) return;
    migrationRunRef.current = true;
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_V1_STORAGE_KEY);
      if (!raw) return;
      const payload = migrate(JSON.parse(raw));
      importV3({ payload }).then((res) => {
        setMigrationStatus(res);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }, [ready, importV3]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (displayView.type === "daily") dailyAddRef.current?.focus();
        else if (displayView.type === "weekly")
          weeklyDayRefs.current[todayKey()]?.focus();
        else if (displayView.type === "project") {
          const project = state.projects.find((p) => p.id === displayView.id);
          if (!project) return;
          if (project.type === "goal") {
            const week = project.weeks?.[0];
            if (!week) return;
            const k = `${displayView.id}:${week.id}:${todayKey()}`;
            projectAddRefs.current[k]?.focus();
            return;
          }
          // type === "project"
          if (displayView.week) {
            // L2: focus today's day if it falls in this week, else the
            // week's Monday.
            const weekStart = parseISO(displayView.week);
            if (!weekStart) return;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const offset = daysBetween(weekStart, today);
            const targetDate =
              offset >= 0 && offset < 7 ? today : weekStart;
            const k = `${displayView.id}:${isoDate(targetDate)}`;
            projectAddRefs.current[k]?.focus();
            return;
          }
          // L1: focus backlog input.
          const k = `${displayView.id}:backlog`;
          projectAddRefs.current[k]?.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [displayView, state.projects]);


  // ===== Computed =====

  const weekDates = useMemo(() => thisWeekDates(), []);
  const todayK = useMemo(() => todayKey(), []);

  const dailyHandlers = {
    toggle: toggleDaily,
    update: updateDaily,
    delete: deleteDaily,
    addChild: addDailyChild,
    addAt: addAtDaily,
    moveTo: reorderDailyTo,
    setColor: setDailyColor,
  };

  // When the editing target changes, snapshot the most-recently-edited
  // task / step IDs so the Cmd+2 / Cmd+3 hotkeys know where to append.
  useEffect(() => {
    if (!editingId) return;
    for (const t of state.daily) {
      if (t.id === editingId) {
        lastTaskIdRef.current = t.id;
        return;
      }
      for (const s of t.children || []) {
        if (s.id === editingId) {
          lastTaskIdRef.current = t.id;
          lastStepIdRef.current = s.id;
          return;
        }
      }
    }
  }, [editingId, state.daily]);

  // Cmd/Ctrl + H/J/K hotkeys for adding tasks/steps/sub-steps with
  // immediate edit-mode focus. Active only on the Today view. We
  // route the focus through `pendingEditId` so the input mounts and
  // grabs focus once the new row appears in local state — Convex's
  // query update may land a frame later than the mutation resolution.
  useEffect(() => {
    const handler = async (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (view.type !== "daily") return;
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const key = e.key;
      if (key === "[") {
        e.preventDefault();
        const newId = await addAtDaily([]);
        if (newId) setEditingId(newId);
      } else if (key === "]") {
        const taskId = lastTaskIdRef.current;
        if (!taskId) return;
        e.preventDefault();
        const newId = await addAtDaily([taskId]);
        if (newId) setEditingId(newId);
      } else if (key === "\\") {
        const taskId = lastTaskIdRef.current;
        const stepId = lastStepIdRef.current;
        if (!taskId || !stepId) return;
        e.preventDefault();
        const newId = await addAtDaily([taskId, stepId]);
        if (newId) setEditingId(newId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, addAtDaily]);
  const weeklyHandlersFor = (day) => ({
    toggle: toggleWeekly,
    update: updateWeekly,
    delete: deleteWeekly,
    addChild: addWeeklyChild,
    addAt: (parentPath) => addAtWeekly(parentPath, day),
    moveTo: reorderWeeklyTo,
    setColor: setWeeklyColor,
  });
  // Legacy goal handlers — week-bucketed shape.
  const projectHandlersFor = (projectId, weekId, day) => ({
    toggle: (path) => toggleProjectTask(projectId, weekId, day, path),
    update: (path, title) =>
      updateProjectTaskTitle(projectId, weekId, day, path, title),
    delete: (path) => deleteProjectTask(projectId, weekId, day, path),
    addChild: (path, title) =>
      addProjectTaskChild(projectId, weekId, day, path, title),
    addAt: (parentPath) =>
      addAtProjectTask(projectId, weekId, day, parentPath),
  });
  // New project handlers — flat dated tasks. `dateForRoot` is the date a
  // new top-level sibling should land on (Enter→sibling at depth 0).
  const projectDatedHandlersFor = (projectId, dateForRoot) => ({
    toggle: (path) => toggleProjectDatedTask(projectId, path),
    update: (path, title) =>
      updateProjectDatedTaskTitle(projectId, path, title),
    delete: (path) => deleteProjectDatedTask(projectId, path),
    addChild: (parentPath, title) =>
      addProjectDatedTaskChild(projectId, parentPath, title),
    addAt: (parentPath) =>
      addAtProjectDatedTask(projectId, parentPath, dateForRoot),
    // Backlog tasks (dateForRoot === null) get a schedule handler instead of
    // reorder; dated tasks get reorder (swap among same-day siblings).
    reorder:
      dateForRoot !== null
        ? (path, dir) => reorderProjectDatedTask(projectId, path, dir)
        : undefined,
    schedule:
      dateForRoot === null
        ? (path, dateIso) => setProjectTaskDate(projectId, path, dateIso)
        : undefined,
  });

  const todayItems = useMemo(() => {
    const items = [];
    for (const t of state.daily) items.push(bindTask(t, [], dailyHandlers));
    for (const t of state.weekly) {
      if (t.day === todayK)
        items.push(bindTask(t, [], weeklyHandlersFor(t.day)));
    }
    const todayIso = isoDate(new Date());
    for (const p of state.projects) {
      if (p.type === "project") {
        const datedTasks = (p.tasks || [])
          .filter((t) => t.date === todayIso)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const handlers = projectDatedHandlersFor(p.id, todayIso);
        for (const t of datedTasks) {
          items.push(bindTask(t, [], handlers));
        }
      } else {
        // Legacy goal shape.
        const wIdx = currentWeekIndexOf(p);
        if (wIdx < 0 || wIdx >= (p.weeks || []).length) continue;
        const week = p.weeks[wIdx];
        const handlers = projectHandlersFor(p.id, week.id, todayK);
        for (const t of week[todayK] || []) {
          items.push(bindTask(t, [], handlers));
        }
      }
    }
    // Tagged habits already credited via real tasks should hide their
    // virtual twin. Collect from every source contributing to today.
    const taggedHabitIds = new Set();
    for (const t of state.daily) if (t.habitId) taggedHabitIds.add(t.habitId);
    for (const t of state.weekly)
      if (t.day === todayK && t.habitId) taggedHabitIds.add(t.habitId);
    for (const p of state.projects) {
      if (p.type !== "project") continue;
      const taggedForToday = collectTaggedHabitIdsForDate(
        p.tasks || [],
        todayIso
      );
      for (const id of taggedForToday) taggedHabitIds.add(id);
    }
    const virtualRows = buildVirtualHabitRows(
      state.habits,
      state.habitCompletions,
      todayIso,
      undefined, // unlinked habits surface in Today
      taggedHabitIds,
      toggleHabitVirtual
    );
    return [...virtualRows, ...sortDoneToBottom(items)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.daily,
    state.weekly,
    state.projects,
    state.habits,
    state.habitCompletions,
    todayK,
  ]);

  const weeklyItemsByDay = useMemo(() => {
    const groups = {};
    for (const d of DAYS) groups[d.key] = [];
    for (const t of state.weekly) {
      const d = VALID_DAY_KEYS.has(t.day) ? t.day : todayK;
      groups[d].push(bindTask(t, [], weeklyHandlersFor(d)));
    }
    const thisMon = mondayOf(new Date());
    for (const p of state.projects) {
      if (p.type === "project") {
        for (const d of DAYS) {
          const dateForDay = isoDate(addDays(thisMon, dayOffsetFromMonday(d.key)));
          const datedTasks = (p.tasks || [])
            .filter((t) => t.date === dateForDay)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const handlers = projectDatedHandlersFor(p.id, dateForDay);
          for (const t of datedTasks) {
            groups[d.key].push(bindTask(t, [], handlers));
          }
        }
      } else {
        // Legacy goal shape.
        const wIdx = currentWeekIndexOf(p);
        if (wIdx < 0 || wIdx >= (p.weeks || []).length) continue;
        const week = p.weeks[wIdx];
        for (const d of DAYS) {
          const handlers = projectHandlersFor(p.id, week.id, d.key);
          for (const t of week[d.key] || []) {
            groups[d.key].push(bindTask(t, [], handlers));
          }
        }
      }
    }
    for (const t of state.daily) {
      groups[todayK].push(bindTask(t, [], dailyHandlers));
    }
    for (const k of Object.keys(groups)) {
      groups[k] = sortDoneToBottom(groups[k]);
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.daily, state.weekly, state.projects, todayK]);

  const todayProgress = useMemo(
    () => countDirect(todayItems),
    [todayItems]
  );
  const weeklyProgress = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const k of Object.keys(weeklyItemsByDay)) {
      total += weeklyItemsByDay[k].length;
      done += weeklyItemsByDay[k].filter((t) => t.done).length;
    }
    return { done, total };
  }, [weeklyItemsByDay]);

  const projects = state.projects.filter((p) => p.type === "project");
  const goals = state.projects.filter((p) => p.type === "goal");

  const currentProject =
    displayView.type === "project"
      ? state.projects.find((p) => p.id === displayView.id) || null
      : null;

  return (
    <div className={theme}>
      <div className="app-texture h-screen flex overflow-hidden bg-neutral-50 dark:bg-neutral-950 font-sans text-neutral-900 dark:text-neutral-100 antialiased transition-colors duration-150">
        <Sidebar
          open={sidebarOpen}
          onCollapse={() => setSidebarOpen(false)}
          view={view}
          setView={setView}
          projects={projects}
          goals={goals}
          theme={theme}
          setTheme={setTheme}
          onAddProject={() => addProject("project")}
          onAddGoal={() => addProject("goal")}
        />

        <main className="flex-1 min-w-0 h-full overflow-auto relative">
          <button
            onClick={() => setSidebarOpen(true)}
            className={[
              "absolute top-6 left-6 z-10 p-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-100 transition-opacity duration-200 ease-out",
              sidebarOpen ? "opacity-0 pointer-events-none" : "opacity-100",
            ].join(" ")}
            aria-label="Expand sidebar"
          >
            <SidebarIcon className="w-5 h-5" />
          </button>
          <div
            className={[
              "py-10 pr-10 transition-[padding] duration-300 ease-out",
              sidebarOpen ? "pl-10" : "pl-20",
            ].join(" ")}
          >
            <div
              className={[
                "transition-opacity duration-200 ease-out",
                fading ? "opacity-0" : "opacity-100",
              ].join(" ")}
            >
            {displayView.type === "daily" && (
              <TodayView
                items={todayItems}
                progress={todayProgress}
                editingId={editingId}
                setEditingId={setEditingId}
                onAdd={addDaily}
                addRef={dailyAddRef}
                collapsedIds={collapsedIds}
                toggleCollapsed={toggleCollapsed}
                expandId={expandId}
              />
            )}
            {displayView.type === "overview" && (
              <OverviewView
                projects={projects}
                goals={goals}
                setView={setView}
              />
            )}
            {displayView.type === "plan" && (
              activePlan && planBundle ? (
                <PlanView
                  planSubView={view.sub || "today"}
                  setPlanSubView={(sub) => setView({ type: "plan", sub })}
                  bundle={planBundle}
                  goals={state.goals}
                />
              ) : (
                <div className="text-sm text-neutral-500 dark:text-neutral-400 py-10">
                  Setting up your plan…
                </div>
              )
            )}
            {displayView.type === "goalspage" && (
              <GoalsPageView
                goalsList={state.goals}
                habits={state.habits}
                completions={state.habitCompletions}
                projects={projects}
                allTasks={state.daily}
                projectTasks={state.projects}
                onAddGoal={addGoal}
                onUpdateGoal={updateGoal}
                onDeleteGoal={deleteGoal}
                onSetGoalStatus={setGoalStatus}
                onSetGoalProgress={setGoalProgress}
                onLinkGoalToProject={linkGoalToProject}
                onUnlinkGoalFromProject={unlinkGoalFromProject}
                onAddHabit={addHabit}
                onUpdateHabit={updateHabit}
                onDeleteHabit={deleteHabit}
                showConfirm={showConfirm}
              />
            )}
            {displayView.type === "weekly" && (
              <WeekView
                weeklyItemsByDay={weeklyItemsByDay}
                weekDates={weekDates}
                todayK={todayK}
                progress={weeklyProgress}
                editingId={editingId}
                setEditingId={setEditingId}
                onAdd={addWeekly}
                dayRefSetters={weeklyDayRefSetters}
                mode={weeklyMode}
                setMode={setWeeklyMode}
                collapsedIds={collapsedIds}
                toggleCollapsed={toggleCollapsed}
                expandId={expandId}
              />
            )}
            {displayView.type === "project" &&
              currentProject &&
              (currentProject.type === "goal" ? (
                <LegacyGoalView
                  key={currentProject.id}
                  project={currentProject}
                  editingId={editingId}
                  setEditingId={setEditingId}
                  onUpdateTitle={(t) =>
                    updateProjectTitle(currentProject.id, t)
                  }
                  onCycleType={() => cycleProjectType(currentProject.id)}
                  onSetIcon={(name) =>
                    setProjectIcon(currentProject.id, name)
                  }
                  onDelete={() => deleteProject(currentProject.id)}
                  onAddWeek={() => addWeek(currentProject.id)}
                  onDeleteWeek={(wid) =>
                    deleteWeek(currentProject.id, wid)
                  }
                  onAddTask={(wid, day, t) =>
                    addProjectTask(currentProject.id, wid, day, t)
                  }
                  onAddTaskChild={(wid, day, parentPath, t) =>
                    addProjectTaskChild(
                      currentProject.id,
                      wid,
                      day,
                      parentPath,
                      t
                    )
                  }
                  onToggleTask={(wid, day, path) =>
                    toggleProjectTask(currentProject.id, wid, day, path)
                  }
                  onUpdateTask={(wid, day, path, t) =>
                    updateProjectTaskTitle(
                      currentProject.id,
                      wid,
                      day,
                      path,
                      t
                    )
                  }
                  onDeleteTask={(wid, day, path) =>
                    deleteProjectTask(currentProject.id, wid, day, path)
                  }
                  projectAddRefSetter={projectAddRefSetter}
                  showConfirm={showConfirm}
                />
              ) : displayView.week ? (
                <ProjectWeekView
                  key={`${currentProject.id}:${displayView.week}`}
                  project={currentProject}
                  weekStartIso={displayView.week}
                  setView={setView}
                  editingId={editingId}
                  setEditingId={setEditingId}
                  collapsedIds={collapsedIds}
                  toggleCollapsed={toggleCollapsed}
                  expandId={expandId}
                  handlersForDate={(dayIso) => ({
                    ...projectDatedHandlersFor(currentProject.id, dayIso),
                    addTopLevel: (title) =>
                      addProjectDatedTask(
                        currentProject.id,
                        dayIso,
                        title
                      ),
                  })}
                  onUpdateTitle={(t) =>
                    updateProjectTitle(currentProject.id, t)
                  }
                  onSetIcon={(name) =>
                    setProjectIcon(currentProject.id, name)
                  }
                  onDelete={() => deleteProject(currentProject.id)}
                  onSetMilestone={(weekStart, text) =>
                    setProjectMilestone(currentProject.id, weekStart, text)
                  }
                  showConfirm={showConfirm}
                  projectAddRefSetter={projectAddRefSetter}
                  habits={state.habits}
                  habitCompletions={state.habitCompletions}
                  toggleHabitVirtual={toggleHabitVirtual}
                />
              ) : (
                <ProjectPlanView
                  key={currentProject.id}
                  project={currentProject}
                  setView={setView}
                  editingId={editingId}
                  setEditingId={setEditingId}
                  collapsedIds={collapsedIds}
                  toggleCollapsed={toggleCollapsed}
                  expandId={expandId}
                  onUpdateTitle={(t) =>
                    updateProjectTitle(currentProject.id, t)
                  }
                  onSetIcon={(name) =>
                    setProjectIcon(currentProject.id, name)
                  }
                  onDelete={() => deleteProject(currentProject.id)}
                  onSetMainGoal={(text) =>
                    setProjectMainGoal(currentProject.id, text)
                  }
                  onSetDeadline={(iso) =>
                    setProjectDeadline(currentProject.id, iso)
                  }
                  onSetMilestone={(weekStart, text) =>
                    setProjectMilestone(currentProject.id, weekStart, text)
                  }
                  onAddBacklogTask={(t) =>
                    addProjectDatedTask(currentProject.id, null, t)
                  }
                  backlogHandlers={projectDatedHandlersFor(
                    currentProject.id,
                    null
                  )}
                  showConfirm={showConfirm}
                  projectAddRefSetter={projectAddRefSetter}
                />
              ))}
            </div>
          </div>
        </main>
      </div>
      <ConfirmDialog
        state={confirmState}
        onClose={() => setConfirmState(null)}
      />
    </div>
  );
}

// ===== Sidebar =====

function Sidebar({
  open,
  onCollapse,
  view,
  setView,
  projects,
  goals,
  theme,
  setTheme,
  onAddProject,
  onAddGoal,
}) {
  const { signOut } = useAuthActions();
  return (
    <aside
      className={[
        "flex-none overflow-hidden transition-all duration-300 ease-out h-full",
        open ? "w-64 lg-sidebar" : "w-0",
      ].join(" ")}
      aria-hidden={!open}
    >
      <div
        className={[
          "w-64 h-full flex flex-col transition-opacity duration-300 ease-out",
          open ? "opacity-100" : "opacity-0 pointer-events-none",
        ].join(" ")}
      >
      <div className="px-5 py-6 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Tasks</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {formatLongDate(new Date())}
          </p>
        </div>
        <button
          onClick={onCollapse}
          className="flex-none p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-white/70 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-100 transition-all duration-150"
          aria-label="Collapse sidebar"
        >
          <SidebarIcon className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
        <SidebarItem
          Icon={Sun}
          iconColor="text-amber-500"
          label="Today"
          active={view.type === "daily"}
          onClick={() => setView({ type: "daily" })}
        />
        <SidebarItem
          Icon={CalendarDays}
          iconColor="text-blue-500"
          label="This Week"
          active={view.type === "weekly"}
          onClick={() => setView({ type: "weekly" })}
        />
        <SidebarItem
          Icon={ChartIcon}
          iconColor="text-emerald-500"
          label="Overview"
          active={view.type === "overview"}
          onClick={() => setView({ type: "overview" })}
        />
        <SidebarItem
          Icon={GoalsIcon}
          iconColor="text-rose-500"
          label="Goals"
          active={view.type === "goalspage"}
          onClick={() => setView({ type: "goalspage" })}
        />
        <SidebarItem
          Icon={PlanSidebarIcon}
          iconColor="text-indigo-500"
          label="Plan"
          active={view.type === "plan"}
          onClick={() =>
            setView({ type: "plan", sub: view.sub || "today" })
          }
        />

        <SidebarHeader label="Projects" onAdd={onAddProject} />
        {projects.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-neutral-400 dark:text-neutral-600 italic">
            No projects
          </p>
        ) : (
          projects.map((p) => (
            <SidebarItem
              key={p.id}
              iconName={p.icon}
              iconColor={TYPE_ICON_COLOR.project}
              label={p.title || "Untitled"}
              muted={!p.title}
              active={view.type === "project" && view.id === p.id}
              onClick={() => setView({ type: "project", id: p.id })}
            />
          ))
        )}

        {/* Legacy "Goals" group (project type === "goal") is intentionally
            hidden — the new top-level Goals page is the canonical surface.
            Legacy goals remain readable through the Overview page until/if
            they're migrated to state.goals[]. */}
      </nav>

      <div className="p-4 border-t border-black/10 dark:border-white/10 space-y-1">
        <button
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-neutral-600 dark:text-neutral-400 hover:bg-white/70 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-100 transition-all duration-150"
        >
          {theme === "dark" ? (
            <Sun className="w-4 h-4 flex-none" />
          ) : (
            <Moon className="w-4 h-4 flex-none" />
          )}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <button
          onClick={() => signOut()}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-neutral-600 dark:text-neutral-400 hover:bg-white/70 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-100 transition-all duration-150"
        >
          <Icon
            icon="solar:logout-2-bold-duotone"
            className="w-4 h-4 flex-none"
          />
          Sign out
        </button>
      </div>
      </div>
    </aside>
  );
}

function SidebarItem({
  Icon,
  iconName,
  iconColor,
  dotColor,
  label,
  active,
  muted,
  onClick,
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150",
        active
          ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-sm"
          : "text-neutral-700 dark:text-neutral-400 hover:bg-white/70 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-neutral-100",
      ].join(" ")}
    >
      {Icon ? (
        <Icon className={["w-4 h-4 flex-none", iconColor].join(" ")} />
      ) : iconName ? (
        <ProjectIconRender
          name={iconName}
          className={["w-4 h-4 flex-none", iconColor].join(" ")}
        />
      ) : null}
      {dotColor && (
        <span
          className={["w-1.5 h-1.5 rounded-full flex-none", dotColor].join(
            " "
          )}
        />
      )}
      <span
        className={[
          "truncate flex-1",
          muted ? "italic text-neutral-400 dark:text-neutral-500" : "",
        ].join(" ")}
      >
        {label}
      </span>
    </button>
  );
}

function SidebarHeader({ label, onAdd }) {
  return (
    <div className="flex items-center justify-between px-3 mt-7 mb-2 group">
      <h3 className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-500 font-medium">
        {label}
      </h3>
      {onAdd && (
        <button
          onClick={onAdd}
          className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200 transition-all duration-150 rounded p-0.5 hover:bg-white dark:hover:bg-neutral-800"
          aria-label={`Add ${label.toLowerCase()}`}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ===== Today =====

function TodayView({
  items,
  progress,
  editingId,
  setEditingId,
  onAdd,
  addRef,
  collapsedIds,
  toggleCollapsed,
  expandId,
}) {
  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        Icon={Sun}
        iconColor="text-amber-500"
        title="Today"
        subtitle={formatLongDate(new Date())}
        right={
          progress.total > 0 && (
            <ProgressLabel done={progress.done} total={progress.total} />
          )
        }
      />
      {items.length === 0 ? (
        <div className="text-center text-sm text-neutral-400 dark:text-neutral-500 py-16">
          Nothing for today.
        </div>
      ) : (
        <ul>
          <DraggableTaskList
            items={items}
            renderItem={({
              item,
              translateY,
              isLifting,
              onRowMouseDown,
              registerRowRef,
            }) => (
              <TaskRow
                key={item.id}
                item={item}
                editingId={editingId}
                setEditingId={setEditingId}
                onToggle={item.onToggle}
                onUpdate={item.onUpdate}
                onDelete={item.onDelete}
                onAddChild={item.onAddChild}
                onAddSibling={item.onAddSibling}
                onReorder={item.onReorder}
                onSchedule={item.onSchedule}
                onRowMouseDown={onRowMouseDown}
                registerRowRef={registerRowRef}
                translateY={translateY}
                isLifting={isLifting}
                collapsedIds={collapsedIds}
                toggleCollapsed={toggleCollapsed}
                expandId={expandId}
              />
            )}
          />
        </ul>
      )}
      <div className="lg-add mt-4 rounded-xl px-4 py-3">
        <AddInput inputRef={addRef} onSubmit={onAdd} />
      </div>
    </div>
  );
}

// ===== This Week (top-level) =====

function WeekView({
  weeklyItemsByDay,
  weekDates,
  todayK,
  progress,
  editingId,
  setEditingId,
  onAdd,
  dayRefSetters,
  mode,
  setMode,
  collapsedIds,
  toggleCollapsed,
  expandId,
}) {
  const [detailItem, setDetailItem] = useState(null);
  // Re-resolve the displayed item from the latest tree so toggles /
  // edits made inside the modal reflect immediately. The bound items
  // are recomputed each render of the parent, so we look up by id.
  const liveDetail = useMemo(() => {
    if (!detailItem) return null;
    for (const arr of Object.values(weeklyItemsByDay)) {
      const found = arr.find((t) => t.id === detailItem.id);
      if (found) return found;
    }
    return null;
  }, [detailItem, weeklyItemsByDay]);
  const subtitle = `${formatShortDate(weekDates[0].date)} – ${formatShortDate(
    weekDates[6].date
  )}`;
  return (
    <div>
      <PageHeader
        Icon={CalendarDays}
        iconColor="text-blue-500"
        title="This Week"
        subtitle={subtitle}
        right={
          <div className="flex items-center gap-3">
            <ModeToggle
              mode={mode}
              setMode={setMode}
              options={[
                {
                  key: "grid",
                  label: "Grid",
                  icon: "solar:widget-2-bold-duotone",
                },
                {
                  key: "list",
                  label: "Stack",
                  icon: "solar:list-bold-duotone",
                },
              ]}
            />
            <ProgressLabel done={progress.done} total={progress.total} />
          </div>
        }
      />
      {mode === "list" ? (
        <DayStack
          weekDates={weekDates}
          weeklyItemsByDay={weeklyItemsByDay}
          todayK={todayK}
          editingId={editingId}
          setEditingId={setEditingId}
          onAdd={onAdd}
          dayRefSetters={dayRefSetters}
          onOpenDetail={setDetailItem}
        />
      ) : (
        <DayGrid>
          {weekDates.map(({ key, short, date }) => {
            const items = weeklyItemsByDay[key] || [];
            const isToday = key === todayK;
            return (
              <DayColumn
                key={key}
                short={short}
                date={date}
                isToday={isToday}
                items={items}
                editingId={editingId}
                setEditingId={setEditingId}
                onAdd={(t) => onAdd(t, key)}
                addRef={dayRefSetters[key]}
                onOpenDetail={setDetailItem}
              />
            );
          })}
        </DayGrid>
      )}
      <TaskDetailModal
        item={liveDetail}
        editingId={editingId}
        setEditingId={setEditingId}
        collapsedIds={collapsedIds}
        toggleCollapsed={toggleCollapsed}
        expandId={expandId}
        onClose={() => setDetailItem(null)}
      />
    </div>
  );
}

function ModeToggle({ mode, setMode, options }) {
  return (
    <div className="inline-flex rounded-full bg-neutral-100/70 dark:bg-neutral-900/60 p-1 border border-black/5 dark:border-white/5">
      {options.map(({ key, label, icon }) => {
        const active = mode === key;
        return (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={[
              "px-3 py-1 text-xs rounded-full transition-all duration-150 inline-flex items-center gap-1.5",
              active
                ? "bg-white dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200",
            ].join(" ")}
          >
            {icon && <Icon icon={icon} className="w-3.5 h-3.5" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function DayStack({
  weekDates,
  weeklyItemsByDay,
  todayK,
  editingId,
  setEditingId,
  onAdd,
  dayRefSetters,
  onOpenDetail,
}) {
  return (
    <div className="grid grid-cols-[repeat(7,minmax(180px,1fr))] gap-3">
      {weekDates.map(({ key, label, short, date }) => {
        const items = weeklyItemsByDay[key] || [];
        const isToday = key === todayK;
        const dayProgress = countDirect(items);
        return (
          <section
            key={key}
            className={[
              "rounded-2xl p-4 flex flex-col gap-3 min-h-[calc(100vh-240px)] transition-all duration-150",
              isToday ? "lg-today" : "lg-card",
            ].join(" ")}
          >
            <div className="flex items-baseline justify-between">
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={[
                      "text-sm font-semibold uppercase tracking-wide",
                      isToday
                        ? "text-[#007AFF] dark:text-blue-400"
                        : "text-neutral-700 dark:text-neutral-200",
                    ].join(" ")}
                  >
                    {short}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">
                    {date.getDate()}
                  </span>
                </div>
                <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {label}
                </span>
              </div>
              {items.length > 0 && (
                <span
                  className={[
                    "text-[11px] flex-none",
                    dayProgress.done === dayProgress.total
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-neutral-400 dark:text-neutral-500",
                  ].join(" ")}
                >
                  {dayProgress.done}/{dayProgress.total}
                </span>
              )}
            </div>
            <ul className="space-y-1.5 flex-1">
              <DraggableTaskList
                items={items}
                renderItem={({
                  item,
                  translateY,
                  isLifting,
                  onRowMouseDown,
                  registerRowRef,
                }) => (
                  <TaskRow
                    key={item.id}
                    item={item}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    onToggle={item.onToggle}
                    onUpdate={item.onUpdate}
                    onDelete={item.onDelete}
                    onAddSibling={item.onAddSibling}
                    onReorder={item.onReorder}
                    onSchedule={item.onSchedule}
                    onOpenDetail={onOpenDetail}
                    onRowMouseDown={onRowMouseDown}
                    registerRowRef={registerRowRef}
                    translateY={translateY}
                    isLifting={isLifting}
                    compact
                    topLevelOnly
                  />
                )}
              />
            </ul>
            <AddInput
              inputRef={dayRefSetters[key]}
              onSubmit={(t) => onAdd(t, key)}
              placeholder="+ task"
              compact
            />
          </section>
        );
      })}
    </div>
  );
}

// ===== Overview =====

function OverviewView({ projects, goals, setView }) {
  return (
    <div>
      <PageHeader
        Icon={ChartIcon}
        iconColor="text-emerald-500"
        title="Overview"
        subtitle={`${projects.length} project${
          projects.length === 1 ? "" : "s"
        } · ${goals.length} goal${goals.length === 1 ? "" : "s"}`}
      />

      <section className="mb-10">
        <h2 className="text-base font-medium mb-4">Projects roadmap</h2>
        {projects.length === 0 ? (
          <div className="lg-card rounded-2xl p-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
            No projects yet. Add one from the sidebar.
          </div>
        ) : (
          <Gantt
            items={projects}
            type="project"
            onClickItem={(id) => setView({ type: "project", id })}
          />
        )}
      </section>

      <section>
        <h2 className="text-base font-medium mb-4">Goals</h2>
        {goals.length === 0 ? (
          <div className="lg-card rounded-2xl p-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
            No goals yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {goals.map((g) => (
              <LegacyGoalCard
                key={g.id}
                goal={g}
                onClick={() => setView({ type: "project", id: g.id })}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function Gantt({ items, type, onClickItem }) {
  const dayWidth = 22;
  const labelWidth = 200;
  const rowHeight = 40;

  const ranges = useMemo(
    () =>
      items.map((p) => {
        const startStr = p.startMonday || isoDate(mondayOf(new Date()));
        const start = new Date(startStr + "T00:00:00");
        let weekCount;
        if (p.type === "goal") {
          weekCount = Math.max(1, p.weeks?.length || 1);
        } else if (p.deadline) {
          const deadline = parseISO(p.deadline);
          const days = deadline ? daysBetween(start, deadline) : 7;
          weekCount = Math.max(1, Math.ceil((days + 1) / 7));
        } else {
          // Project without a deadline — show as a single-week placeholder.
          weekCount = 1;
        }
        const end = addDays(start, 7 * weekCount);
        return { project: p, start, end, weekCount };
      }),
    [items]
  );

  const minMonday = useMemo(() => {
    const minStart = new Date(
      Math.min(...ranges.map((r) => r.start.getTime()))
    );
    return mondayOf(minStart);
  }, [ranges]);

  const totalWeeks = useMemo(() => {
    const maxEnd = new Date(Math.max(...ranges.map((r) => r.end.getTime())));
    const totalDays = Math.ceil((maxEnd.getTime() - minMonday.getTime()) / DAY_MS);
    return Math.max(4, Math.ceil(totalDays / 7));
  }, [ranges, minMonday]);

  const totalWidth = totalWeeks * 7 * dayWidth;

  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const todayOffsetDays = Math.floor(
    (today.getTime() - minMonday.getTime()) / DAY_MS
  );
  const todayInRange = todayOffsetDays >= 0 && todayOffsetDays <= totalWeeks * 7;

  return (
    <div className="lg-card rounded-2xl p-5 overflow-x-auto">
      <div style={{ minWidth: `${labelWidth + totalWidth + 24}px` }}>
        {/* Week header */}
        <div className="flex items-end pb-3 mb-3 border-b border-black/[0.06] dark:border-white/[0.06]">
          <div style={{ width: labelWidth }} className="flex-none" />
          <div className="relative" style={{ width: totalWidth, height: 16 }}>
            {Array.from({ length: totalWeeks }).map((_, wi) => {
              const weekStart = addDays(minMonday, wi * 7);
              const isCurrent =
                todayOffsetDays >= wi * 7 && todayOffsetDays < (wi + 1) * 7;
              return (
                <div
                  key={wi}
                  className={[
                    "absolute text-[10px] font-medium uppercase tracking-wide",
                    isCurrent
                      ? "text-[#007AFF] dark:text-blue-400"
                      : "text-neutral-400 dark:text-neutral-500",
                  ].join(" ")}
                  style={{ left: `${wi * 7 * dayWidth}px`, top: 0 }}
                >
                  {formatShortDate(weekStart)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rows + today line */}
        <div className="relative">
          {todayInRange && (
            <div
              className="absolute pointer-events-none top-0 bottom-0 w-px bg-[#007AFF]/40 z-10"
              style={{
                left: `${labelWidth + todayOffsetDays * dayWidth}px`,
              }}
            />
          )}
          <div className="space-y-2">
            {ranges.map(({ project, start, weekCount }) => {
              const offsetDays = Math.floor(
                (start.getTime() - minMonday.getTime()) / DAY_MS
              );
              const widthDays = 7 * weekCount;
              const stats = countProject(project);
              const pct = stats.total > 0 ? stats.done / stats.total : 0;
              const isGoal = project.type === "goal";
              return (
                <div
                  key={project.id}
                  className="flex items-center"
                  style={{ height: rowHeight }}
                >
                  <button
                    onClick={() => onClickItem(project.id)}
                    className="flex-none flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200 hover:text-[#007AFF] dark:hover:text-blue-400 transition-colors pr-3"
                    style={{ width: labelWidth }}
                  >
                    <ProjectIconRender
                      name={project.icon}
                      className={[
                        "w-4 h-4 flex-none",
                        isGoal
                          ? TYPE_ICON_COLOR.goal
                          : TYPE_ICON_COLOR.project,
                      ].join(" ")}
                    />
                    <span className="truncate">
                      {project.title || "Untitled"}
                    </span>
                  </button>
                  <div className="relative flex-1" style={{ height: rowHeight }}>
                    <button
                      onClick={() => onClickItem(project.id)}
                      className={[
                        "absolute h-7 top-1.5 rounded-md ring-1 transition-all duration-150 hover:brightness-110 cursor-pointer flex items-center px-2 overflow-hidden",
                        isGoal
                          ? "bg-violet-500/25 ring-violet-500/40 dark:bg-violet-400/20 dark:ring-violet-400/40"
                          : "bg-blue-500/25 ring-blue-500/40 dark:bg-blue-400/20 dark:ring-blue-400/40",
                      ].join(" ")}
                      style={{
                        left: `${offsetDays * dayWidth}px`,
                        width: `${widthDays * dayWidth}px`,
                      }}
                      aria-label={`${project.title || "Untitled"} bar`}
                    >
                      <div
                        className={[
                          "absolute top-0 left-0 h-full",
                          isGoal
                            ? "bg-violet-500/40 dark:bg-violet-400/35"
                            : "bg-blue-500/40 dark:bg-blue-400/35",
                        ].join(" ")}
                        style={{ width: `${pct * 100}%` }}
                      />
                      <span
                        className={[
                          "relative z-[1] text-[11px] font-medium whitespace-nowrap",
                          isGoal
                            ? "text-violet-800 dark:text-violet-100"
                            : "text-blue-800 dark:text-blue-100",
                        ].join(" ")}
                      >
                        {weekCount} week{weekCount === 1 ? "" : "s"} ·{" "}
                        {Math.round(pct * 100)}%
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function LegacyGoalCard({ goal, onClick }) {
  const stats = countProject(goal);
  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const complete = stats.total > 0 && stats.done === stats.total;
  return (
    <button
      onClick={onClick}
      className="lg-card rounded-2xl p-5 text-left transition-all duration-150 hover:scale-[1.01]"
    >
      <div className="flex items-start gap-3 mb-3">
        <ProjectIconRender
          name={goal.icon}
          className={["w-6 h-6 flex-none mt-0.5", TYPE_ICON_COLOR.goal].join(
            " "
          )}
        />
        <h3
          className={[
            "text-base font-semibold flex-1 truncate",
            goal.title
              ? "text-neutral-900 dark:text-neutral-100"
              : "text-neutral-400 dark:text-neutral-500 italic",
          ].join(" ")}
        >
          {goal.title || "Untitled"}
        </h3>
      </div>
      <div className="flex items-center justify-between text-xs mb-2">
        <span
          className={
            complete
              ? "text-emerald-600 dark:text-emerald-400 font-medium"
              : "text-neutral-500 dark:text-neutral-400"
          }
        >
          {stats.done}/{stats.total} tasks
        </span>
        <span className="text-neutral-400 dark:text-neutral-500">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.06] overflow-hidden">
        <div
          className={[
            "h-full transition-all duration-300",
            complete
              ? "bg-emerald-500"
              : "bg-violet-500 dark:bg-violet-400",
          ].join(" ")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </button>
  );
}

// ===== Goals page (top-level state.goals[] + state.habits[]) =====

function GoalsPageView({
  goalsList,
  habits,
  completions,
  projects,
  onAddGoal,
  onUpdateGoal,
  onDeleteGoal,
  onSetGoalStatus,
  onSetGoalProgress,
  onLinkGoalToProject,
  onUnlinkGoalFromProject,
  onAddHabit,
  onUpdateHabit,
  onDeleteHabit,
  showConfirm,
}) {
  const [statusFilter, setStatusFilter] = useState("active");
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [editingHabitId, setEditingHabitId] = useState(null);

  const filteredGoals = useMemo(() => {
    if (statusFilter === "all") return goalsList;
    return goalsList.filter((g) => g.status === statusFilter);
  }, [goalsList, statusFilter]);

  const projectsById = useMemo(() => {
    const m = new Map();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  return (
    <div>
      <PageHeader
        Icon={GoalsIcon}
        iconColor="text-rose-500"
        title="Goals"
        subtitle={`${goalsList.length} goal${
          goalsList.length === 1 ? "" : "s"
        } · ${habits.length} habit${habits.length === 1 ? "" : "s"}`}
      />

      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Goals</h2>
          <div className="flex items-center gap-3">
            <ModeToggle
              mode={statusFilter}
              setMode={setStatusFilter}
              options={[
                { key: "active", label: "Active" },
                { key: "done", label: "Done" },
                { key: "all", label: "All" },
              ]}
            />
            <button
              onClick={() => {
                const id = onAddGoal("New goal");
                if (id) setEditingGoalId(id);
              }}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-[#007AFF]/10 text-[#007AFF] hover:bg-[#007AFF]/15 dark:bg-[#007AFF]/20 dark:text-blue-300 dark:hover:bg-[#007AFF]/25 transition-colors duration-150"
            >
              <Plus className="w-3.5 h-3.5" />
              New goal
            </button>
          </div>
        </div>
        {filteredGoals.length === 0 ? (
          <div className="lg-card rounded-2xl p-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
            {statusFilter === "active"
              ? "No active goals. Add one to get started."
              : "Nothing here."}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredGoals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                projectsById={projectsById}
                onClick={() => setEditingGoalId(g.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Habits</h2>
          <button
            onClick={() => {
              const id = onAddHabit("New habit");
              if (id) setEditingHabitId(id);
            }}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-[#007AFF]/10 text-[#007AFF] hover:bg-[#007AFF]/15 dark:bg-[#007AFF]/20 dark:text-blue-300 dark:hover:bg-[#007AFF]/25 transition-colors duration-150"
          >
            <Plus className="w-3.5 h-3.5" />
            New habit
          </button>
        </div>
        {habits.length === 0 ? (
          <div className="lg-card rounded-2xl p-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
            No habits yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {habits.map((h) => (
              <HabitCard
                key={h.id}
                habit={h}
                completions={completions}
                onClick={() => setEditingHabitId(h.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-base font-medium mb-4">Charts</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <HabitHeatmap habits={habits} completions={completions} />
          <TodoThroughputChart
            projects={projects}
            completions={completions}
          />
          <HabitStreakBars habits={habits} completions={completions} />
          <GoalProgressList
            goals={goalsList}
            projectsById={projectsById}
          />
        </div>
      </section>

      {editingGoalId && (
        <GoalEditor
          goal={goalsList.find((g) => g.id === editingGoalId)}
          projects={projects}
          onClose={() => setEditingGoalId(null)}
          onUpdate={(patch) => onUpdateGoal(editingGoalId, patch)}
          onSetStatus={(s) => onSetGoalStatus(editingGoalId, s)}
          onSetProgress={(p) => onSetGoalProgress(editingGoalId, p)}
          onLinkProject={(pid) => onLinkGoalToProject(editingGoalId, pid)}
          onUnlinkProject={(pid) =>
            onUnlinkGoalFromProject(editingGoalId, pid)
          }
          onDelete={() => {
            const goal = goalsList.find((g) => g.id === editingGoalId);
            showConfirm({
              title: "Delete goal?",
              message: `"${goal?.title || "Untitled"}" will be removed.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                onDeleteGoal(editingGoalId);
                setEditingGoalId(null);
              },
            });
          }}
        />
      )}
      {editingHabitId && (
        <HabitEditor
          habit={habits.find((h) => h.id === editingHabitId)}
          projects={projects}
          onClose={() => setEditingHabitId(null)}
          onUpdate={(patch) => onUpdateHabit(editingHabitId, patch)}
          onDelete={() => {
            const habit = habits.find((h) => h.id === editingHabitId);
            showConfirm({
              title: "Delete habit?",
              message: `"${
                habit?.title || "Untitled"
              }" and all its completions will be removed.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                onDeleteHabit(editingHabitId);
                setEditingHabitId(null);
              },
            });
          }}
        />
      )}
    </div>
  );
}

const STATUS_PILL = {
  active:
    "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  paused:
    "bg-neutral-100 text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-300",
  done: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  archived:
    "bg-neutral-100/60 text-neutral-400 dark:bg-white/[0.04] dark:text-neutral-500",
};

function GoalCard({ goal, projectsById, onClick }) {
  // Compute progress: manual override if set, else derive from linked projects.
  const derived = useMemo(() => {
    if (goal.projectIds.length === 0) return null;
    let done = 0;
    let total = 0;
    for (const pid of goal.projectIds) {
      const p = projectsById.get(pid);
      if (!p) continue;
      const s = countProject(p);
      done += s.done;
      total += s.total;
    }
    if (total === 0) return null;
    return { done, total, pct: Math.round((done / total) * 100) };
  }, [goal.projectIds, projectsById]);

  const manual = goal.progress !== null;
  const pct = manual ? goal.progress : derived?.pct ?? null;
  const showDash = pct === null;

  return (
    <button
      onClick={onClick}
      className="lg-card rounded-2xl p-5 text-left transition-all duration-150 hover:scale-[1.005]"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3
          className={[
            "text-base font-semibold flex-1 truncate",
            goal.title
              ? "text-neutral-900 dark:text-neutral-100"
              : "text-neutral-400 dark:text-neutral-500 italic",
          ].join(" ")}
          title={goal.title}
        >
          {goal.title || "Untitled"}
        </h3>
        <span
          className={[
            "text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full flex-none",
            STATUS_PILL[goal.status] || STATUS_PILL.active,
          ].join(" ")}
        >
          {goal.status}
        </span>
      </div>
      {goal.description && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3 line-clamp-2">
          {goal.description}
        </p>
      )}
      <div className="flex items-center gap-2 text-xs mb-3 flex-wrap">
        {goal.targetDate && (
          <>
            <span className="text-neutral-400 dark:text-neutral-500">
              Target {formatShortDate(parseISO(goal.targetDate))}
            </span>
            <TimeRemainingPill deadline={goal.targetDate} />
          </>
        )}
      </div>
      {goal.projectIds.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mb-3">
          {goal.projectIds.map((pid) => {
            const p = projectsById.get(pid);
            if (!p) return null;
            return (
              <span
                key={pid}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 inline-flex items-center gap-1"
              >
                <ProjectIconRender
                  name={p.icon}
                  className="w-3 h-3"
                />
                <span className="truncate max-w-[120px]">
                  {p.title || "Untitled"}
                </span>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-neutral-500 dark:text-neutral-400">
          {showDash
            ? "—"
            : manual
            ? `${pct}% (manual)`
            : `${derived.done}/${derived.total} tasks`}
        </span>
        {!showDash && (
          <span className="text-neutral-400 dark:text-neutral-500">{pct}%</span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.06] overflow-hidden">
        <div
          className={[
            "h-full transition-all duration-300",
            pct === 100
              ? "bg-emerald-500"
              : "bg-rose-500 dark:bg-rose-400",
          ].join(" ")}
          style={{ width: `${showDash ? 0 : pct}%` }}
        />
      </div>
    </button>
  );
}

function cadenceLabel(cadence) {
  if (!cadence) return "";
  if (cadence.kind === "daily") return "Daily";
  if (cadence.kind === "weekly_count")
    return `${cadence.count}× / week`;
  if (cadence.kind === "weekdays")
    return cadence.days
      .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
      .join(" · ");
  return "";
}

function HabitCard({ habit, completions, onClick }) {
  const cur = currentStreak(habit, completions);
  const longest = longestStreak(habit, completions);
  const strip = lastN(habit, completions, 30);
  const weekProg = thisWeekProgress(habit, completions);

  return (
    <button
      onClick={onClick}
      className="lg-card rounded-2xl p-5 text-left transition-all duration-150 hover:scale-[1.005]"
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <HabitIcon className="w-5 h-5 text-rose-500 dark:text-rose-400 flex-none" />
          <h3
            className={[
              "text-base font-semibold flex-1 truncate",
              habit.title
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-400 dark:text-neutral-500 italic",
            ].join(" ")}
            title={habit.title}
          >
            {habit.title || "Untitled"}
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 flex-none">
          {cadenceLabel(habit.cadence)}
        </span>
      </div>
      <div className="flex items-baseline gap-3 text-xs mb-3 mt-2">
        <span className="text-neutral-700 dark:text-neutral-200 font-medium">
          {cur}d streak
        </span>
        <span className="text-neutral-400 dark:text-neutral-500">
          longest {longest}d
        </span>
        {weekProg && (
          <span className="text-neutral-400 dark:text-neutral-500">
            · {weekProg.completed}/{weekProg.target} this week
          </span>
        )}
      </div>
      <HabitStrip cells={strip} />
    </button>
  );
}

// 30-day strip: one cell per day, oldest left → newest right. Filled
// rose for expected+completed, faint outline for expected+missed,
// nearly empty spacer for not-expected days.
function HabitStrip({ cells }) {
  return (
    <div className="flex items-center gap-[2px] h-4">
      {cells.map((c) => {
        let cls;
        if (!c.expected) {
          cls = "bg-black/[0.04] dark:bg-white/[0.04]";
        } else if (c.completed) {
          cls = "bg-rose-500 dark:bg-rose-400";
        } else {
          cls = "border border-rose-500/40 dark:border-rose-400/40";
        }
        return (
          <div
            key={c.iso}
            className={["flex-1 h-full rounded-[2px]", cls].join(" ")}
            title={`${formatShortDate(c.date)} · ${
              !c.expected ? "off" : c.completed ? "done" : "missed"
            }`}
          />
        );
      })}
    </div>
  );
}

// ===== Goal / Habit editors (modals) =====

function ModalShell({ title, onClose, children, footer }) {
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative lg-card rounded-2xl p-6 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors duration-150"
            aria-label="Close"
          >
            <Icon icon="solar:close-circle-bold-duotone" className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-4">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

function GoalEditor({
  goal,
  projects,
  onClose,
  onUpdate,
  onSetStatus,
  onSetProgress,
  onLinkProject,
  onUnlinkProject,
  onDelete,
}) {
  if (!goal) return null;
  const manual = goal.progress !== null;
  const linked = new Set(goal.projectIds);
  return (
    <ModalShell
      title="Edit goal"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onDelete}
            className="px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors duration-150"
          >
            Delete
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0064d1] transition-colors duration-150"
          >
            Done
          </button>
        </>
      }
    >
      <FieldLabel label="Title">
        <input
          type="text"
          value={goal.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="w-full bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-[#007AFF]/40"
          placeholder="What's the goal?"
        />
      </FieldLabel>
      <FieldLabel label="Description">
        <textarea
          value={goal.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={3}
          className="w-full bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-[#007AFF]/40 resize-none"
          placeholder="Optional"
        />
      </FieldLabel>
      <FieldLabel label="Target date">
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={goal.targetDate || ""}
            onChange={(e) => onUpdate({ targetDate: e.target.value || null })}
            className="bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none"
          />
          <TimeRemainingPill deadline={goal.targetDate} />
        </div>
      </FieldLabel>
      <FieldLabel label="Status">
        <div className="inline-flex rounded-full bg-neutral-100/70 dark:bg-neutral-900/60 p-1 border border-black/5 dark:border-white/5">
          {GOAL_STATUSES.map((s) => {
            const active = goal.status === s;
            return (
              <button
                key={s}
                onClick={() => onSetStatus(s)}
                className={[
                  "px-3 py-1 text-xs rounded-full transition-all duration-150 capitalize",
                  active
                    ? "bg-white dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100"
                    : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200",
                ].join(" ")}
              >
                {s}
              </button>
            );
          })}
        </div>
      </FieldLabel>
      <FieldLabel label="Progress">
        <div className="space-y-2">
          <div className="inline-flex rounded-full bg-neutral-100/70 dark:bg-neutral-900/60 p-1 border border-black/5 dark:border-white/5">
            <button
              onClick={() => onSetProgress(null)}
              className={[
                "px-3 py-1 text-xs rounded-full transition-all duration-150",
                !manual
                  ? "bg-white dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500 dark:text-neutral-400",
              ].join(" ")}
            >
              From linked projects
            </button>
            <button
              onClick={() => onSetProgress(goal.progress ?? 0)}
              className={[
                "px-3 py-1 text-xs rounded-full transition-all duration-150",
                manual
                  ? "bg-white dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500 dark:text-neutral-400",
              ].join(" ")}
            >
              Manual
            </button>
          </div>
          {manual && (
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                value={goal.progress ?? 0}
                onChange={(e) =>
                  onSetProgress(Number(e.target.value))
                }
                className="flex-1"
              />
              <span className="text-sm text-neutral-700 dark:text-neutral-200 w-12 text-right">
                {goal.progress ?? 0}%
              </span>
            </div>
          )}
        </div>
      </FieldLabel>
      <FieldLabel label="Linked projects">
        {projects.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">
            No projects yet to link.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => {
              const isLinked = linked.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() =>
                    isLinked ? onUnlinkProject(p.id) : onLinkProject(p.id)
                  }
                  className={[
                    "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-all duration-150",
                    isLinked
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "bg-neutral-100/70 text-neutral-500 dark:bg-white/[0.05] dark:text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-white/[0.08]",
                  ].join(" ")}
                >
                  <ProjectIconRender
                    name={p.icon}
                    className="w-3.5 h-3.5"
                  />
                  <span className="truncate max-w-[160px]">
                    {p.title || "Untitled"}
                  </span>
                  {isLinked && <Icon icon="solar:check-bold" className="w-3 h-3" />}
                </button>
              );
            })}
          </div>
        )}
      </FieldLabel>
    </ModalShell>
  );
}

function HabitEditor({ habit, projects, onClose, onUpdate, onDelete }) {
  if (!habit) return null;
  const c = habit.cadence || { kind: "daily" };
  return (
    <ModalShell
      title="Edit habit"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onDelete}
            className="px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors duration-150"
          >
            Delete
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0064d1] transition-colors duration-150"
          >
            Done
          </button>
        </>
      }
    >
      <FieldLabel label="Title">
        <input
          type="text"
          value={habit.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="w-full bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-[#007AFF]/40"
        />
      </FieldLabel>
      <FieldLabel label="Cadence">
        <div className="space-y-3">
          <div className="inline-flex rounded-full bg-neutral-100/70 dark:bg-neutral-900/60 p-1 border border-black/5 dark:border-white/5">
            {[
              { key: "daily", label: "Daily" },
              { key: "weekdays", label: "Weekdays" },
              { key: "weekly_count", label: "Weekly count" },
            ].map(({ key, label }) => {
              const active = c.kind === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === "daily") onUpdate({ cadence: { kind: "daily" } });
                    else if (key === "weekdays")
                      onUpdate({
                        cadence: {
                          kind: "weekdays",
                          days: c.kind === "weekdays" ? c.days : ["mon"],
                        },
                      });
                    else
                      onUpdate({
                        cadence: {
                          kind: "weekly_count",
                          count:
                            c.kind === "weekly_count" ? c.count : 3,
                        },
                      });
                  }}
                  className={[
                    "px-3 py-1 text-xs rounded-full transition-all duration-150",
                    active
                      ? "bg-white dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {c.kind === "weekdays" && (
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => {
                const on = c.days?.includes(d.key);
                return (
                  <button
                    key={d.key}
                    onClick={() => {
                      const nextDays = on
                        ? c.days.filter((x) => x !== d.key)
                        : [...(c.days || []), d.key];
                      onUpdate({
                        cadence: {
                          kind: "weekdays",
                          days: nextDays.length ? nextDays : [d.key],
                        },
                      });
                    }}
                    className={[
                      "px-2 py-1 text-xs rounded-md transition-colors duration-150",
                      on
                        ? "bg-rose-500 text-white"
                        : "bg-neutral-100/70 dark:bg-white/[0.05] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/70 dark:hover:bg-white/[0.08]",
                    ].join(" ")}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
          )}
          {c.kind === "weekly_count" && (
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={14}
                value={c.count}
                onChange={(e) => {
                  const n = Math.max(
                    1,
                    Math.min(14, Number(e.target.value) || 1)
                  );
                  onUpdate({ cadence: { kind: "weekly_count", count: n } });
                }}
                className="w-16 bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none"
              />
              <span className="text-sm text-neutral-500 dark:text-neutral-400">
                times per week
              </span>
            </div>
          )}
        </div>
      </FieldLabel>
      <FieldLabel label="Auto-generate todos">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!habit.autoGenerateTodo}
            onChange={(e) => onUpdate({ autoGenerateTodo: e.target.checked })}
            className="w-4 h-4 accent-[#007AFF]"
          />
          <span className="text-sm text-neutral-700 dark:text-neutral-200">
            Show as a virtual todo on scheduled days
          </span>
        </label>
      </FieldLabel>
      <FieldLabel label="Linked project">
        <select
          value={habit.linkedProjectId || ""}
          onChange={(e) =>
            onUpdate({ linkedProjectId: e.target.value || null })
          }
          className="w-full bg-transparent border border-black/[0.10] dark:border-white/[0.10] rounded-md px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-[#007AFF]/40"
        >
          <option value="">(none — show in Today)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || "Untitled"}
            </option>
          ))}
        </select>
      </FieldLabel>
    </ModalShell>
  );
}

function FieldLabel({ label, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-500 font-medium mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

// ===== Charts (custom SVG) =====

// 90-day heatmap: 13 columns × 7 rows. Each cell = one day. Color is
// total habit completions on that day across all habits (intensity step
// every 1 completion, capped at 4 levels).
function HabitHeatmap({ habits, completions }) {
  const cellSize = 12;
  const gap = 2;
  const totalDays = 91; // 13 weeks
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = mondayOf(addDays(today, -(totalDays - 1)));

  const byDate = new Map();
  for (const c of completions) {
    if (!c?.date) continue;
    byDate.set(c.date, (byDate.get(c.date) || 0) + 1);
  }

  const cells = [];
  let d = start;
  let week = 0;
  while (week < 13) {
    for (let dow = 0; dow < 7; dow++) {
      const iso = isoDate(d);
      const count = byDate.get(iso) || 0;
      const future = d > today;
      cells.push({
        x: week * (cellSize + gap),
        y: dow * (cellSize + gap),
        iso,
        date: new Date(d),
        count,
        future,
      });
      d = addDays(d, 1);
    }
    week += 1;
  }

  const width = 13 * (cellSize + gap);
  const height = 7 * (cellSize + gap);

  return (
    <ChartCard title="Completions (90 days)">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="block w-full"
        style={{ maxHeight: 200 }}
      >
        {cells.map((c) => {
          let fill;
          if (c.future) {
            fill = "var(--heat-empty)";
          } else if (c.count === 0) {
            fill = "var(--heat-zero)";
          } else if (c.count === 1) {
            fill = "var(--heat-1)";
          } else if (c.count === 2) {
            fill = "var(--heat-2)";
          } else if (c.count === 3) {
            fill = "var(--heat-3)";
          } else {
            fill = "var(--heat-4)";
          }
          return (
            <rect
              key={c.iso}
              x={c.x}
              y={c.y}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={fill}
            >
              <title>
                {formatShortDate(c.date)} · {c.count}{" "}
                {c.count === 1 ? "completion" : "completions"}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-3 flex items-center gap-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
        <span>Less</span>
        {["zero", "1", "2", "3", "4"].map((k) => (
          <span
            key={k}
            className="w-2.5 h-2.5 rounded-[2px]"
            style={{ background: `var(--heat-${k})` }}
          />
        ))}
        <span>More</span>
      </div>
    </ChartCard>
  );
}

// Streak bar per habit. Two stacked bars: current (filled) + longest (faint).
function HabitStreakBars({ habits, completions }) {
  if (!habits.length) {
    return (
      <ChartCard title="Streaks">
        <p className="text-xs text-neutral-400 dark:text-neutral-500 py-4">
          No habits yet.
        </p>
      </ChartCard>
    );
  }
  const data = habits.map((h) => ({
    title: h.title || "Untitled",
    current: currentStreak(h, completions),
    longest: longestStreak(h, completions),
  }));
  const max = Math.max(7, ...data.map((d) => d.longest || 0));

  return (
    <ChartCard title="Streaks">
      <div className="space-y-2">
        {data.map((d, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <span
              className="text-xs text-neutral-700 dark:text-neutral-200 truncate w-28 flex-none"
              title={d.title}
            >
              {d.title}
            </span>
            <div className="flex-1 relative h-4">
              <div
                className="absolute h-full rounded-sm bg-rose-500/25 dark:bg-rose-400/20"
                style={{ width: `${(d.longest / max) * 100}%` }}
              />
              <div
                className="absolute h-full rounded-sm bg-rose-500 dark:bg-rose-400"
                style={{ width: `${(d.current / max) * 100}%` }}
              />
            </div>
            <span className="text-xs text-neutral-500 dark:text-neutral-400 flex-none w-16 text-right">
              {d.current}d / {d.longest}d
            </span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

// 30-day todo throughput: completions per day (real tasks across daily,
// weekly, projects). Plus habit completions overlaid with a faint tint.
function TodoThroughputChart({ projects, completions }) {
  const days = 30;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // We approximate todo throughput by counting tasks (project.tasks) marked
  // done with a date in the window. Daily/weekly tasks don't carry a
  // completion date, so they're excluded here — keeps the chart honest.
  const byDate = new Map();
  for (const p of projects) {
    if (p.type !== "project") continue;
    const recurseSum = (tasks) => {
      for (const t of tasks || []) {
        if (t.done && t.date) {
          byDate.set(t.date, (byDate.get(t.date) || 0) + 1);
        }
        if (t.children?.length) recurseSum(t.children);
      }
    };
    recurseSum(p.tasks);
  }
  const habitByDate = new Map();
  for (const c of completions) {
    if (!c?.date) continue;
    habitByDate.set(c.date, (habitByDate.get(c.date) || 0) + 1);
  }

  const series = [];
  let max = 1;
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const iso = isoDate(d);
    const todos = byDate.get(iso) || 0;
    const habits = habitByDate.get(iso) || 0;
    if (todos + habits > max) max = todos + habits;
    series.push({ iso, date: d, todos, habits });
  }

  const width = 320;
  const height = 120;
  const xStep = width / (days - 1);

  const todoPath = series
    .map(
      (s, i) =>
        `${i === 0 ? "M" : "L"} ${i * xStep} ${
          height - (s.todos / max) * height
        }`
    )
    .join(" ");
  const totalPath = series
    .map(
      (s, i) =>
        `${i === 0 ? "M" : "L"} ${i * xStep} ${
          height - ((s.todos + s.habits) / max) * height
        }`
    )
    .join(" ");

  return (
    <ChartCard title="Throughput (30 days)">
      <svg
        width="100%"
        height={height + 24}
        viewBox={`0 -4 ${width} ${height + 24}`}
        preserveAspectRatio="none"
        className="block"
      >
        <path
          d={totalPath}
          fill="none"
          stroke="var(--throughput-faint)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={todoPath}
          fill="none"
          stroke="var(--throughput-line)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {series.map((s, i) => (
          <circle
            key={s.iso}
            cx={i * xStep}
            cy={height - (s.todos / max) * height}
            r={1.5}
            fill="var(--throughput-line)"
          >
            <title>
              {formatShortDate(s.date)} · {s.todos} task
              {s.todos === 1 ? "" : "s"}, {s.habits} habit
              {s.habits === 1 ? "" : "s"}
            </title>
          </circle>
        ))}
      </svg>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block w-3 h-px"
            style={{ background: "var(--throughput-line)" }}
          />
          Tasks
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block w-3 h-px"
            style={{ background: "var(--throughput-faint)" }}
          />
          Tasks + habits
        </span>
      </div>
    </ChartCard>
  );
}

function GoalProgressList({ goals, projectsById }) {
  const active = useMemo(
    () => goals.filter((g) => g.status === "active"),
    [goals]
  );
  return (
    <ChartCard title="Goal progress">
      {active.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500 py-4">
          No active goals.
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((g) => {
            let pct = g.progress;
            if (pct === null) {
              let done = 0;
              let total = 0;
              for (const pid of g.projectIds) {
                const p = projectsById.get(pid);
                if (!p) continue;
                const s = countProject(p);
                done += s.done;
                total += s.total;
              }
              pct = total > 0 ? Math.round((done / total) * 100) : null;
            }
            return (
              <div key={g.id} className="flex items-center gap-3">
                <span
                  className="text-xs text-neutral-700 dark:text-neutral-200 truncate flex-1"
                  title={g.title}
                >
                  {g.title || "Untitled"}
                </span>
                <div className="w-32 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.06] overflow-hidden flex-none">
                  <div
                    className={[
                      "h-full transition-all duration-300",
                      pct === 100
                        ? "bg-emerald-500"
                        : "bg-rose-500 dark:bg-rose-400",
                    ].join(" ")}
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 w-10 text-right flex-none">
                  {pct === null ? "—" : `${pct}%`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="lg-card rounded-2xl p-5">
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200 mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ===== Legacy Goal view (kept verbatim — goals are not part of the
// project restructure; they may get a separate page later) =====

function LegacyGoalView({
  project,
  editingId,
  setEditingId,
  onUpdateTitle,
  onCycleType,
  onSetIcon,
  onDelete,
  onAddWeek,
  showConfirm,
  onDeleteWeek,
  onAddTask,
  onAddTaskChild,
  onToggleTask,
  onUpdateTask,
  onDeleteTask,
  projectAddRefSetter,
}) {
  const stats = useMemo(() => countProject(project), [project]);
  const editing = editingId === project.id;
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="relative flex-none mt-1">
              <button
                onClick={() => setIconPickerOpen((s) => !s)}
                className={[
                  "rounded-lg p-1 transition-all duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                  TYPE_ICON_COLOR[project.type] ||
                    TYPE_ICON_COLOR.project,
                ].join(" ")}
                aria-label="Choose icon"
              >
                <ProjectIconRender
                  name={project.icon}
                  className="w-7 h-7"
                />
              </button>
              {iconPickerOpen && (
                <IconPicker
                  value={project.icon}
                  iconColor={
                    TYPE_ICON_COLOR[project.type] ||
                    TYPE_ICON_COLOR.project
                  }
                  onSelect={(name) => {
                    onSetIcon(name);
                    setIconPickerOpen(false);
                  }}
                  onClose={() => setIconPickerOpen(false)}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <ProjectTitleEditor
                project={project}
                editing={editing}
                startEdit={() => setEditingId(project.id)}
                save={(v) => {
                  setEditingId(null);
                  onUpdateTitle(v);
                }}
                cancel={() => setEditingId(null)}
              />
              <div className="mt-1 flex items-center gap-2">
                <ProgressLabel done={stats.done} total={stats.total} />
                {stats.total > 0 && (
                  <span className="text-xs text-neutral-300 dark:text-neutral-700">
                    •
                  </span>
                )}
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {project.weeks.length} week
                  {project.weeks.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-none">
            <button
              onClick={onCycleType}
              className={[
                "text-[10px] uppercase tracking-wide px-2 py-1 rounded-full transition-all duration-150",
                TYPE_STYLES[project.type] || TYPE_STYLES.project,
              ].join(" ")}
            >
              {project.type}
            </button>
            <button
              onClick={() =>
                showConfirm({
                  title: `Delete ${project.type}?`,
                  message: `"${
                    project.title || "Untitled"
                  }" and all its tasks will be removed. This can't be undone from here, but ⌘Z still works.`,
                  confirmLabel: "Delete",
                  destructive: true,
                  onConfirm: onDelete,
                })
              }
              className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-all duration-150"
              aria-label="Delete project"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-10">
        {project.weeks.map((week, idx) => {
          const weekStart = project.startMonday
            ? addDays(new Date(project.startMonday + "T00:00:00"), 7 * idx)
            : null;
          return (
            <WeekRow
              key={week.id}
              week={week}
              weekIndex={idx}
              weekStart={weekStart}
              canDelete={project.weeks.length > 1}
              editingId={editingId}
              setEditingId={setEditingId}
              onDeleteWeek={() => onDeleteWeek(week.id)}
              onAddTask={(day, t) => onAddTask(week.id, day, t)}
              onAddTaskChild={(day, parentPath, t) =>
                onAddTaskChild(week.id, day, parentPath, t)
              }
              onToggleTask={(day, path) =>
                onToggleTask(week.id, day, path)
              }
              onUpdateTask={(day, path, t) =>
                onUpdateTask(week.id, day, path, t)
              }
              onDeleteTask={(day, path) =>
                onDeleteTask(week.id, day, path)
              }
              projectAddRefSetter={projectAddRefSetter}
              projectId={project.id}
              showConfirm={showConfirm}
            />
          );
        })}
      </div>

      <button
        onClick={onAddWeek}
        className="mt-8 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-white dark:hover:bg-neutral-900 border border-dashed border-black/15 dark:border-white/15 hover:border-black/30 dark:hover:border-white/30 transition-all duration-150"
      >
        <Plus className="w-4 h-4" />
        Add week
      </button>
    </div>
  );
}

// ===== Project plan / week views (new restructure for type === "project") =====

function ProjectHeaderBar({
  project,
  editingId,
  setEditingId,
  onUpdateTitle,
  onSetIcon,
  onDelete,
  showConfirm,
  compact,
}) {
  const editing = editingId === project.id;
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  return (
    <div
      className={[
        "flex items-start justify-between gap-4",
        compact ? "" : "mb-2",
      ].join(" ")}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className={["relative flex-none", compact ? "" : "mt-1"].join(" ")}>
          <button
            onClick={() => setIconPickerOpen((s) => !s)}
            className={[
              "rounded-lg p-1 transition-all duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
              TYPE_ICON_COLOR[project.type] || TYPE_ICON_COLOR.project,
            ].join(" ")}
            aria-label="Choose icon"
          >
            <ProjectIconRender
              name={project.icon}
              className={compact ? "w-5 h-5" : "w-7 h-7"}
            />
          </button>
          {iconPickerOpen && (
            <IconPicker
              value={project.icon}
              iconColor={
                TYPE_ICON_COLOR[project.type] || TYPE_ICON_COLOR.project
              }
              onSelect={(name) => {
                onSetIcon(name);
                setIconPickerOpen(false);
              }}
              onClose={() => setIconPickerOpen(false)}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <ProjectTitleEditor
            project={project}
            editing={editing}
            startEdit={() => setEditingId(project.id)}
            save={(v) => {
              setEditingId(null);
              onUpdateTitle(v);
            }}
            cancel={() => setEditingId(null)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 flex-none">
        <span
          className={[
            "text-[10px] uppercase tracking-wide px-2 py-1 rounded-full",
            TYPE_STYLES[project.type] || TYPE_STYLES.project,
          ].join(" ")}
        >
          {project.type}
        </span>
        {onDelete && (
          <button
            onClick={() =>
              showConfirm({
                title: `Delete ${project.type}?`,
                message: `"${
                  project.title || "Untitled"
                }" and all its tasks will be removed. ⌘Z still works.`,
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: onDelete,
              })
            }
            className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-all duration-150"
            aria-label="Delete project"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function MainGoalEditor({ value, onChange }) {
  const [draft, setDraft] = useState(value || "");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) {
      setDraft(value || "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, 140))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onChange(draft.trim());
            setEditing(false);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => {
          onChange(draft.trim());
          setEditing(false);
        }}
        placeholder="What's the main goal?"
        maxLength={140}
        className="w-full bg-transparent outline-none border-none text-base text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 py-0.5"
      />
    );
  }
  return (
    <div
      onClick={() => setEditing(true)}
      className={[
        "text-base cursor-text py-0.5",
        value
          ? "text-neutral-700 dark:text-neutral-200"
          : "text-neutral-400 dark:text-neutral-500 italic",
      ].join(" ")}
    >
      {value || "What's the main goal?"}
    </div>
  );
}

function DeadlinePicker({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  if (!value && !editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-dashed border-black/[0.15] dark:border-white/[0.15] text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:border-solid transition-all duration-150"
      >
        <Plus className="w-3.5 h-3.5" />
        Set deadline
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-2">
      <input
        type="date"
        value={value || ""}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={() => setEditing(false)}
        autoFocus={editing && !value}
        className="text-xs bg-white/40 dark:bg-white/[0.04] border border-black/[0.10] dark:border-white/[0.10] rounded-md px-2 py-1 text-neutral-700 dark:text-neutral-200 outline-none focus:border-[#007AFF]/40"
      />
      {value && (
        <button
          onClick={() => {
            onChange(null);
            setEditing(false);
          }}
          className="text-xs text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          aria-label="Clear deadline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

const TONE_CLASS = {
  red: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  amber:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  neutral:
    "bg-neutral-100/70 text-neutral-600 dark:bg-white/[0.05] dark:text-neutral-400",
  overdue: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-200",
};

function TimeRemainingPill({ deadline }) {
  if (!deadline) return null;
  const text = formatTimeRemaining(deadline);
  if (!text) return null;
  const tone = timeRemainingTone(deadline);
  return (
    <span
      className={[
        "text-xs px-2 py-0.5 rounded-full font-medium",
        TONE_CLASS[tone] || TONE_CLASS.neutral,
      ].join(" ")}
    >
      {text}
    </span>
  );
}

function MilestoneInput({ value, onChange, placeholder, accent }) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => {
    setDraft(value || "");
  }, [value]);
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.target.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value || "");
          e.target.blur();
        }
      }}
      onBlur={() => {
        if (draft !== (value || "")) onChange(draft);
      }}
      placeholder={placeholder}
      className={[
        "w-full bg-transparent outline-none border-none text-sm py-0.5",
        accent
          ? "text-[#007AFF] dark:text-blue-300 placeholder:text-[#007AFF]/50 dark:placeholder:text-blue-400/50"
          : "text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500",
      ].join(" ")}
    />
  );
}

function WeekGoalRow({
  weekStart,
  weekStartIso,
  weekIndex,
  totalWeeks,
  isToday,
  isPast,
  milestone,
  onSetMilestone,
  onOpen,
  doneCount,
  totalCount,
}) {
  const weekEnd = addDays(weekStart, 6);
  const label = totalWeeks
    ? `Week ${weekIndex + 1} of ${totalWeeks}`
    : `Week of ${formatShortDate(weekStart)}`;
  return (
    <div
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      className={[
        "rounded-2xl p-4 cursor-pointer transition-all duration-150",
        isToday ? "lg-today" : "lg-card",
        isPast ? "opacity-60 hover:opacity-80" : "hover:scale-[1.005]",
      ].join(" ")}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <h3
            className={[
              "text-sm font-semibold truncate",
              isToday
                ? "text-[#007AFF] dark:text-blue-400"
                : "text-neutral-800 dark:text-neutral-200",
            ].join(" ")}
          >
            {label}
          </h3>
          <span className="text-xs text-neutral-400 dark:text-neutral-500 flex-none">
            {formatShortDate(weekStart)} – {formatShortDate(weekEnd)}
          </span>
          {isToday && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#007AFF]/15 text-[#007AFF] dark:bg-[#007AFF]/25 dark:text-blue-300 flex-none">
              Today
            </span>
          )}
        </div>
        <span
          className={[
            "text-xs flex-none",
            totalCount === 0
              ? "text-neutral-400 dark:text-neutral-500"
              : doneCount === totalCount
              ? "text-emerald-600 dark:text-emerald-400 font-medium"
              : "text-neutral-500 dark:text-neutral-400",
          ].join(" ")}
        >
          {totalCount === 0
            ? "No tasks yet"
            : `${doneCount}/${totalCount} done`}
        </span>
      </div>
      <MilestoneInput
        value={milestone}
        onChange={(text) => onSetMilestone(weekStartIso, text)}
        placeholder="What's the milestone for this week?"
        accent={isToday}
      />
    </div>
  );
}

function BacklogSection({
  project,
  editingId,
  setEditingId,
  collapsedIds,
  toggleCollapsed,
  expandId,
  handlers,
  onAddBacklog,
  addRef,
}) {
  const backlogTasks = useMemo(
    () => (project.tasks || []).filter((t) => !t.date),
    [project.tasks]
  );
  const items = useMemo(
    () =>
      sortDoneToBottom(backlogTasks.map((t) => bindTask(t, [], handlers))),
    [backlogTasks, handlers]
  );
  const [adding, setAdding] = useState(false);
  if (backlogTasks.length === 0 && !adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 inline-flex items-center gap-1.5 transition-colors duration-150"
      >
        <Plus className="w-3.5 h-3.5" />
        Add an unscheduled task
      </button>
    );
  }
  return (
    <section className="lg-card rounded-2xl p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          Anytime
        </h3>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          Not scheduled to a week
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <TaskRow
            key={item.id}
            item={item}
            editingId={editingId}
            setEditingId={setEditingId}
            onToggle={item.onToggle}
            onUpdate={item.onUpdate}
            onDelete={item.onDelete}
            onAddChild={item.onAddChild}
            onAddSibling={item.onAddSibling}
            onReorder={item.onReorder}
            onSchedule={item.onSchedule}
            collapsedIds={collapsedIds}
            toggleCollapsed={toggleCollapsed}
            expandId={expandId}
          />
        ))}
      </ul>
      <div className="lg-add mt-3 rounded-xl px-4 py-3">
        <AddInput
          inputRef={addRef}
          onSubmit={(t) => {
            onAddBacklog(t);
            setAdding(false);
          }}
          placeholder="Add an unscheduled task"
        />
      </div>
    </section>
  );
}

function ProjectPlanView({
  project,
  setView,
  editingId,
  setEditingId,
  collapsedIds,
  toggleCollapsed,
  expandId,
  onUpdateTitle,
  onSetIcon,
  onDelete,
  onSetMainGoal,
  onSetDeadline,
  onSetMilestone,
  onAddBacklogTask,
  backlogHandlers,
  showConfirm,
  projectAddRefSetter,
}) {
  const [showPastWeeks, setShowPastWeeks] = useState(false);
  const stats = useMemo(
    () => countTasksDeep(project.tasks || []),
    [project.tasks]
  );

  const todayMon = useMemo(() => mondayOf(new Date()), []);
  const todayMonIso = isoDate(todayMon);
  const deadlineDate = project.deadline ? parseISO(project.deadline) : null;

  // Forward weeks: from this Monday → mondayOf(deadline) inclusive.
  // No deadline → just this current week.
  const forwardWeeks = useMemo(() => {
    if (!deadlineDate) {
      return [{ start: todayMon, isoStart: todayMonIso }];
    }
    return weeksFromTo(todayMon, deadlineDate);
  }, [deadlineDate, todayMon, todayMonIso]);

  // Past weeks: weeks earlier than today that have tasks or milestones.
  const pastWeeks = useMemo(() => {
    const dates = new Set();
    for (const t of project.tasks || []) {
      if (t.date) dates.add(t.date);
    }
    for (const k of Object.keys(project.milestones || {})) dates.add(k);
    const earliest = [...dates]
      .map(parseISO)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!earliest) return [];
    const earliestMon = mondayOf(earliest);
    if (earliestMon >= todayMon) return [];
    const out = weeksFromTo(earliestMon, addDays(todayMon, -7));
    return out;
  }, [project.tasks, project.milestones, todayMon]);

  const weekStats = useMemo(() => {
    const map = {};
    for (const t of project.tasks || []) {
      if (!t.date) continue;
      const d = parseISO(t.date);
      if (!d) continue;
      const k = isoDate(mondayOf(d));
      if (!map[k]) map[k] = { done: 0, total: 0 };
      const sub = countTasksDeep([t]);
      map[k].done += sub.done;
      map[k].total += sub.total;
    }
    return map;
  }, [project.tasks]);

  return (
    <div>
      <ProjectHeaderBar
        project={project}
        editingId={editingId}
        setEditingId={setEditingId}
        onUpdateTitle={onUpdateTitle}
        onSetIcon={onSetIcon}
        onDelete={onDelete}
        showConfirm={showConfirm}
      />

      <div className="ml-12 mb-6">
        <MainGoalEditor value={project.mainGoal} onChange={onSetMainGoal} />
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <DeadlinePicker
            value={project.deadline}
            onChange={onSetDeadline}
          />
          <TimeRemainingPill deadline={project.deadline} />
          {stats.total > 0 && (
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              · {stats.done}/{stats.total} tasks done
            </span>
          )}
        </div>
      </div>

      <BacklogSection
        project={project}
        editingId={editingId}
        setEditingId={setEditingId}
        collapsedIds={collapsedIds}
        toggleCollapsed={toggleCollapsed}
        expandId={expandId}
        handlers={backlogHandlers}
        onAddBacklog={onAddBacklogTask}
        addRef={
          projectAddRefSetter
            ? projectAddRefSetter(`${project.id}:backlog`)
            : null
        }
      />

      <div className="mt-6 space-y-3">
        {pastWeeks.length > 0 && (
          <button
            onClick={() => setShowPastWeeks((s) => !s)}
            className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 inline-flex items-center gap-1.5 transition-colors duration-150"
          >
            <Icon
              icon="solar:alt-arrow-right-bold-duotone"
              className={[
                "w-3.5 h-3.5 transition-transform duration-150",
                showPastWeeks ? "rotate-90" : "",
              ].join(" ")}
            />
            {showPastWeeks
              ? "Hide past weeks"
              : `Show ${pastWeeks.length} past week${
                  pastWeeks.length === 1 ? "" : "s"
                }`}
          </button>
        )}
        {showPastWeeks &&
          pastWeeks.map((w, idx) => {
            const wstats = weekStats[w.isoStart] || { done: 0, total: 0 };
            return (
              <WeekGoalRow
                key={w.isoStart}
                weekStart={w.start}
                weekStartIso={w.isoStart}
                weekIndex={idx}
                isToday={false}
                isPast
                milestone={project.milestones?.[w.isoStart] || ""}
                onSetMilestone={onSetMilestone}
                onOpen={() =>
                  setView({
                    type: "project",
                    id: project.id,
                    week: w.isoStart,
                  })
                }
                doneCount={wstats.done}
                totalCount={wstats.total}
              />
            );
          })}

        {forwardWeeks.map((w, idx) => {
          const wstats = weekStats[w.isoStart] || { done: 0, total: 0 };
          const isToday = w.isoStart === todayMonIso;
          return (
            <WeekGoalRow
              key={w.isoStart}
              weekStart={w.start}
              weekStartIso={w.isoStart}
              weekIndex={idx}
              totalWeeks={
                deadlineDate ? forwardWeeks.length : null
              }
              isToday={isToday}
              isPast={false}
              milestone={project.milestones?.[w.isoStart] || ""}
              onSetMilestone={onSetMilestone}
              onOpen={() =>
                setView({
                  type: "project",
                  id: project.id,
                  week: w.isoStart,
                })
              }
              doneCount={wstats.done}
              totalCount={wstats.total}
            />
          );
        })}

        {!project.deadline && (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 italic px-1">
            Set a deadline to see future weeks.
          </p>
        )}
      </div>
    </div>
  );
}

function ProjectWeekView({
  project,
  weekStartIso,
  setView,
  editingId,
  setEditingId,
  collapsedIds,
  toggleCollapsed,
  expandId,
  handlersForDate,
  onUpdateTitle,
  onSetIcon,
  onDelete,
  onSetMilestone,
  showConfirm,
  projectAddRefSetter,
  habits,
  habitCompletions,
  toggleHabitVirtual,
}) {
  const weekStart = useMemo(
    () => parseISO(weekStartIso) || mondayOf(new Date()),
    [weekStartIso]
  );
  const todayMonIso = isoDate(mondayOf(new Date()));
  const todayIso = isoDate(new Date());
  const isCurrentWeek = weekStartIso === todayMonIso;
  const milestone = project.milestones?.[weekStartIso] || "";

  const tasksByDay = useMemo(() => {
    const groups = {};
    for (const d of DAYS) groups[d.key] = [];
    for (const t of project.tasks || []) {
      if (!t.date) continue;
      const d = parseISO(t.date);
      if (!d) continue;
      const offset = daysBetween(weekStart, d);
      if (offset < 0 || offset >= 7) continue;
      const dayKey = DAY_KEY_BY_GETDAY[d.getDay()];
      groups[dayKey].push(t);
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return groups;
  }, [project.tasks, weekStart]);

  return (
    <div>
      <button
        onClick={() => setView({ type: "project", id: project.id })}
        className="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors duration-150 mb-4"
      >
        <Icon
          icon="solar:alt-arrow-left-bold-duotone"
          className="w-3.5 h-3.5"
        />
        Back to weekly goals
      </button>

      <ProjectHeaderBar
        project={project}
        editingId={editingId}
        setEditingId={setEditingId}
        onUpdateTitle={onUpdateTitle}
        onSetIcon={onSetIcon}
        onDelete={onDelete}
        showConfirm={showConfirm}
        compact
      />

      <div className="ml-9 mb-6 mt-2">
        <div className="flex items-baseline gap-3 mb-2">
          <span
            className={[
              "text-base font-semibold",
              isCurrentWeek
                ? "text-[#007AFF] dark:text-blue-400"
                : "text-neutral-700 dark:text-neutral-200",
            ].join(" ")}
          >
            {`Week of ${formatShortDate(weekStart)}`}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {formatShortDate(weekStart)} –{" "}
            {formatShortDate(addDays(weekStart, 6))}
          </span>
          {isCurrentWeek && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#007AFF]/15 text-[#007AFF] dark:bg-[#007AFF]/25 dark:text-blue-300">
              This week
            </span>
          )}
        </div>
        <MilestoneInput
          value={milestone}
          onChange={(text) => onSetMilestone(weekStartIso, text)}
          placeholder="What's the milestone for this week?"
        />
      </div>

      <DayGrid>
        {DAYS.map((d, dIdx) => {
          const dayDate = addDays(weekStart, dIdx);
          const dayIso = isoDate(dayDate);
          const isToday = dayIso === todayIso;
          const handlers = handlersForDate(dayIso);
          const realItems = tasksByDay[d.key].map((t) =>
            bindTask(t, [], handlers)
          );
          const taggedHabitIds = collectTaggedHabitIdsForDate(
            tasksByDay[d.key],
            dayIso
          );
          const virtualRows = buildVirtualHabitRows(
            habits || [],
            habitCompletions || [],
            dayIso,
            project.id,
            taggedHabitIds,
            toggleHabitVirtual
          );
          const items = [...virtualRows, ...realItems];
          return (
            <DayColumn
              key={d.key}
              short={d.short}
              date={dayDate}
              isToday={isToday}
              items={items}
              editingId={editingId}
              setEditingId={setEditingId}
              onAdd={(t) => handlers.addTopLevel(t)}
              addRef={
                projectAddRefSetter
                  ? projectAddRefSetter(`${project.id}:${dayIso}`)
                  : null
              }
            />
          );
        })}
      </DayGrid>
    </div>
  );
}

function ProjectTitleEditor({ project, editing, startEdit, save, cancel }) {
  const [draft, setDraft] = useState(project.title);
  const inputRef = useRef(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (editing) {
      setDraft(project.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.title]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            skipBlurRef.current = true;
            cancel();
          }
        }}
        onBlur={() => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          save(draft);
        }}
        placeholder="Untitled"
        className="w-full bg-transparent outline-none border-none text-2xl font-semibold text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
      />
    );
  }

  return (
    <h1
      onClick={startEdit}
      className={[
        "text-2xl font-semibold cursor-text truncate",
        project.title
          ? "text-neutral-900 dark:text-neutral-100"
          : "text-neutral-400 dark:text-neutral-600 italic",
      ].join(" ")}
    >
      {project.title || "Untitled"}
    </h1>
  );
}

function ConfirmDialog({ state, onClose }) {
  const open = !!state;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        state.onConfirm?.();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, state, onClose]);

  if (!open) return null;
  const destructive = !!state.destructive;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-150"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative lg-card rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl"
      >
        <h2
          id="confirm-title"
          className="text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {state.title || "Are you sure?"}
        </h2>
        {state.message && (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {state.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.05] transition-colors duration-150"
          >
            {state.cancelLabel || "Cancel"}
          </button>
          <button
            onClick={() => {
              state.onConfirm?.();
              onClose();
            }}
            className={[
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-150",
              destructive
                ? "bg-red-500 text-white hover:bg-red-600 dark:bg-red-500/90 dark:hover:bg-red-500"
                : "bg-[#007AFF] text-white hover:bg-[#0064d1]",
            ].join(" ")}
            autoFocus
          >
            {state.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IconPicker({ value, iconColor, onSelect, onClose }) {
  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="absolute z-40 top-full left-0 mt-2 rounded-xl p-3 grid grid-cols-6 gap-1 w-[280px] max-h-[300px] overflow-y-auto bg-white dark:bg-neutral-900 border border-black/10 dark:border-white/10 shadow-xl"
      >
        {PROJECT_ICONS.map((name) => {
          const selected = value === name;
          return (
            <button
              key={name}
              onClick={() => onSelect(name)}
              className={[
                "w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-150",
                selected
                  ? "bg-[#007AFF]/15 ring-1 ring-[#007AFF]/30"
                  : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
              ].join(" ")}
              aria-label={name}
              aria-pressed={selected}
            >
              <ProjectIconRender
                name={name}
                className={["w-5 h-5", iconColor].join(" ")}
              />
            </button>
          );
        })}
      </div>
    </>
  );
}

// Full-tree detail popup for a single weekly task. Renders a TaskRow
// without `topLevelOnly`, so steps and sub-steps appear with the same
// editing affordances as Today.
function TaskDetailModal({
  item,
  editingId,
  setEditingId,
  collapsedIds,
  toggleCollapsed,
  expandId,
  onClose,
}) {
  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="lg-modal rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold">Task</h3>
          <button
            onClick={onClose}
            className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Close
          </button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
          Click any title to rename. Steps and sub-steps editable
          like Today.
        </p>
        <ul>
          <TaskRow
            item={item}
            editingId={editingId}
            setEditingId={setEditingId}
            onToggle={item.onToggle}
            onUpdate={item.onUpdate}
            onDelete={() => {
              item.onDelete();
              onClose();
            }}
            onAddChild={item.onAddChild}
            onAddSibling={item.onAddSibling}
            onReorder={item.onReorder}
            onSchedule={item.onSchedule}
            collapsedIds={collapsedIds}
            toggleCollapsed={toggleCollapsed}
            expandId={expandId}
          />
        </ul>
      </div>
    </div>
  );
}

function ColorPicker({ value, onPick, onClose }) {
  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute z-40 top-full right-0 mt-1.5 rounded-xl p-2.5 grid grid-cols-4 gap-1 w-[176px] bg-white dark:bg-neutral-900 border border-black/10 dark:border-white/10 shadow-xl">
        <button
          onClick={() => onPick(null)}
          className={[
            "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-150",
            !value
              ? "bg-[#007AFF]/15 ring-1 ring-[#007AFF]/30"
              : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
          ].join(" ")}
          aria-label="No color"
          aria-pressed={!value}
        >
          <Icon
            icon="solar:close-circle-linear"
            className="w-4 h-4 text-neutral-400 dark:text-neutral-500"
          />
        </button>
        {TASK_COLORS.map((c) => {
          const selected = value === c.id;
          return (
            <button
              key={c.id}
              onClick={() => onPick(c.id)}
              className={[
                "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-150",
                selected
                  ? "bg-[#007AFF]/15 ring-1 ring-[#007AFF]/30"
                  : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
              ].join(" ")}
              aria-label={c.label}
              aria-pressed={selected}
            >
              <span
                className="block w-4 h-4 rounded-full ring-1 ring-black/15 dark:ring-white/15"
                style={{ background: c.hex }}
              />
            </button>
          );
        })}
      </div>
    </>
  );
}

function WeekRow({
  week,
  weekIndex,
  weekStart,
  canDelete,
  editingId,
  setEditingId,
  onDeleteWeek,
  onAddTask,
  onAddTaskChild,
  onToggleTask,
  onUpdateTask,
  onDeleteTask,
  projectAddRefSetter,
  projectId,
  showConfirm,
}) {
  const stats = useMemo(() => countWeek(week), [week]);
  const subtitle =
    weekStart &&
    `${formatShortDate(weekStart)} – ${formatShortDate(addDays(weekStart, 6))}`;
  return (
    <section>
      <div className="group flex items-baseline justify-between mb-4">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-medium">Week {weekIndex + 1}</h3>
          {subtitle && (
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {subtitle}
            </span>
          )}
          <ProgressLabel done={stats.done} total={stats.total} />
        </div>
        {canDelete && (
          <button
            onClick={() =>
              showConfirm({
                title: `Delete Week ${weekIndex + 1}?`,
                message:
                  "Tasks scheduled in this week will be removed. ⌘Z will undo it.",
                confirmLabel: "Delete week",
                destructive: true,
                onConfirm: onDeleteWeek,
              })
            }
            className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-600 dark:hover:text-red-400 transition-all duration-150 inline-flex items-center gap-1 text-xs"
            aria-label={`Delete week ${weekIndex + 1}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete week
          </button>
        )}
      </div>

      <DayGrid compact>
        {DAYS.map((d, dIdx) => {
          const rawItems = week[d.key] || [];
          const handlers = {
            toggle: (path) => onToggleTask(d.key, path),
            update: (path, title) => onUpdateTask(d.key, path, title),
            delete: (path) => onDeleteTask(d.key, path),
            addChild: (parentPath, title) =>
              onAddTaskChild(d.key, parentPath, title),
          };
          const items = sortDoneToBottom(
            rawItems.map((t) => bindTask(t, [], handlers))
          );
          const refKey = `${projectId}:${week.id}:${d.key}`;
          const date = weekStart ? addDays(weekStart, dIdx) : null;
          return (
            <DayColumn
              key={d.key}
              short={d.short}
              date={date}
              items={items}
              editingId={editingId}
              setEditingId={setEditingId}
              onAdd={(t) => onAddTask(d.key, t)}
              addRef={projectAddRefSetter(refKey)}
              compact
            />
          );
        })}
      </DayGrid>
    </section>
  );
}

// ===== Day grid + column =====

function DayGrid({ children, compact }) {
  return (
    <div
      className={[
        "grid",
        compact
          ? "grid-cols-[repeat(7,minmax(160px,1fr))] gap-4"
          : "grid-cols-[repeat(4,minmax(220px,1fr))] gap-4",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function DayColumn({
  short,
  date,
  isToday,
  items,
  editingId,
  setEditingId,
  onAdd,
  addRef,
  onOpenDetail,
  compact,
}) {
  const dayProgress = countDirect(items);
  return (
    <div
      className={[
        "rounded-2xl flex flex-col transition-all duration-150",
        compact ? "p-4 gap-3 min-h-[220px]" : "p-6 gap-5 min-h-[300px]",
        isToday ? "lg-today" : "lg-card",
      ].join(" ")}
    >
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className={[
              "font-semibold uppercase tracking-wide",
              compact ? "text-xs" : "text-sm",
              isToday
                ? "text-[#007AFF] dark:text-blue-400"
                : "text-neutral-700 dark:text-neutral-200",
            ].join(" ")}
          >
            {short}
          </span>
          {date && (
            <span
              className={[
                "text-neutral-400 dark:text-neutral-500",
                compact ? "text-[10px]" : "text-xs",
              ].join(" ")}
            >
              {date.getDate()}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <span
            className={[
              "text-[10px] flex-none",
              dayProgress.done === dayProgress.total
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-neutral-400 dark:text-neutral-500",
            ].join(" ")}
          >
            {dayProgress.done}/{dayProgress.total}
          </span>
        )}
      </div>

      <ul
        className={[
          "flex-1",
          compact ? "space-y-1.5" : "space-y-2",
        ].join(" ")}
      >
        <DraggableTaskList
          items={items}
          renderItem={({
            item,
            translateY,
            isLifting,
            onRowMouseDown,
            registerRowRef,
          }) => (
            <TaskRow
              key={item.id}
              item={item}
              editingId={editingId}
              setEditingId={setEditingId}
              onToggle={item.onToggle}
              onUpdate={item.onUpdate}
              onDelete={item.onDelete}
              onAddSibling={item.onAddSibling}
              onReorder={item.onReorder}
              onSchedule={item.onSchedule}
              onOpenDetail={onOpenDetail}
              onRowMouseDown={onRowMouseDown}
              registerRowRef={registerRowRef}
              translateY={translateY}
              isLifting={isLifting}
              compact
              topLevelOnly
            />
          )}
        />
      </ul>

      <AddInput
        inputRef={addRef}
        onSubmit={onAdd}
        placeholder={compact ? "+ task" : "Add a task…"}
        compact={compact}
      />
    </div>
  );
}

// ===== Reusable bits =====

function PageHeader({ Icon, iconColor, title, subtitle, right }) {
  return (
    <div className="mb-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && (
          <Icon
            className={["w-6 h-6 flex-none", iconColor].join(" ")}
          />
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {right && <div className="flex-none">{right}</div>}
    </div>
  );
}

function Card({ children }) {
  return (
    <div className="lg-card rounded-2xl p-7 transition-colors duration-150">
      {children}
    </div>
  );
}

function ProgressLabel({ done, total }) {
  if (!total) return null;
  const complete = done === total;
  return (
    <span
      className={[
        "text-xs",
        complete
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-neutral-500 dark:text-neutral-400",
      ].join(" ")}
    >
      {done}/{total} done
    </span>
  );
}

const DEPTH_BORDER = [
  "border-black/35 dark:border-white/35",
  "border-blue-400/65 dark:border-blue-400/55",
  "border-violet-400/65 dark:border-violet-400/55",
  "border-amber-400/65 dark:border-amber-400/55",
];

const TASK_SIZES = {
  full: {
    row: "px-3.5 py-3",
    text: "text-sm",
    check: "w-5 h-5",
    trash: "w-4 h-4",
    plus: "w-4 h-4",
  },
  medium: {
    row: "px-3 py-2",
    text: "text-[13px]",
    check: "w-[18px] h-[18px]",
    trash: "w-3.5 h-3.5",
    plus: "w-3.5 h-3.5",
  },
  compact: {
    row: "px-2.5 py-1.5",
    text: "text-xs",
    check: "w-4 h-4",
    trash: "w-3 h-3",
    plus: "w-3.5 h-3.5",
  },
};

function sizeKindFor(depth, compact) {
  if (compact) return "compact";
  if (depth === 0) return "full";
  if (depth === 1) return "medium";
  return "compact";
}

const DEPTH_ACCENT = [
  "text-[#007AFF]",
  "text-blue-500 dark:text-blue-400",
  "text-violet-500 dark:text-violet-400",
  "text-amber-500 dark:text-amber-400",
];

let _audioCtx = null;
function playDing() {
  if (typeof window === "undefined") return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!_audioCtx) _audioCtx = new Ctx();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    // Inharmonic bell partials — frequency ratios, gain, and decay (seconds).
    // The non-integer ratios are what makes it read as a bell rather than a tone.
    const partials = [
      { ratio: 1.0, gain: 0.45, decay: 1.4 },
      { ratio: 2.0, gain: 0.32, decay: 0.95 },
      { ratio: 2.756, gain: 0.22, decay: 0.7 },
      { ratio: 5.404, gain: 0.13, decay: 0.5 },
      { ratio: 8.932, gain: 0.06, decay: 0.32 },
    ];
    const fundamental = 880; // A5

    // Master bus with a gentle low-shelf so the bell has body, not just brightness.
    const master = ctx.createGain();
    master.gain.value = 0.32;
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 320;
    lowShelf.gain.value = 4;
    master.connect(lowShelf);
    lowShelf.connect(ctx.destination);

    for (const p of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      const freq = fundamental * p.ratio;
      // Subtle pitch settle — the partial drops by 0.3% over 80ms,
      // which gives the strike a brief shimmer instead of a flat tone.
      osc.frequency.setValueAtTime(freq * 1.003, now);
      osc.frequency.exponentialRampToValueAtTime(freq, now + 0.08);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(p.gain, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
      osc.connect(g);
      g.connect(master);
      osc.start(now);
      osc.stop(now + p.decay + 0.05);
    }
  } catch {
    // ignore audio errors
  }
}

function Checkbox({ done, onClick, compact, sizeClass, depth = 0 }) {
  const size = sizeClass || (compact ? "w-4 h-4" : "w-5 h-5");
  const border = DEPTH_BORDER[depth] || DEPTH_BORDER[DEPTH_BORDER.length - 1];
  const accent = DEPTH_ACCENT[depth] || DEPTH_ACCENT[DEPTH_ACCENT.length - 1];

  const handleClick = () => {
    if (!done) playDing();
    onClick();
  };

  return (
    <button
      onClick={handleClick}
      role="checkbox"
      aria-checked={done}
      className={["relative flex-none", size].join(" ")}
    >
      <span
        className={[
          "absolute inset-0 rounded-full border-2 bg-transparent transition-all duration-300 ease-out",
          border,
          done ? "opacity-0 scale-50" : "opacity-100 scale-100",
        ].join(" ")}
      />
      <Icon
        icon="solar:check-circle-bold-duotone"
        className={[
          "absolute inset-0 transition-all duration-300 ease-out",
          accent,
          done ? "opacity-100 scale-100" : "opacity-0 scale-75",
        ].join(" ")}
      />
    </button>
  );
}

const DEPTH_TINT = [
  "text-neutral-900 dark:text-neutral-100",
  "text-blue-700 dark:text-blue-300",
  "text-violet-700 dark:text-violet-300",
  "text-amber-700 dark:text-amber-300",
];

function InlineTitle({
  title,
  done,
  editing,
  onStartEdit,
  onSave,
  onCancel,
  onCommitNext,
  compact,
  textClass,
  depth = 0,
}) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    // Focus retries — the input may mount one frame after editingId
    // changes (Convex query reactivity), and there are paths where
    // the row remounts mid-flight. Try multiple times until focus
    // actually lands.
    const delays = [0, 30, 100, 250];
    const timers = delays.map((delay) =>
      setTimeout(() => {
        if (document.activeElement !== inputRef.current) {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      }, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [editing, title]);

  const sizeClass = textClass || (compact ? "text-xs" : "text-sm");
  const tint = DEPTH_TINT[depth] || DEPTH_TINT[DEPTH_TINT.length - 1];

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const trimmed = draft.trim();
            if (trimmed && onCommitNext) {
              onSave(draft);
              onCommitNext();
            } else {
              onSave(draft);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            skipBlurRef.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          onSave(draft);
        }}
        className={[
          "flex-1 min-w-0 bg-transparent outline-none border-none px-0 py-0",
          sizeClass,
          tint,
        ].join(" ")}
      />
    );
  }

  return (
    <span
      onClick={onStartEdit}
      className={[
        "flex-1 min-w-0 cursor-text truncate",
        sizeClass,
        done ? "line-through text-neutral-400 dark:text-neutral-500" : tint,
      ].join(" ")}
      title={title}
    >
      {/* Empty span needs *some* content so the click target has
          area when the title is blank. A non-breaking space is
          invisible but takes up baseline width. */}
      {title || " "}
    </span>
  );
}

function SubstepInput({ onSubmit, onCancel, compact, textClass }) {
  const [value, setValue] = useState("");
  const ref = useRef(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim()) onSubmit(value);
          else onCancel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          skipBlurRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (skipBlurRef.current) {
          skipBlurRef.current = false;
          return;
        }
        if (value.trim()) onSubmit(value);
        else onCancel();
      }}
      placeholder="Add a substep…"
      className={[
        "w-full bg-transparent outline-none border-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500 py-1 text-neutral-900 dark:text-neutral-100",
        textClass || (compact ? "text-xs" : "text-sm"),
      ].join(" ")}
    />
  );
}

function AddInput({ inputRef, placeholder = "Add a task…", onSubmit, compact }) {
  const [value, setValue] = useState("");
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim()) {
            onSubmit(value);
            setValue("");
          }
        }
      }}
      placeholder={placeholder}
      className={[
        "w-full bg-transparent outline-none border-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600 py-1 text-neutral-900 dark:text-neutral-100",
        compact ? "text-xs" : "text-sm",
      ].join(" ")}
    />
  );
}

// Virtual habit row — renders alongside real tasks in Today / project
// Daily Calendar. The row is read-only: only the checkbox is interactive.
function VirtualHabitRow({ item, compact, depth = 0 }) {
  const sizeKind = sizeKindFor(depth, compact);
  const sz = TASK_SIZES[sizeKind];
  return (
    <li className={!compact && depth === 0 ? "mb-2" : ""}>
      <div
        className={[
          "group flex items-center gap-2.5 rounded-lg relative overflow-hidden",
          sz.row,
          item.done ? "lg-task-done opacity-60" : "lg-task",
        ].join(" ")}
      >
        <span
          className="absolute left-0 top-0 bottom-0 w-[3px] bg-rose-500 dark:bg-rose-400"
          aria-hidden="true"
        />
        <Checkbox
          done={item.done}
          onClick={item.onToggle}
          sizeClass={sz.check}
          depth={0}
        />
        <HabitIcon
          className={[
            sz.trash,
            "flex-none text-rose-500 dark:text-rose-400",
          ].join(" ")}
        />
        <span
          className={[
            "flex-1 min-w-0 truncate",
            sz.text,
            item.done
              ? "line-through text-neutral-400 dark:text-neutral-500"
              : "text-neutral-800 dark:text-neutral-200",
          ].join(" ")}
          title={`${item.title} · ${cadenceLabel(item.cadence)}`}
        >
          {item.title}
        </span>
        <span
          className={[
            "text-[10px] uppercase tracking-wide flex-none px-1.5 py-0.5 rounded-full",
            "bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300",
          ].join(" ")}
        >
          habit
        </span>
      </div>
    </li>
  );
}

// Schedules a backlog task to a real date via the native date picker.
// Hidden <input type="date"> + visible icon-button trigger that calls
// .showPicker() (Chromium/WebKit ≥2022, Firefox ≥101). Falls back to .click().
function ScheduleTaskButton({ onSchedule, iconClass }) {
  const inputRef = useRef(null);
  return (
    <span className="relative flex-none opacity-0 group-hover:opacity-100 transition-all duration-150">
      <input
        ref={inputRef}
        type="date"
        onChange={(e) => {
          const v = e.target.value;
          if (v) onSchedule(v);
          if (e.target) e.target.value = "";
        }}
        className="absolute inset-0 opacity-0 pointer-events-none w-0 h-0"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={() => {
          const el = inputRef.current;
          if (!el) return;
          if (typeof el.showPicker === "function") {
            try {
              el.showPicker();
              return;
            } catch {
              // some Safari versions throw; fall through to click
            }
          }
          el.click();
        }}
        className="text-neutral-400 hover:text-[#007AFF] dark:text-neutral-500 dark:hover:text-blue-400 transition-colors duration-150"
        aria-label="Schedule"
      >
        <Icon icon="solar:calendar-add-bold-duotone" className={iconClass} />
      </button>
    </span>
  );
}

// Drag-and-drop reordering with smooth lift-and-shift. Three phases:
//
//   active   — cursor is moving; dragged row tracks deltaY with no
//              transition, sibling rows use a 220ms transition to
//              shift into place.
//   pre-settle — cursor released, optimistic mutation has reordered
//              the items array. The dragged row's transform is set
//              to a FLIP-invert offset so its visible position stays
//              put while the DOM reshuffles. Transitions disabled.
//   settling — next frame: transitions re-enabled, dragged row's
//              transform set to 0. The browser animates it from the
//              FLIP offset to 0, which is the "smooth settle" the
//              user perceives.
//
// 4-pixel movement threshold separates click-to-edit from drag, and
// the trailing click is swallowed so the title doesn't auto-edit.
function DraggableTaskList({ items, renderItem }) {
  const [drag, setDrag] = useState(null);
  // drag = null
  //      | active:     { phase:"active", itemId, fromIndex, targetIndex, deltaY, height }
  //      | pre-settle: { phase:"pre-settle", itemId, deltaY }
  //      | settling:   { phase:"settling", itemId }
  const refs = useRef({});

  const startDrag = (e, item, fromIndex) => {
    if (e.button !== 0 || !item.onMoveTo) return;
    if (
      e.target.closest(
        'input, textarea, button, [contenteditable], select'
      )
    ) {
      return;
    }
    const rowEl = refs.current[item.id];
    if (!rowEl) return;
    // Stop the mousedown from bubbling to an outer DraggableTaskList's
    // handler. Without this, dragging a step also triggered the
    // parent task's drag because the parent <li>'s onMouseDown also
    // received the bubbled event.
    e.stopPropagation();
    const rowHeight = rowEl.offsetHeight;
    const startY = e.clientY;
    let dragging = false;
    let didDrag = false;
    let lastTarget = fromIndex;
    let lastDeltaY = 0;

    const onMove = (me) => {
      const deltaY = me.clientY - startY;
      if (!dragging) {
        if (Math.abs(deltaY) < 4) return;
        dragging = true;
        didDrag = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          // ignore
        }
      }
      let targetIdx = fromIndex;
      for (let i = 0; i < items.length; i++) {
        if (i === fromIndex) continue;
        const el = refs.current[items[i].id];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (i < fromIndex && me.clientY < mid) {
          targetIdx = i;
          break;
        }
        if (i > fromIndex && me.clientY > mid) {
          targetIdx = i;
        }
      }
      lastTarget = targetIdx;
      lastDeltaY = deltaY;
      setDrag({
        phase: "active",
        itemId: item.id,
        fromIndex,
        targetIndex: targetIdx,
        deltaY,
        height: rowHeight,
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (didDrag) {
        const swallow = (ce) => {
          ce.preventDefault();
          ce.stopPropagation();
        };
        document.addEventListener("click", swallow, {
          capture: true,
          once: true,
        });
        setTimeout(() => {
          document.removeEventListener("click", swallow, true);
        }, 80);
        if (lastTarget !== fromIndex) {
          // Phase 1: optimistic reorder + FLIP-invert transform so
          // the dragged row visually stays put while the DOM moves.
          // Transitions are off (lifting=true) so the browser snaps.
          const positionOffset = (lastTarget - fromIndex) * rowHeight;
          item.onMoveTo(lastTarget);
          setDrag({
            phase: "pre-settle",
            itemId: item.id,
            deltaY: lastDeltaY - positionOffset,
          });
          // Phase 2: next paint, drop the offset. Transitions are
          // back on, so the browser animates from the FLIP offset
          // to 0 — the actual smooth settle the user sees.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setDrag({ phase: "settling", itemId: item.id });
              setTimeout(() => setDrag(null), 240);
            });
          });
          return;
        }
      }
      setDrag(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return items.map((item, idx) => {
    let dy = 0;
    let lifting = false;
    if (drag) {
      if (drag.phase === "active") {
        if (drag.itemId === item.id) {
          dy = drag.deltaY;
          lifting = true;
        } else if (
          drag.fromIndex < drag.targetIndex &&
          idx > drag.fromIndex &&
          idx <= drag.targetIndex
        ) {
          dy = -drag.height;
        } else if (
          drag.fromIndex > drag.targetIndex &&
          idx >= drag.targetIndex &&
          idx < drag.fromIndex
        ) {
          dy = drag.height;
        }
      } else if (drag.phase === "pre-settle") {
        // Items were reordered. Disable transitions everywhere so
        // the FLIP snaps; only the moved row needs an offset.
        lifting = true;
        if (drag.itemId === item.id) dy = drag.deltaY;
      } else if (drag.phase === "settling") {
        // Transitions back on, transforms all 0. The moved row
        // animates from its previous (FLIP) offset to 0.
        // Other rows already settled.
      }
    }
    return renderItem({
      item,
      idx,
      translateY: dy,
      isLifting: lifting,
      onRowMouseDown: (e) => startDrag(e, item, idx),
      registerRowRef: (el) => {
        if (el) refs.current[item.id] = el;
        else delete refs.current[item.id];
      },
    });
  });
}

function TaskRow({
  item,
  depth = 0,
  editingId,
  setEditingId,
  onToggle,
  onUpdate,
  onDelete,
  onAddChild,
  onAddSibling,
  onReorder,
  onSchedule,
  onRowMouseDown,
  registerRowRef,
  translateY = 0,
  isLifting = false,
  onOpenDetail,
  compact,
  topLevelOnly = false,
  collapsedIds,
  toggleCollapsed,
  expandId,
}) {
  // Virtual habit row branch — read-only display + checkbox toggle.
  // Synthetic id (`habit:${habitId}:${date}`) stops here: no rename, no
  // delete, no reorder, no schedule, no children. Toggle goes through
  // item.onToggle (toggleHabitVirtual), not the path-based mutators.
  if (item?.kind === "habit") {
    return <VirtualHabitRow item={item} compact={compact} depth={depth} />;
  }
  const editing = editingId === item.id;
  const [addingChild, setAddingChild] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const liRef = useRef(null);
  useEffect(() => {
    if (registerRowRef) registerRowRef(liRef.current);
    return () => {
      if (registerRowRef) registerRowRef(null);
    };
  }, [registerRowRef]);
  const hasChildren =
    !topLevelOnly && item.children && item.children.length > 0;
  const canAddChild = !topLevelOnly && depth < 2 && !!onAddChild;
  const isCollapsed = !!(collapsedIds && collapsedIds.has(item.id));
  const sizeKind = sizeKindFor(depth, compact);
  const sz = TASK_SIZES[sizeKind];
  const childSizeKind = sizeKindFor(depth + 1, compact);
  const childSz = TASK_SIZES[childSizeKind];
  const childrenVisible = hasChildren && !isCollapsed;
  const showsChildren = childrenVisible || addingChild;
  const colorHex = item.color ? TASK_COLOR_HEX[item.color] : null;
  // In weekly-grid mode (topLevelOnly), show a count of completed leaf
  // steps next to the row so the user can see progress without
  // expanding. Steps with sub-steps contribute their sub-step count;
  // steps without sub-steps count as a single leaf.
  const leafCount = useMemo(() => {
    if (!topLevelOnly) return null;
    const c = countLeafSteps(item);
    return c.total > 0 ? c : null;
  }, [item, topLevelOnly]);
  // Only the TodayView's top-level rows control their own gap.
  // Compact day-column tasks use the parent <ul>'s space-y for tight
  // stacking. Tasks with visible steps get a balanced margin both
  // above and below so they read as a card with breathing room.
  const liSpacing =
    !compact && depth === 0 ? (showsChildren ? "mb-5" : "mb-2") : "";
  const showChevron = !!toggleCollapsed && hasChildren;
  const reserveChevron = !!toggleCollapsed && !compact;

  // Apply transform/transition styles ONLY when the row is actually
  // moving (translated or lifted). At rest, leave inline style empty
  // so the browser doesn't promote every row to its own GPU
  // compositor layer — that promotion combined with backdrop-filter
  // was causing the brief shrink-and-expand flash across every row
  // whenever a drag began.
  const isMoving = translateY !== 0 || isLifting;
  const rowStyle = {};
  if (isMoving) {
    rowStyle.transform = `translate3d(0,${translateY}px,0)${isLifting ? " scale(1.015)" : ""}`;
    rowStyle.transition = isLifting
      ? "none"
      : "transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1)";
    rowStyle.willChange = "transform";
  }
  if (isLifting) {
    rowStyle.zIndex = 50;
    rowStyle.position = "relative";
    rowStyle.boxShadow = "0 14px 32px rgba(0,0,0,0.18)";
    rowStyle.userSelect = "none";
  }
  const colorBg = colorHex
    ? { background: `${colorHex}22` }
    : undefined;
  return (
    <li
      ref={liRef}
      className={[
        "transition-[margin-bottom] duration-200 ease-out",
        liSpacing,
        onRowMouseDown
          ? isLifting
            ? "cursor-grabbing"
            : "cursor-grab"
          : "",
      ].join(" ")}
      style={isMoving || isLifting ? rowStyle : undefined}
      onMouseDown={onRowMouseDown}
    >
      <div
        className={[
          "group flex items-center gap-2.5 rounded-lg relative",
          sz.row,
          item.done ? "lg-task-done opacity-60" : "lg-task",
        ].join(" ")}
        style={colorBg}
      >
        {showChevron ? (
          <button
            onClick={() => toggleCollapsed(item.id)}
            className="flex-none w-4 h-4 flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors duration-150"
            aria-label={isCollapsed ? "Expand steps" : "Collapse steps"}
          >
            <Icon
              icon="solar:alt-arrow-right-bold-duotone"
              className={[
                "w-3.5 h-3.5 transition-transform duration-150",
                isCollapsed ? "" : "rotate-90",
              ].join(" ")}
            />
          </button>
        ) : reserveChevron ? (
          <span className="flex-none w-4 h-4" />
        ) : null}
        <Checkbox
          done={item.done}
          onClick={onToggle}
          sizeClass={sz.check}
          depth={depth}
        />
        <InlineTitle
          title={item.title}
          done={item.done}
          editing={editing}
          onStartEdit={
            onOpenDetail
              ? () => onOpenDetail(item)
              : () => setEditingId(item.id)
          }
          onSave={(v) => {
            setEditingId(null);
            if (v.trim() !== item.title) onUpdate(v);
          }}
          onCancel={() => setEditingId(null)}
          onCommitNext={
            onAddSibling
              ? async () => {
                  const newId = await onAddSibling();
                  if (newId) setEditingId(newId);
                }
              : undefined
          }
          textClass={sz.text}
          depth={depth}
        />
        {onReorder && !onRowMouseDown && (
          <div className="flex-none flex items-center -mr-1 opacity-0 group-hover:opacity-100 transition-all duration-150">
            <button
              onClick={() => onReorder(-1)}
              className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200 transition-colors duration-150 px-0.5"
              aria-label="Move up"
            >
              <Icon
                icon="solar:alt-arrow-up-bold-duotone"
                className={sz.trash}
              />
            </button>
            <button
              onClick={() => onReorder(1)}
              className="text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200 transition-colors duration-150 px-0.5"
              aria-label="Move down"
            >
              <Icon
                icon="solar:alt-arrow-down-bold-duotone"
                className={sz.trash}
              />
            </button>
          </div>
        )}
        {onSchedule && !item.date && (
          <ScheduleTaskButton
            onSchedule={onSchedule}
            iconClass={sz.trash}
          />
        )}
        {canAddChild && !addingChild && (
          <button
            onClick={() => {
              setAddingChild(true);
              if (expandId) expandId(item.id);
            }}
            className="flex-none opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200 transition-all duration-150"
            aria-label="Add substep"
          >
            <Plus className={sz.plus} />
          </button>
        )}
        {/* Count badge gets a fixed-width column so the digits sit at
            the same horizontal offset on every row, regardless of how
            long the title is. */}
        {topLevelOnly && (
          <span
            className={[
              "flex-none w-10 text-right text-[10px] tabular-nums",
              leafCount && leafCount.done === leafCount.total
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-neutral-400 dark:text-neutral-500",
            ].join(" ")}
          >
            {leafCount ? `${leafCount.done}/${leafCount.total}` : ""}
          </span>
        )}
        {item.onSetColor && (
          <div className="flex-none relative">
            <button
              onClick={() => setColorPickerOpen((s) => !s)}
              className="flex-none opacity-0 group-hover:opacity-100 transition-opacity duration-150"
              aria-label="Color"
            >
              <span
                className="block w-3.5 h-3.5 rounded-full ring-1 ring-black/15 dark:ring-white/15"
                style={{
                  background: colorHex || "transparent",
                }}
              />
            </button>
            {colorPickerOpen && (
              <ColorPicker
                value={item.color}
                onPick={(c) => {
                  item.onSetColor(c);
                  setColorPickerOpen(false);
                }}
                onClose={() => setColorPickerOpen(false)}
              />
            )}
          </div>
        )}
        <button
          onClick={onDelete}
          className="flex-none opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400 transition-all duration-150"
          aria-label="Delete"
        >
          <Trash2 className={sz.trash} />
        </button>
      </div>

      <div
        className={[
          "grid transition-all duration-200 ease-out",
          showsChildren
            ? "grid-rows-[1fr] opacity-100 mt-1.5"
            : "grid-rows-[0fr] opacity-0 mt-0",
        ].join(" ")}
      >
        <div className="overflow-hidden min-h-0">
          {(hasChildren || addingChild) && (
            <ul
              className={[
                "space-y-1.5",
                sizeKind === "compact" ? "pl-10" : "pl-12",
              ].join(" ")}
            >
              <DraggableTaskList
                items={item.children || []}
                renderItem={({
                  item: child,
                  translateY: childTy,
                  isLifting: childLifting,
                  onRowMouseDown: childMouseDown,
                  registerRowRef: childRegisterRef,
                }) => (
                  <TaskRow
                    key={child.id}
                    item={child}
                    depth={depth + 1}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    onToggle={child.onToggle}
                    onUpdate={child.onUpdate}
                    onDelete={child.onDelete}
                    onAddChild={child.onAddChild}
                    onAddSibling={child.onAddSibling}
                    onReorder={child.onReorder}
                    onSchedule={child.onSchedule}
                    onRowMouseDown={childMouseDown}
                    registerRowRef={childRegisterRef}
                    translateY={childTy}
                    isLifting={childLifting}
                    compact={compact}
                    collapsedIds={collapsedIds}
                    toggleCollapsed={toggleCollapsed}
                    expandId={expandId}
                  />
                )}
              />
              {addingChild && (
                <li
                  className={[
                    "lg-task rounded-lg flex items-center gap-2.5",
                    childSz.row,
                  ].join(" ")}
                >
                  <span
                    className={[
                      "flex-none rounded-full border-2",
                      childSz.check,
                      DEPTH_BORDER[
                        Math.min(depth + 1, DEPTH_BORDER.length - 1)
                      ],
                    ].join(" ")}
                  />
                  <SubstepInput
                    onSubmit={(t) => {
                      onAddChild(t);
                      setAddingChild(false);
                    }}
                    onCancel={() => setAddingChild(false)}
                    textClass={childSz.text}
                  />
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
