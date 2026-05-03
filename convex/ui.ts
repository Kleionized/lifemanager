import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId } from "./_auth_helpers";

const DEFAULTS = {
  theme: "light",
  sidebarOpen: true,
  weeklyMode: "grid",
  collapsedIds: [] as string[],
  view: { type: "today" } as any,
};

// One row per user. We lazily ensure it exists on first read.
export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("ui")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) {
      return { userId, ...DEFAULTS };
    }
    return row;
  },
});

async function ensureRow(ctx: any, userId: any) {
  const row = await ctx.db
    .query("ui")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert("ui", { userId, ...DEFAULTS });
  return await ctx.db.get(id);
}

export const setTheme = mutation({
  args: { theme: v.string() },
  handler: async (ctx, { theme }) => {
    const userId = await requireUserId(ctx);
    const row = await ensureRow(ctx, userId);
    await ctx.db.patch(row._id, { theme });
  },
});

export const setSidebarOpen = mutation({
  args: { sidebarOpen: v.boolean() },
  handler: async (ctx, { sidebarOpen }) => {
    const userId = await requireUserId(ctx);
    const row = await ensureRow(ctx, userId);
    await ctx.db.patch(row._id, { sidebarOpen });
  },
});

export const setWeeklyMode = mutation({
  args: { weeklyMode: v.string() },
  handler: async (ctx, { weeklyMode }) => {
    const userId = await requireUserId(ctx);
    const row = await ensureRow(ctx, userId);
    await ctx.db.patch(row._id, { weeklyMode });
  },
});

export const setView = mutation({
  args: { view: v.any() },
  handler: async (ctx, { view }) => {
    const userId = await requireUserId(ctx);
    const row = await ensureRow(ctx, userId);
    await ctx.db.patch(row._id, { view });
  },
});

export const setCollapsedIds = mutation({
  args: { collapsedIds: v.array(v.string()) },
  handler: async (ctx, { collapsedIds }) => {
    const userId = await requireUserId(ctx);
    const row = await ensureRow(ctx, userId);
    await ctx.db.patch(row._id, { collapsedIds });
  },
});
