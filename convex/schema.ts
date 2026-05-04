import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  // One row per user. Replaces the four `todos_v1_*` localStorage UI keys
  // (theme, sidebar, weeklyMode, collapsedIds) plus the active view.
  ui: defineTable({
    userId: v.id("users"),
    theme: v.string(), // "light" | "dark"
    sidebarOpen: v.boolean(),
    weeklyMode: v.string(), // "grid" | "list"
    collapsedIds: v.array(v.string()),
    view: v.any(), // { type, id?, week? }
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
    day: v.string(), // "mon".."sun"
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
    milestones: v.optional(v.any()), // { [iso]: string }
    order: v.number(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  project_tasks: defineTable({
    userId: v.id("users"),
    projectId: v.id("projects"),
    title: v.string(),
    done: v.boolean(),
    date: v.optional(v.string()), // ISO; absent = backlog
    parentId: v.optional(v.id("project_tasks")),
    order: v.number(),
    habitId: v.optional(v.id("habits")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["parentId", "order"]),

  goals: defineTable({
    userId: v.id("users"),
    title: v.string(),
    description: v.string(),
    targetDate: v.optional(v.string()),
    status: v.string(), // "active"|"paused"|"done"|"archived"
    progress: v.optional(v.number()),
    projectIds: v.array(v.id("projects")),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_user_status", ["userId", "status"]),

  habits: defineTable({
    userId: v.id("users"),
    title: v.string(),
    cadenceKind: v.string(), // "daily"|"weekdays"|"weekly_count"
    cadenceCount: v.optional(v.number()),
    cadenceDays: v.optional(v.array(v.string())),
    autoGenerateTodo: v.boolean(),
    linkedProjectId: v.optional(v.id("projects")),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  habit_completions: defineTable({
    userId: v.id("users"),
    habitId: v.id("habits"),
    date: v.string(),
    sourceTodoId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_habit_date", ["habitId", "date"])
    .index("by_user_date", ["userId", "date"])
    .index("by_source", ["sourceTodoId"]),

  // Inverse-op log for ⌘Z. Each row stores an array of inverse operations
  // that, applied in order, undo a single user-facing mutation. Capped at
  // 100 most-recent rows per user; older rows are pruned.
  undo_log: defineTable({
    userId: v.id("users"),
    inverse: v.any(),
    description: v.string(),
    createdAt: v.number(),
  }).index("by_user_created", ["userId", "createdAt"]),

  // ─────────── Plans ───────────
  // Term-style plans: a finite-week run with phase shifts, exam weeks,
  // energy-aware day templates, and per-block tracking. Parallel to the
  // task/project/goal system; doesn't replace it.

  // One row per plan. `goalLinks` maps category-id → goal-id so a plan's
  // "finals" / "lnat" / "fitness" buckets can reference real goals.
  plans: defineTable({
    userId: v.id("users"),
    name: v.string(),
    startDate: v.string(), // ISO Monday of week 1
    weekCount: v.number(),
    phaseShiftWeek: v.optional(v.number()), // week N+ flips phase
    examWeek: v.optional(v.number()), // week N is exam week (red)
    phaseOverride: v.optional(v.string()), // "auto" | "essay" | "revision"
    goalLinks: v.optional(v.any()), // { [categoryId]: goalId }
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  // Editable per-(energy, phase) schedule template. Blocks is the ordered
  // list of {s,e,title,category,duration} segments rendered on the
  // calendar. `phase` is "" for energies that don't split by phase
  // (low/moderate). High-energy schedules typically have two rows: one
  // with phase="essay", one with phase="revision".
  plan_schedules: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    energy: v.string(), // "high" | "low" | "moderate"
    phase: v.string(), // "essay" | "revision" | ""
    blocks: v.array(
      v.object({
        s: v.string(),
        e: v.string(),
        t: v.string(),
        c: v.string(),
        d: v.string(),
      })
    ),
  })
    .index("by_plan", ["planId"])
    .index("by_plan_lookup", ["planId", "energy", "phase"]),

  // Recurring weekly fixtures (lectures / tutorials). dow is 0=Sun..6=Sat.
  plan_lectures: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    dow: v.number(),
    blocks: v.array(
      v.object({
        s: v.string(),
        e: v.string(),
        t: v.string(),
        c: v.string(),
        d: v.string(),
      })
    ),
  })
    .index("by_plan", ["planId"])
    .index("by_plan_dow", ["planId", "dow"]),

  // Per-date energy choice + per-date phase override. One row per day the
  // user has actually answered the energy picker for.
  plan_days: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    date: v.string(), // ISO YYYY-MM-DD
    energy: v.string(), // "high" | "low" | "moderate" | "sick"
    phaseOverride: v.optional(v.string()), // "essay" | "revision" | undefined
    // Per-date overrides for one-off edits. When present, these
    // arrays REPLACE the template/lecture blocks for that date alone.
    scheduleOverride: v.optional(
      v.array(
        v.object({
          s: v.string(),
          e: v.string(),
          t: v.string(),
          c: v.string(),
          d: v.string(),
        })
      )
    ),
    lectureOverride: v.optional(
      v.array(
        v.object({
          s: v.string(),
          e: v.string(),
          t: v.string(),
          c: v.string(),
          d: v.string(),
        })
      )
    ),
  })
    .index("by_plan", ["planId"])
    .index("by_plan_date", ["planId", "date"]),

  // Per-block completion status. blockKey = `${s}_${e}_${category}` so it
  // survives schedule edits in the same block-window. status one of
  // "completed" | "half" | "missed".
  plan_tracking: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    date: v.string(),
    blockKey: v.string(),
    blockTitle: v.string(), // denormalized so stats don't need a schedule join
    category: v.string(),
    status: v.string(),
  })
    .index("by_plan", ["planId"])
    .index("by_plan_date", ["planId", "date"])
    .index("by_plan_date_block", ["planId", "date", "blockKey"]),

  // If/then decision rules. Editable, ordered.
  plan_rules: defineTable({
    userId: v.id("users"),
    planId: v.id("plans"),
    ifText: v.string(),
    thenText: v.string(),
    order: v.number(),
  })
    .index("by_plan", ["planId"]),
});
