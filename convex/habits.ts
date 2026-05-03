import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder } from "./_undo";
import type { Doc } from "./_generated/dataModel";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("habits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.sort((a, b) => a.order - b.order);
  },
});

export const add = mutation({
  args: {
    title: v.string(),
    cadenceKind: v.string(),
    cadenceCount: v.optional(v.number()),
    cadenceDays: v.optional(v.array(v.string())),
    autoGenerateTodo: v.optional(v.boolean()),
    linkedProjectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (args.linkedProjectId) {
      await getOwned(ctx, args.linkedProjectId, userId);
    }
    if (!["daily", "weekdays", "weekly_count"].includes(args.cadenceKind)) {
      throw new Error("Invalid cadenceKind");
    }
    const existing = await ctx.db
      .query("habits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let max = -1;
    for (const h of existing) if (h.order > max) max = h.order;
    const rec = new UndoRecorder(ctx, userId);
    const id = await rec.insert("habits", {
      userId,
      title: args.title,
      cadenceKind: args.cadenceKind,
      cadenceCount: args.cadenceCount,
      cadenceDays: args.cadenceDays,
      autoGenerateTodo: args.autoGenerateTodo ?? false,
      linkedProjectId: args.linkedProjectId,
      order: max + 1,
      createdAt: Date.now(),
    });
    await rec.commit("Add habit");
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("habits"),
    title: v.optional(v.string()),
    cadenceKind: v.optional(v.string()),
    cadenceCount: v.optional(v.number()),
    cadenceDays: v.optional(v.array(v.string())),
    autoGenerateTodo: v.optional(v.boolean()),
    linkedProjectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, { id, ...rest }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    if (rest.linkedProjectId) {
      await getOwned(ctx, rest.linkedProjectId, userId);
    }
    if (
      rest.cadenceKind &&
      !["daily", "weekdays", "weekly_count"].includes(rest.cadenceKind)
    ) {
      throw new Error("Invalid cadenceKind");
    }
    const patch: any = {};
    for (const k of [
      "title",
      "cadenceKind",
      "cadenceCount",
      "cadenceDays",
      "autoGenerateTodo",
      "linkedProjectId",
    ] as const) {
      if (rest[k] !== undefined) patch[k] = rest[k];
    }
    if (Object.keys(patch).length === 0) return;
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("habits", id, patch);
    await rec.commit("Edit habit");
  },
});

export const remove = mutation({
  args: { id: v.id("habits") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);

    // Untag tasks before deletion so the habit row no longer has live
    // refs by the time we record its delete inverse.
    const dailies = await ctx.db
      .query("daily_tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of dailies as Doc<"daily_tasks">[]) {
      if (t.habitId === id) {
        await rec.patch("daily_tasks", t._id, { habitId: undefined });
      }
    }
    const weeklies = await ctx.db
      .query("weekly_tasks")
      .filter((q) => q.eq(q.field("habitId"), id))
      .collect();
    for (const t of weeklies as Doc<"weekly_tasks">[]) {
      await rec.patch("weekly_tasks", t._id, { habitId: undefined });
    }
    const projectTasks = await ctx.db
      .query("project_tasks")
      .filter((q) => q.eq(q.field("habitId"), id))
      .collect();
    for (const t of projectTasks as Doc<"project_tasks">[]) {
      await rec.patch("project_tasks", t._id, { habitId: undefined });
    }

    // Bundle the habit + every completion as one tree so the undo restores
    // them with id-remap (so the new completions still point at the new
    // habit id).
    const completions = await ctx.db
      .query("habit_completions")
      .withIndex("by_habit_date", (q) => q.eq("habitId", id))
      .collect();
    const tree: { table: any; doc: any }[] = [];
    for (const c of completions) {
      tree.push({ table: "habit_completions", doc: c });
    }
    const habitDoc = await ctx.db.get(id);
    if (habitDoc) tree.push({ table: "habits", doc: habitDoc });
    await rec.deleteTree(tree);
    await rec.commit("Delete habit");
  },
});
