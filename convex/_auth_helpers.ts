import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Throws on unauthenticated callers. Every query/mutation in this app
// is single-user and must be tied to a userId.
export async function requireUserId(
  ctx: QueryCtx | MutationCtx
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not authenticated");
  }
  return userId;
}

// Defense in depth: every read/patch/delete that touches a user-owned row
// must ensure the row's userId matches the caller. Wraps `db.get` + the
// ownership check.
export async function getOwned<T extends { userId: Id<"users"> }>(
  ctx: QueryCtx | MutationCtx,
  // deno-lint-ignore no-explicit-any
  id: any,
  userId: Id<"users">
): Promise<T> {
  const row = (await ctx.db.get(id)) as T | null;
  if (!row) throw new Error("Not found");
  if (row.userId !== userId) throw new Error("Not authorized");
  return row;
}

// Next order value within a sibling group. Used when inserting at the end
// of a list. Pass `parentScope` as the index name + key.
export async function nextOrder(
  ctx: MutationCtx,
  table:
    | "daily_tasks"
    | "weekly_tasks"
    | "project_tasks"
    | "projects"
    | "goals"
    | "habits",
  filter: (q: any) => any
): Promise<number> {
  const rows = await ctx.db.query(table).filter(filter).collect();
  let max = -1;
  for (const r of rows) {
    if (typeof (r as any).order === "number" && (r as any).order > max) {
      max = (r as any).order;
    }
  }
  return max + 1;
}
