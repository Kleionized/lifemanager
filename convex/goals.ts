import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder } from "./_undo";
import type { Doc } from "./_generated/dataModel";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const statuses = ["active", "paused", "done", "archived"];
    const out: Doc<"goals">[] = [];
    for (const status of statuses) {
      const rows = await ctx.db
        .query("goals")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", userId).eq("status", status)
        )
        .collect();
      out.push(...rows);
    }
    return out.sort((a, b) => a.order - b.order);
  },
});

export const add = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    targetDate: v.optional(v.string()),
    projectIds: v.array(v.id("projects")),
  },
  handler: async (ctx, { title, description, targetDate, projectIds }) => {
    const userId = await requireUserId(ctx);
    for (const pid of projectIds) await getOwned(ctx, pid, userId);
    const all: Doc<"goals">[] = [];
    for (const status of ["active", "paused", "done", "archived"]) {
      const rows = await ctx.db
        .query("goals")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", userId).eq("status", status)
        )
        .collect();
      all.push(...rows);
    }
    let max = -1;
    for (const g of all) if (g.order > max) max = g.order;
    const rec = new UndoRecorder(ctx, userId);
    const id = await rec.insert("goals", {
      userId,
      title,
      description,
      targetDate,
      status: "active",
      progress: undefined,
      projectIds,
      order: max + 1,
      createdAt: Date.now(),
    });
    await rec.commit("Add goal");
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("goals"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    targetDate: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...rest }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const patch: any = {};
    for (const k of ["title", "description", "targetDate"] as const) {
      if (rest[k] !== undefined) patch[k] = rest[k];
    }
    if (Object.keys(patch).length === 0) return;
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("goals", id, patch);
    await rec.commit("Edit goal");
  },
});

export const setStatus = mutation({
  args: { id: v.id("goals"), status: v.string() },
  handler: async (ctx, { id, status }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    if (!["active", "paused", "done", "archived"].includes(status)) {
      throw new Error("Invalid status");
    }
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("goals", id, { status });
    await rec.commit("Change status");
  },
});

export const setProgress = mutation({
  args: {
    id: v.id("goals"),
    progress: v.optional(v.number()),
  },
  handler: async (ctx, { id, progress }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("goals", id, { progress });
    await rec.commit("Set progress");
  },
});

export const linkProject = mutation({
  args: { id: v.id("goals"), projectId: v.id("projects") },
  handler: async (ctx, { id, projectId }) => {
    const userId = await requireUserId(ctx);
    const goal = await getOwned<Doc<"goals">>(ctx, id, userId);
    await getOwned(ctx, projectId, userId);
    if (goal.projectIds.includes(projectId)) return;
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("goals", id, {
      projectIds: [...goal.projectIds, projectId],
    });
    await rec.commit("Link project");
  },
});

export const unlinkProject = mutation({
  args: { id: v.id("goals"), projectId: v.id("projects") },
  handler: async (ctx, { id, projectId }) => {
    const userId = await requireUserId(ctx);
    const goal = await getOwned<Doc<"goals">>(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("goals", id, {
      projectIds: goal.projectIds.filter((p) => p !== projectId),
    });
    await rec.commit("Unlink project");
  },
});

export const remove = mutation({
  args: { id: v.id("goals") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.delete("goals", id);
    await rec.commit("Delete goal");
  },
});
