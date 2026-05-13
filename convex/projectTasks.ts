import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder, gatherTaskSubtree } from "./_undo";
import type { Id, Doc } from "./_generated/dataModel";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, projectId, userId);
    return await ctx.db
      .query("project_tasks")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out: Doc<"project_tasks">[] = [];
    for (const p of projects) {
      const tasks = await ctx.db
        .query("project_tasks")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .collect();
      out.push(...tasks);
    }
    return out;
  },
});

async function nextOrderInGroup(
  ctx: any,
  projectId: Id<"projects">,
  date: string | undefined,
  parentId: Id<"project_tasks"> | undefined
): Promise<number> {
  const siblings = await ctx.db
    .query("project_tasks")
    .withIndex("by_project", (q: any) => q.eq("projectId", projectId))
    .collect();
  let max = -1;
  for (const s of siblings as Doc<"project_tasks">[]) {
    const sameParent = (s.parentId ?? undefined) === parentId;
    const sameDate = (s.date ?? undefined) === date;
    if (sameParent && sameDate && s.order > max) max = s.order;
  }
  return max + 1;
}

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    date: v.optional(v.string()),
    parentId: v.optional(v.id("project_tasks")),
    habitId: v.optional(v.id("habits")),
  },
  handler: async (ctx, { projectId, title, date, parentId, habitId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, projectId, userId);
    if (parentId) await getOwned(ctx, parentId, userId);
    const order = await nextOrderInGroup(ctx, projectId, date, parentId);
    const rec = new UndoRecorder(ctx, userId);
    const id = await rec.insert("project_tasks", {
      userId,
      projectId,
      title,
      done: false,
      date,
      parentId,
      order,
      habitId,
      createdAt: Date.now(),
    });
    await rec.commit("Add task");
    return id;
  },
});

export const addAt = mutation({
  args: {
    title: v.string(),
    siblingId: v.id("project_tasks"),
    position: v.union(v.literal("before"), v.literal("after")),
  },
  handler: async (ctx, { title, siblingId, position }) => {
    const userId = await requireUserId(ctx);
    const sibling = await getOwned<Doc<"project_tasks">>(
      ctx,
      siblingId,
      userId
    );
    const parentId = sibling.parentId ?? undefined;
    const date = sibling.date ?? undefined;
    const all = await ctx.db
      .query("project_tasks")
      .withIndex("by_project", (q) => q.eq("projectId", sibling.projectId))
      .collect();
    const group = all
      .filter(
        (t) =>
          (t.parentId ?? undefined) === parentId &&
          (t.date ?? undefined) === date
      )
      .sort((a, b) => a.order - b.order);
    const idx = group.findIndex((t) => t._id === siblingId);
    const insertIdx = position === "before" ? idx : idx + 1;
    const rec = new UndoRecorder(ctx, userId);
    const newId = await rec.insert("project_tasks", {
      userId,
      projectId: sibling.projectId,
      title,
      done: false,
      date,
      parentId,
      order: 0,
      createdAt: Date.now(),
    });
    const newDoc = (await ctx.db.get(newId))!;
    const reordered = [
      ...group.slice(0, insertIdx),
      newDoc,
      ...group.slice(insertIdx),
    ];
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].order !== i) {
        await rec.patch("project_tasks", reordered[i]._id, { order: i });
      }
    }
    await rec.commit("Add task");
    return newId;
  },
});

export const updateTitle = mutation({
  args: { id: v.id("project_tasks"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("project_tasks", id, { title });
    await rec.commit("Edit task");
  },
});

async function collectProjectDescendants(
  ctx: any,
  rootId: any
): Promise<Doc<"project_tasks">[]> {
  const out: Doc<"project_tasks">[] = [];
  const visit = async (parentId: any) => {
    const kids = await ctx.db
      .query("project_tasks")
      .withIndex("by_parent", (q: any) => q.eq("parentId", parentId))
      .collect();
    for (const k of kids as Doc<"project_tasks">[]) {
      out.push(k);
      await visit(k._id);
    }
  };
  await visit(rootId);
  return out;
}

export const toggleDone = mutation({
  args: { id: v.id("project_tasks") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const task = await getOwned<Doc<"project_tasks">>(ctx, id, userId);
    const newDone = !task.done;
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("project_tasks", id, { done: newDone });
    if (newDone) {
      const descendants = await collectProjectDescendants(ctx, id);
      for (const d of descendants) {
        if (!d.done) {
          await rec.patch("project_tasks", d._id, { done: true });
        }
      }
    }
    if (task.habitId && task.date) {
      const existing = await ctx.db
        .query("habit_completions")
        .withIndex("by_habit_date", (q) =>
          q.eq("habitId", task.habitId!).eq("date", task.date!)
        )
        .filter((q) => q.eq(q.field("sourceTodoId"), id))
        .unique();
      if (newDone && !existing) {
        await rec.insert("habit_completions", {
          userId,
          habitId: task.habitId,
          date: task.date,
          sourceTodoId: id,
          createdAt: Date.now(),
        });
      } else if (!newDone && existing) {
        await rec.delete("habit_completions", existing._id);
      }
    }
    await rec.commit(newDone ? "Complete task" : "Uncomplete task");
  },
});

export const setDate = mutation({
  args: {
    id: v.id("project_tasks"),
    date: v.optional(v.string()),
  },
  handler: async (ctx, { id, date }) => {
    const userId = await requireUserId(ctx);
    const task = await getOwned<Doc<"project_tasks">>(ctx, id, userId);
    const order = await nextOrderInGroup(
      ctx,
      task.projectId,
      date,
      task.parentId ?? undefined
    );
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("project_tasks", id, { date, order });
    await rec.commit("Move task");
  },
});

export const remove = mutation({
  args: { id: v.id("project_tasks") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    const subtree = await gatherTaskSubtree(ctx, "project_tasks", id);
    await rec.deleteTree(subtree);
    await rec.commit("Delete task");
  },
});

// Swap order with adjacent task in the same (projectId, date, parentId)
// group. direction = -1 (up) or +1 (down). Idempotent if already at boundary.
export const reorder = mutation({
  args: {
    id: v.id("project_tasks"),
    direction: v.number(),
  },
  handler: async (ctx, { id, direction }) => {
    const userId = await requireUserId(ctx);
    const task = await getOwned<Doc<"project_tasks">>(ctx, id, userId);
    const all = await ctx.db
      .query("project_tasks")
      .withIndex("by_project", (q) => q.eq("projectId", task.projectId))
      .collect();
    const group = all
      .filter(
        (t) =>
          (t.parentId ?? undefined) === (task.parentId ?? undefined) &&
          (t.date ?? undefined) === (task.date ?? undefined)
      )
      .sort((a, b) => a.order - b.order);
    const idx = group.findIndex((t) => t._id === id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= group.length) return;
    const a = group[idx];
    const b = group[swapIdx];
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("project_tasks", a._id, { order: b.order });
    await rec.patch("project_tasks", b._id, { order: a.order });
    await rec.commit("Reorder");
  },
});

export const setHabitTag = mutation({
  args: {
    id: v.id("project_tasks"),
    habitId: v.optional(v.id("habits")),
  },
  handler: async (ctx, { id, habitId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    if (habitId) await getOwned(ctx, habitId, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("project_tasks", id, { habitId });
    await rec.commit("Tag habit");
  },
});
