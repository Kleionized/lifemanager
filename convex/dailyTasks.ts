import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder, gatherTaskSubtree } from "./_undo";
import type { Id, Doc } from "./_generated/dataModel";

// Returns flat list. Client calls nestTasks() to reconstruct children[].
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("daily_tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

async function nextOrderInGroup(
  ctx: any,
  userId: Id<"users">,
  parentId: Id<"daily_tasks"> | undefined
): Promise<number> {
  const siblings = await ctx.db
    .query("daily_tasks")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  let max = -1;
  for (const s of siblings as Doc<"daily_tasks">[]) {
    if ((s.parentId ?? undefined) !== parentId) continue;
    if (s.order > max) max = s.order;
  }
  return max + 1;
}

export const add = mutation({
  args: {
    title: v.string(),
    parentId: v.optional(v.id("daily_tasks")),
    habitId: v.optional(v.id("habits")),
  },
  handler: async (ctx, { title, parentId, habitId }) => {
    const userId = await requireUserId(ctx);
    if (parentId) await getOwned(ctx, parentId, userId);
    const order = await nextOrderInGroup(ctx, userId, parentId);
    const rec = new UndoRecorder(ctx, userId);
    const id = await rec.insert("daily_tasks", {
      userId,
      title,
      done: false,
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
    siblingId: v.id("daily_tasks"),
    position: v.union(v.literal("before"), v.literal("after")),
  },
  handler: async (ctx, { title, siblingId, position }) => {
    const userId = await requireUserId(ctx);
    const sibling = await getOwned<Doc<"daily_tasks">>(ctx, siblingId, userId);
    const parentId = sibling.parentId ?? undefined;
    const all = await ctx.db
      .query("daily_tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const group = all
      .filter((t) => (t.parentId ?? undefined) === parentId)
      .sort((a, b) => a.order - b.order);
    const idx = group.findIndex((t) => t._id === siblingId);
    const insertIdx = position === "before" ? idx : idx + 1;
    const rec = new UndoRecorder(ctx, userId);
    const newId = await rec.insert("daily_tasks", {
      userId,
      title,
      done: false,
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
        await rec.patch("daily_tasks", reordered[i]._id, { order: i });
      }
    }
    await rec.commit("Add task");
    return newId;
  },
});

export const updateTitle = mutation({
  args: { id: v.id("daily_tasks"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { title });
    await rec.commit("Edit task");
  },
});

// Collect all descendants of a row (children, grandchildren, etc.) by
// walking parentId references. Used by toggleDone to cascade completion
// down through every nested step.
async function collectDescendants(
  ctx: any,
  rootId: any
): Promise<Doc<"daily_tasks">[]> {
  const out: Doc<"daily_tasks">[] = [];
  const visit = async (parentId: any) => {
    const kids = await ctx.db
      .query("daily_tasks")
      .withIndex("by_parent", (q: any) => q.eq("parentId", parentId))
      .collect();
    for (const k of kids as Doc<"daily_tasks">[]) {
      out.push(k);
      await visit(k._id);
    }
  };
  await visit(rootId);
  return out;
}

export const toggleDone = mutation({
  args: { id: v.id("daily_tasks"), date: v.string() },
  handler: async (ctx, { id, date }) => {
    const userId = await requireUserId(ctx);
    const task = await getOwned<Doc<"daily_tasks">>(ctx, id, userId);
    const newDone = !task.done;
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { done: newDone });
    // Cascade DOWN: marking a parent done auto-completes every nested
    // step. Unchecking the parent does NOT undo the children — the
    // user can re-open specific ones if needed.
    if (newDone) {
      const descendants = await collectDescendants(ctx, id);
      for (const d of descendants) {
        if (!d.done) {
          await rec.patch("daily_tasks", d._id, { done: true });
        }
      }
    }
    if (task.habitId) {
      const existing = await ctx.db
        .query("habit_completions")
        .withIndex("by_habit_date", (q) =>
          q.eq("habitId", task.habitId!).eq("date", date)
        )
        .filter((q) => q.eq(q.field("sourceTodoId"), id))
        .unique();
      if (newDone && !existing) {
        await rec.insert("habit_completions", {
          userId,
          habitId: task.habitId,
          date,
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

export const setDeadline = mutation({
  args: {
    id: v.id("daily_tasks"),
    deadline: v.optional(v.string()),
  },
  handler: async (ctx, { id, deadline }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { deadline });
    await rec.commit(deadline ? "Set deadline" : "Clear deadline");
  },
});

export const setProject = mutation({
  args: {
    id: v.id("daily_tasks"),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, { id, projectId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    if (projectId) await getOwned(ctx, projectId, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { projectId });
    await rec.commit(projectId ? "Tag project" : "Untag project");
  },
});

export const remove = mutation({
  args: { id: v.id("daily_tasks") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    const subtree = await gatherTaskSubtree(ctx, "daily_tasks", id);
    await rec.deleteTree(subtree);
    await rec.commit("Delete task");
  },
});

// Reorder a task to a specific zero-based position within its sibling
// group (same parentId). Used by the Today view's drag-and-drop
// reordering. No-op if the target index resolves to the row's current
// position.
export const reorderTo = mutation({
  args: {
    id: v.id("daily_tasks"),
    targetIndex: v.number(),
  },
  handler: async (ctx, { id, targetIndex }) => {
    const userId = await requireUserId(ctx);
    const task = await getOwned<Doc<"daily_tasks">>(ctx, id, userId);
    const all = await ctx.db
      .query("daily_tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const group = all
      .filter((t) => (t.parentId ?? undefined) === (task.parentId ?? undefined))
      .sort((a, b) => a.order - b.order);
    const fromIdx = group.findIndex((t) => t._id === id);
    if (fromIdx === -1) return;
    const clamped = Math.max(0, Math.min(group.length - 1, targetIndex));
    if (fromIdx === clamped) return;
    const reordered = [...group];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(clamped, 0, moved);
    const rec = new UndoRecorder(ctx, userId);
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].order !== i) {
        await rec.patch("daily_tasks", reordered[i]._id, { order: i });
      }
    }
    await rec.commit("Reorder task");
  },
});

// Set / clear the color tag on a task. Pass color=undefined to clear.
export const setColor = mutation({
  args: {
    id: v.id("daily_tasks"),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { id, color }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { color });
    await rec.commit(color ? "Set color" : "Clear color");
  },
});

export const setHabitTag = mutation({
  args: {
    id: v.id("daily_tasks"),
    habitId: v.optional(v.id("habits")),
  },
  handler: async (ctx, { id, habitId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    if (habitId) await getOwned(ctx, habitId, userId);
    const rec = new UndoRecorder(ctx, userId);
    await rec.patch("daily_tasks", id, { habitId });
    await rec.commit("Tag habit");
  },
});
