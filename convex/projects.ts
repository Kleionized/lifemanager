import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder, gatherTaskSubtree } from "./_undo";
import type { Doc } from "./_generated/dataModel";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.sort((a, b) => a.order - b.order);
  },
});

export const add = mutation({
  args: {
    title: v.string(),
    type: v.union(v.literal("project"), v.literal("goal")),
    icon: v.string(),
    startMonday: v.string(),
  },
  handler: async (ctx, { title, type, icon, startMonday }) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let max = -1;
    for (const p of existing) if (p.order > max) max = p.order;
    const rec = new UndoRecorder(ctx, userId);
    const id = await rec.insert("projects", {
      userId,
      title,
      type,
      icon,
      startMonday,
      order: max + 1,
      createdAt: Date.now(),
    });
    await rec.commit("Add project");
    return id;
  },
});

export const updateTitle = mutation({
  args: { id: v.id("projects"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, { title });
    await rec.commit("Rename project");
  },
});

export const setIcon = mutation({
  args: { id: v.id("projects"), icon: v.string() },
  handler: async (ctx, { id, icon }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, { icon });
    await rec.commit("Change icon");
  },
});

export const cycleType = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const p = await getOwned<Doc<"projects">>(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, {
      type: p.type === "project" ? "goal" : "project",
    });
    await rec.commit("Change type");
  },
});

export const setMainGoal = mutation({
  args: { id: v.id("projects"), mainGoal: v.string() },
  handler: async (ctx, { id, mainGoal }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, { mainGoal });
    await rec.commit("Edit main goal");
  },
});

export const setDeadline = mutation({
  args: {
    id: v.id("projects"),
    deadline: v.optional(v.string()),
  },
  handler: async (ctx, { id, deadline }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, { deadline });
    await rec.commit("Set deadline");
  },
});

export const setMilestone = mutation({
  args: {
    id: v.id("projects"),
    iso: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { id, iso, text }) => {
    const userId = await requireUserId(ctx);
    const p = await getOwned<Doc<"projects">>(ctx, id, userId);
    const ms = { ...(p.milestones || {}) };
    if (text.trim() === "") {
      delete ms[iso];
    } else {
      ms[iso] = text;
    }
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("projects", id, { milestones: ms });
    await rec.commit("Edit milestone");
  },
});

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);

    // Patch goals to drop this projectId from their projectIds list, and
    // unset linkedProjectId on any habit pointing here. We patch BEFORE
    // gathering the project_tasks because gather/delete mustn't run while
    // the project still has links pointing at it.
    const goals = await ctx.db
      .query("goals")
      .withIndex("by_user_status", (q) => q.eq("userId", userId))
      .collect();
    for (const g of goals as Doc<"goals">[]) {
      if (g.projectIds.includes(id)) {
        await rec.patch("goals", g._id, {
          projectIds: g.projectIds.filter((p) => p !== id),
        });
      }
    }
    const habits = await ctx.db
      .query("habits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const h of habits as Doc<"habits">[]) {
      if (h.linkedProjectId === id) {
        await rec.patch("habits", h._id, { linkedProjectId: undefined });
      }
    }

    // Gather every project_task in this project (and any sourced
    // completions) plus the project itself, delete them as one tree so the
    // undo restores them in one shot with id-remap.
    const tasks = await ctx.db
      .query("project_tasks")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    const tree: { table: any; doc: any }[] = [];
    for (const t of tasks as Doc<"project_tasks">[]) {
      tree.push({ table: "project_tasks", doc: t });
      const sourced = await ctx.db
        .query("habit_completions")
        .withIndex("by_source", (q) => q.eq("sourceTodoId", t._id))
        .collect();
      for (const c of sourced) {
        tree.push({ table: "habit_completions", doc: c });
      }
    }
    const projectDoc = await ctx.db.get(id);
    if (projectDoc) tree.push({ table: "projects", doc: projectDoc });
    await rec.deleteTree(tree);
    await rec.commit("Delete project");
  },
});
