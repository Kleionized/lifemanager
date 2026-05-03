import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import { UndoRecorder } from "./_undo";

// All completions for the current user. Used to compute streaks, heatmaps,
// "this week" progress on the client.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("habit_completions")
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .collect();
  },
});

// Recent completions only — for charts that don't need the full history.
export const listRecent = query({
  args: { sinceDate: v.string() },
  handler: async (ctx, { sinceDate }) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("habit_completions")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", userId).gte("date", sinceDate)
      )
      .collect();
  },
});

// Toggle a virtual habit row (no real task tagged). Server-enforced shape:
// (habitId, date) only — no synthetic id reaches the server.
export const toggleVirtual = mutation({
  args: {
    habitId: v.id("habits"),
    date: v.string(),
  },
  handler: async (ctx, { habitId, date }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, habitId, userId);
    const existing = await ctx.db
      .query("habit_completions")
      .withIndex("by_habit_date", (q) =>
        q.eq("habitId", habitId).eq("date", date)
      )
      .filter((q) => q.eq(q.field("sourceTodoId"), undefined))
      .unique();
    const rec = new UndoRecorder(ctx, userId);
    if (existing) {
      await rec.delete("habit_completions", existing._id);
      await rec.commit("Uncomplete habit");
    } else {
      await rec.insert("habit_completions", {
        userId,
        habitId,
        date,
        sourceTodoId: undefined,
        createdAt: Date.now(),
      });
      await rec.commit("Complete habit");
    }
  },
});
