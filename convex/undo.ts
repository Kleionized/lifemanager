import { mutation, query } from "./_generated/server";
import { requireUserId } from "./_auth_helpers";
import { applyInverse } from "./_undo";

// Latest entry in the undo log for this user. Used to power the menu
// label (and to grey out ⌘Z when there's nothing to undo).
export const peek = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("undo_log")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .collect();
    if (rows.length === 0) return null;
    const latest = rows.sort((a, b) => b.createdAt - a.createdAt)[0];
    return { id: latest._id, description: latest.description };
  },
});

export const pop = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("undo_log")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .collect();
    if (rows.length === 0) return null;
    const latest = rows.sort((a, b) => b.createdAt - a.createdAt)[0];
    await applyInverse(ctx, latest.inverse as any, userId);
    await ctx.db.delete(latest._id);
    return { description: latest.description };
  },
});
