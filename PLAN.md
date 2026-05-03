# Convex migration — plan

Convert the current Vite + React + localStorage SPA into a Vite + React +
Convex single-user webapp. Source of truth moves from `localStorage` to
Convex tables; Convex's reactive `useQuery` replaces the giant `useState`.

---

## 1. Stack after the move

- **Frontend**: same Vite + React 18 + Tailwind 4. No framework swap (no
  Next.js — adding it would require restructuring routing for nothing).
  Deployable to any static host that takes Vite's `dist/` (Vercel,
  Netlify, Cloudflare Pages all work).
- **Backend / DB**: Convex. One deployment for the whole app. Reactive
  queries; no separate "real-time layer."
- **Auth**: Convex Auth with email magic link for the one user.
  Alternatives below in §6.
- **Env**: `VITE_CONVEX_URL` injected at build, points at the dev
  deployment locally and the prod deployment in production.

---

## 2. Schema

Single user means every row carries `userId: v.id("users")`. Convex's
`auth` ctx will pin this on every mutation.

Key shape change from current state: **subtasks flatten into
`parentId`-keyed rows** instead of nested `children[]` arrays. Convex
tables don't nest, and indexes need flat fields anyway. The
recursive `bindTask` walker becomes a `parentId` lookup.

Embedded fields that don't need querying (e.g. `project.milestones`)
stay as JSON on the project row.

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
  }).index("by_email", ["email"]),

  // Top-level UI state — one row per user. Replaces the four
  // `todos_v1_*` localStorage UI keys (theme, sidebar, weeklyMode,
  // collapsedIds). Keeps view-state on the server so it follows you
  // across devices.
  ui: defineTable({
    userId: v.id("users"),
    theme: v.string(),                    // "light" | "dark"
    sidebarOpen: v.boolean(),
    weeklyMode: v.string(),               // "grid" | "list"
    collapsedIds: v.array(v.string()),
    view: v.any(),                        // { type, id?, week? }
  }).index("by_user", ["userId"]),

  daily_tasks: defineTable({
    userId: v.id("users"),
    title: v.string(),
    done: v.boolean(),
    parentId: v.optional(v.id("daily_tasks")),
    order: v.number(),
    habitId: v.optional(v.id("habits")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_parent", ["parentId", "order"]),

  weekly_tasks: defineTable({
    userId: v.id("users"),
    title: v.string(),
    done: v.boolean(),
    day: v.string(),                      // "mon".."sun"
    parentId: v.optional(v.id("weekly_tasks")),
    order: v.number(),
    habitId: v.optional(v.id("habits")),
    createdAt: v.number(),
  })
    .index("by_user_day", ["userId", "day"])
    .index("by_parent", ["parentId", "order"]),

  projects: defineTable({
    userId: v.id("users"),
    title: v.string(),
    type: v.union(v.literal("project"), v.literal("goal")),
    icon: v.string(),
    startMonday: v.string(),
    mainGoal: v.optional(v.string()),
    deadline: v.optional(v.string()),
    milestones: v.optional(v.any()),      // { [iso]: string }
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  project_tasks: defineTable({
    userId: v.id("users"),
    projectId: v.id("projects"),
    title: v.string(),
    done: v.boolean(),
    date: v.optional(v.string()),         // ISO YYYY-MM-DD; null = backlog
    parentId: v.optional(v.id("project_tasks")),
    order: v.number(),
    habitId: v.optional(v.id("habits")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_date", ["projectId", "date", "parentId", "order"])
    .index("by_parent", ["parentId", "order"]),

  goals: defineTable({
    userId: v.id("users"),
    title: v.string(),
    description: v.string(),
    targetDate: v.optional(v.string()),
    status: v.string(),                   // "active"|"paused"|"done"|"archived"
    progress: v.optional(v.number()),     // null → derive from projectIds
    projectIds: v.array(v.id("projects")),
    createdAt: v.number(),
  }).index("by_user_status", ["userId", "status"]),

  habits: defineTable({
    userId: v.id("users"),
    title: v.string(),
    cadenceKind: v.string(),              // "daily"|"weekdays"|"weekly_count"
    cadenceCount: v.optional(v.number()),
    cadenceDays: v.optional(v.array(v.string())),
    autoGenerateTodo: v.boolean(),
    linkedProjectId: v.optional(v.id("projects")),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  habit_completions: defineTable({
    userId: v.id("users"),
    habitId: v.id("habits"),
    date: v.string(),
    sourceTodoId: v.optional(v.string()),  // task id from any task table
    createdAt: v.number(),
  })
    .index("by_habit_date", ["habitId", "date"])
    .index("by_user_date", ["userId", "date"])
    .index("by_source", ["sourceTodoId"]),

  // Undo log — see §5. Bounded retention (~100 entries per user).
  undo_log: defineTable({
    userId: v.id("users"),
    inverse: v.any(),                     // serialized inverse op
    description: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId", "createdAt"]),
});
```

**Open question on schema:** legacy `type === "goal"` projects with the
old `weeks[][dayKey]` shape — drop them on migration, or convert the
inner tasks into `project_tasks` rows with derived dates? Recommend
**drop**: those projects are hidden in the sidebar already and the new
Goals page subsumes the role. Surface a one-time toast: "N legacy
goals were not migrated — see PLAN.md if you want them back."

---

## 3. Mutators

Every existing mutator becomes a Convex mutation. Roughly 30–40 of
them. Naming convention: `convex/<entity>.ts` exports `add`, `update`,
`delete`, etc.

**Path-based helpers go away.** `updateAtPath` / `removeAtPath` /
`addChildAtPath` were workarounds for nested-array storage. With flat
rows + `parentId`, every operation is a direct `db.patch` /
`db.delete` / `db.insert` keyed by id. Subtasks just have
`parentId !== undefined`.

**Order field** — already in v3 schema. New rows insert at
`max(order in same parent group) + 1`. Reorder swaps two rows'
`order`. No global reorder cascades.

**Side effects (habit tag-sync)** — currently inside `toggleDaily` /
`toggleWeekly` / `toggleProjectDatedTask`, the toggle reads the task,
flips `done`, and conditionally upserts a `habit_completions` row.
Same pattern in Convex: each toggle mutation does `db.get(task)`,
`db.patch(task, { done: !done })`, then conditionally inserts/deletes
a completion. Atomic in Convex (mutations are transactions).

**Habit virtual toggle** stays a dedicated entry point — its synthetic
id (`habit:${habitId}:${date}`) still must never reach `db.get`.
Server-side guard: the `toggleHabitVirtual` mutation takes
`(habitId, date)` only, never an id. Same defense in depth.

---

## 4. Client wiring

The single `useState` blob disappears. Replace with one `useQuery` per
table the page needs:

```jsx
const ui = useQuery(api.ui.get);
const daily = useQuery(api.tasks.listDaily);
const weekly = useQuery(api.tasks.listWeekly);
const projects = useQuery(api.projects.list);
const goals = useQuery(api.goals.list);
const habits = useQuery(api.habits.list);
const completions = useQuery(api.habits.listCompletionsRecent, { days: 120 });
```

`undefined` while loading — wrap views in a `<Suspense>` or render a
skeleton. Convex re-renders the component when any of these change.

**Subtree reconstruction** — `project_tasks` come back flat. Group by
`parentId` once, then walk the tree to build the same `children[]`
nested shape the existing rendering expects. Keep `bindTask` etc.
unchanged. `useMemo` the reconstruction so it doesn't re-run on every
keystroke.

```js
function nestTasks(flatTasks) {
  const byParent = new Map();
  for (const t of flatTasks) {
    const k = t.parentId || null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(t);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.order - b.order);
  }
  const attach = (id) => {
    const kids = byParent.get(id) || [];
    return kids.map((c) => ({ ...c, children: attach(c._id) }));
  };
  return attach(null);
}
```

**Mutations**: `useMutation(api.tasks.toggleDaily)` returns an async
function. Existing handler shapes (`onToggle`, `onUpdate`, etc.) get
bound to these. Optimistic updates: Convex's
`.withOptimisticUpdate(...)` lets us patch the local query result
immediately so the UI doesn't lag. Required for the checkbox feel and
for the existing 200ms collapse animation to look right.

---

## 5. Undo (⌘Z)

The current undo is a `useRef([])` snapshot stack — full state every
mutation. Doesn't translate to Convex (state is server-side; we can't
"snapshot the database"). Two options:

**(A) Operation log (recommended).** Every mutation also writes an
`inverse` describing how to undo it (e.g. `{ op: "delete_task", id }`
for an insert, `{ op: "patch_task", id, prev: {...} }` for a patch).
Stored in `undo_log` table, capped at 100 per user. ⌘Z reads the
latest log row, applies the inverse mutation, deletes the log row.
Scoped to user, survives page reload. Cap is a safety net against
drift if the inverse becomes invalid (e.g. the task was already
deleted by something else).

**(B) Skip server-side, just keep client history.** Faster to ship.
Doesn't survive reload. Matches the *current* UX (the existing
in-memory undo doesn't survive reload either — `historyRef` is
`useRef`).

Recommend **(B) for v1 of the migration**, **(A) as a follow-up**.
The current behavior already breaks across reload, and (A) requires
plumbing inverses through every mutation, which doubles the surface
area of the migration.

---

## 6. Auth

Single user, but the deployment URL is public. Without auth, anyone who
finds it has full access.

**Recommend: Convex Auth with email magic link.** One-time setup:

1. `npx convex auth init` — wires up `@convex-dev/auth`.
2. On first load, app redirects to a sign-in screen.
3. Email magic link → token → all mutations/queries see your `userId`.

About 50 lines of boilerplate; the Convex template includes most of it.

**Lighter alternatives** (less robust, mention briefly):
- **Static token in URL hash**: `#k=<long-random>`. Convex query
  validates the token against a hardcoded value in `convex/auth.ts`.
  Trivial but anyone who sees your URL bar has the token.
- **No auth, trust by URL**: don't share the deploy URL. Fine until
  it leaks. Don't recommend.

Going with magic link unless you say otherwise.

---

## 7. One-time migration from localStorage

First load after the conversion:

1. Sign in with email.
2. Client checks if `api.tasks.listDaily()` (and friends) are empty for
   this user.
3. If empty AND `localStorage.todos_v3` exists, run the v3-shape →
   Convex push:
   - Insert each project; remember the `oldId → newId` map.
   - Insert each project task with `projectId` mapped, flatten
     `children[]` recursively into rows with `parentId` mapped.
   - Insert daily/weekly tasks similarly.
   - Insert goals (with `projectIds[]` remapped through the project
     id table).
   - Insert habits (with `linkedProjectId` remapped).
   - Insert habit completions (with `habitId` remapped, `sourceTodoId`
     remapped if it points at a known task).
   - Drop legacy `type === "goal"` projects (per §2 open question).
4. Wipe `localStorage.todos_v3` to prevent re-pushing on subsequent
   loads, but keep `todos_v1` and `todos_v2` as ultimate fallbacks
   for one release.
5. Keep the localStorage UI keys (`todos_v1_theme` etc.) for one
   release. After that, source UI state from `ui` table.

The remap is the hairy part — every nested `id` reference (`parentId`,
`projectId`, `linkedProjectId`, `sourceTodoId`, `goal.projectIds[]`)
has to be rewritten. Run as one big `internalMutation` so it's
transactional.

---

## 8. Deploy

- **Convex**: `npx convex dev` for local; `npx convex deploy --prod`
  for prod. Free tier covers a single user comfortably.
- **Frontend**: `npm run build` → upload `dist/`. Vercel / Netlify /
  Cloudflare Pages — pick one. Vercel is fewest steps.
- **Env vars**: `VITE_CONVEX_URL` set in the host's dashboard, plus any
  Convex Auth secrets (`AUTH_SECRET`, email provider key).
- **Domain**: optional. The Convex URL works as-is; a custom domain is
  one Vercel setting.

---

## 9. What gets harder

A few existing patterns become more complicated:

1. **Task title editing on every keystroke** — currently every Enter
   fires a sync `setState`. With Convex this is one round-trip per
   commit. Optimistic updates make the checkbox/title feel instant,
   but the network is on the path. Acceptable for a single user.
2. **The 180ms crossfade between views** assumes data is sync. With
   useQuery, `displayView` may render before its data has loaded.
   Need to either delay the swap until data is ready, or accept a
   skeleton frame mid-fade. Ship the skeleton.
3. **Subtree reconstruction (`nestTasks`)** runs on every render of
   the project view. With `useMemo` keyed on the flat list it's fine,
   but the dep array is a 200+ element array — useMemo won't help.
   Easier to wrap in `useDeferredValue` or just trust React's
   reconciler.
4. **The undo guard for virtual habit rows** stays the same — virtual
   rows never reach a real mutation, only `toggleHabitVirtual`, which
   takes `(habitId, date)` (no synthetic id). Server-side mutation
   args enforce the same shape.

---

## 10. What gets easier

1. **Multi-tab consistency** — open the app in two tabs, edits in one
   show up in the other. Free with Convex.
2. **Mobile via the same URL** — once deployed, your phone gets the
   same data without the localStorage / `_v3` migration dance.
3. **Schema-level invariants** — e.g. one `habit_completion` per
   `(habitId, date, sourceTodoId)` is enforceable by an index +
   mutation precondition, instead of relying on `addHabitCompletion`'s
   "if (exists) return s" check on the client.
4. **Backups** — Convex dashboard has snapshot/export. Today the only
   backup is whatever the user remembered to copy out of localStorage.

---

## 11. Implementation order

1. **Convex setup**: `npm i convex @convex-dev/auth`,
   `npx convex dev`, write `convex/schema.ts`. ~30min.
2. **Auth**: magic link flow, sign-in screen. ~1.5h.
3. **Queries**: one per table needed by the views. ~1.5h.
4. **Mutations**: 30+ functions. Group as `convex/tasks.ts`,
   `convex/projects.ts`, `convex/goals.ts`, `convex/habits.ts`. ~3–4h.
5. **Client wiring**: replace the giant `useState` with `useQuery`
   hooks, swap mutation handlers, add `nestTasks`. ~2–3h.
6. **Optimistic updates** on the hot mutations (toggle, update title,
   delete, reorder). ~1h.
7. **One-time migration** action that pushes localStorage v3 → Convex.
   ~1.5h.
8. **Deploy** Convex prod + Vercel + env wiring. ~30min.
9. **Smoke test**: every view, undo, dark mode, ⌘K, view crossfade,
   migration on a fresh deployment, sign-out / sign-back-in. ~1h.
10. **Server-side undo log (§5 option A)** — defer to a follow-up.

Total: ~12–15h focused, plus probably 2–3h of debugging Convex Auth
the first time it's set up.

---

## 12. Open product questions

1. **Auth**: magic link OK, or do you want to skip auth entirely and
   gate by hardcoded token? Recommend magic link.
2. **Legacy `type === "goal"` projects**: drop on migration (§2)?
   Recommend yes — they're already hidden in the sidebar.
3. **Undo strategy**: ship (B) client-side history first, defer (A)
   server-side log? Or block on (A)?
4. **UI state in `ui` table**: cross-device theme/sidebar/view sync,
   or keep that in localStorage for now? Recommend Convex (you'll be
   on phone too).
5. **Hosting**: Vercel default? Or a preference? Free tier on Vercel
   covers this comfortably.
6. **Domain**: custom domain, or fine with `<deploy>.vercel.app`?

Awaiting confirmation before any code lands.
