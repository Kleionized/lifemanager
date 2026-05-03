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
});
