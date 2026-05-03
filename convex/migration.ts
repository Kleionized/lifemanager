import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUserId } from "./_auth_helpers";
import type { Id } from "./_generated/dataModel";

// One-time push of localStorage v3 → Convex. Client passes the parsed v3
// blob; server inserts everything in a single transaction, remapping all
// id references in the process.
//
// Idempotency: the client should only call this if its local data is
// non-empty AND the server is empty. We additionally bail if any rows
// already exist for this user.
export const importV3 = mutation({
  args: {
    payload: v.any(),
  },
  handler: async (ctx, { payload }) => {
    const userId = await requireUserId(ctx);

    // Bail if the user already has any tasks/projects/goals/habits.
    const existingDaily = await ctx.db
      .query("daily_tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const existingHabits = await ctx.db
      .query("habits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existingDaily || existingProject || existingHabits) {
      return { imported: false, reason: "already_imported" };
    }

    const now = Date.now();
    let droppedLegacyGoals = 0;

    // ── Habits first (other rows reference habit ids) ─────────────────
    const habitOldToNew = new Map<string, Id<"habits">>();
    const habits = Array.isArray(payload?.habits) ? payload.habits : [];
    for (let i = 0; i < habits.length; i++) {
      const h = habits[i];
      const cadence = h?.cadence || { kind: "daily" };
      const newId = await ctx.db.insert("habits", {
        userId,
        title: h.title || "Untitled",
        cadenceKind: cadence.kind || "daily",
        cadenceCount:
          cadence.kind === "weekly_count" ? cadence.count : undefined,
        cadenceDays:
          cadence.kind === "weekdays" ? cadence.days || [] : undefined,
        autoGenerateTodo: !!h.autoGenerateTodo,
        // linkedProjectId mapped after projects exist.
        linkedProjectId: undefined,
        order: i,
        createdAt: h.createdAt || now,
      });
      habitOldToNew.set(h.id, newId);
    }

    // ── Projects (skip legacy type === "goal") ────────────────────────
    const projectOldToNew = new Map<string, Id<"projects">>();
    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    let projOrder = 0;
    for (const p of projects) {
      if (p.type === "goal") {
        droppedLegacyGoals += 1;
        continue;
      }
      const newId = await ctx.db.insert("projects", {
        userId,
        title: p.title || "Untitled",
        type: "project",
        icon: p.icon || "target",
        startMonday: p.startMonday || isoToday(),
        mainGoal: p.mainGoal || undefined,
        deadline: p.deadline || undefined,
        milestones: p.milestones || undefined,
        order: projOrder++,
        createdAt: p.createdAt || now,
      });
      projectOldToNew.set(p.id, newId);
    }

    // Wire linkedProjectId on habits now that projects exist.
    for (const h of habits) {
      if (h.linkedProjectId && projectOldToNew.has(h.linkedProjectId)) {
        const habitNew = habitOldToNew.get(h.id);
        if (habitNew) {
          await ctx.db.patch(habitNew, {
            linkedProjectId: projectOldToNew.get(h.linkedProjectId),
          });
        }
      }
    }

    // ── Daily tasks (recursive flatten) ───────────────────────────────
    const dailyOldToNew = new Map<string, Id<"daily_tasks">>();
    const daily = Array.isArray(payload?.daily) ? payload.daily : [];
    let dailyOrderCounter = 0;
    async function insertDaily(
      task: any,
      parentId: Id<"daily_tasks"> | undefined,
      order: number
    ) {
      const habitNew = task.habitId
        ? habitOldToNew.get(task.habitId)
        : undefined;
      const newId = await ctx.db.insert("daily_tasks", {
        userId,
        title: task.title || "",
        done: !!task.done,
        parentId,
        order,
        habitId: habitNew,
        createdAt: task.createdAt || now,
      });
      dailyOldToNew.set(task.id, newId);
      const kids = Array.isArray(task.children) ? task.children : [];
      for (let i = 0; i < kids.length; i++) {
        await insertDaily(kids[i], newId, i);
      }
    }
    for (const t of daily) {
      await insertDaily(t, undefined, dailyOrderCounter++);
    }

    // ── Weekly tasks ──────────────────────────────────────────────────
    const weeklyOldToNew = new Map<string, Id<"weekly_tasks">>();
    const weekly = Array.isArray(payload?.weekly) ? payload.weekly : [];
    const weeklyOrderByDay: Record<string, number> = {};
    async function insertWeekly(
      task: any,
      day: string,
      parentId: Id<"weekly_tasks"> | undefined,
      order: number
    ) {
      const habitNew = task.habitId
        ? habitOldToNew.get(task.habitId)
        : undefined;
      const newId = await ctx.db.insert("weekly_tasks", {
        userId,
        title: task.title || "",
        done: !!task.done,
        day,
        parentId,
        order,
        habitId: habitNew,
        createdAt: task.createdAt || now,
      });
      weeklyOldToNew.set(task.id, newId);
      const kids = Array.isArray(task.children) ? task.children : [];
      for (let i = 0; i < kids.length; i++) {
        await insertWeekly(kids[i], day, newId, i);
      }
    }
    for (const t of weekly) {
      const day = t.day || "mon";
      const ord = (weeklyOrderByDay[day] ?? -1) + 1;
      weeklyOrderByDay[day] = ord;
      await insertWeekly(t, day, undefined, ord);
    }

    // ── Project tasks ─────────────────────────────────────────────────
    const projectTaskOldToNew = new Map<string, Id<"project_tasks">>();
    for (const p of projects) {
      if (p.type === "goal") continue;
      const projectNew = projectOldToNew.get(p.id);
      if (!projectNew) continue;
      const tasks = Array.isArray(p.tasks) ? p.tasks : [];
      // Track per-(date,parent) order counters.
      const orderKey: Record<string, number> = {};
      async function insertProjectTask(
        task: any,
        parentId: Id<"project_tasks"> | undefined
      ) {
        const date = task.date || undefined;
        const k = `${date ?? ""}|${parentId ?? ""}`;
        const ord = (orderKey[k] ?? -1) + 1;
        orderKey[k] = ord;
        const habitNew = task.habitId
          ? habitOldToNew.get(task.habitId)
          : undefined;
        const newId = await ctx.db.insert("project_tasks", {
          userId,
          projectId: projectNew!,
          title: task.title || "",
          done: !!task.done,
          date,
          parentId,
          order: ord,
          habitId: habitNew,
          createdAt: task.createdAt || now,
        });
        projectTaskOldToNew.set(task.id, newId);
        const kids = Array.isArray(task.children) ? task.children : [];
        for (const k of kids) {
          await insertProjectTask(k, newId);
        }
      }
      for (const t of tasks) {
        await insertProjectTask(t, undefined);
      }
    }

    // ── Goals ─────────────────────────────────────────────────────────
    const goals = Array.isArray(payload?.goals) ? payload.goals : [];
    let goalOrder = 0;
    for (const g of goals) {
      const remappedProjectIds: Id<"projects">[] = [];
      for (const oldPid of g.projectIds || []) {
        const newPid = projectOldToNew.get(oldPid);
        if (newPid) remappedProjectIds.push(newPid);
      }
      await ctx.db.insert("goals", {
        userId,
        title: g.title || "Untitled",
        description: g.description || "",
        targetDate: g.targetDate || undefined,
        status: g.status || "active",
        progress: g.progress ?? undefined,
        projectIds: remappedProjectIds,
        order: goalOrder++,
        createdAt: g.createdAt || now,
      });
    }

    // ── Habit completions ─────────────────────────────────────────────
    const completions = Array.isArray(payload?.habitCompletions)
      ? payload.habitCompletions
      : [];
    for (const c of completions) {
      const habitNew = habitOldToNew.get(c.habitId);
      if (!habitNew || !c.date) continue;
      // sourceTodoId may point at a daily/weekly/project task; remap if known.
      let sourceTodoId: string | undefined = undefined;
      if (c.sourceTodoId) {
        const remap =
          dailyOldToNew.get(c.sourceTodoId) ??
          weeklyOldToNew.get(c.sourceTodoId) ??
          projectTaskOldToNew.get(c.sourceTodoId);
        sourceTodoId = remap ?? undefined;
      }
      await ctx.db.insert("habit_completions", {
        userId,
        habitId: habitNew,
        date: c.date,
        sourceTodoId,
        createdAt: c.createdAt || now,
      });
    }

    return {
      imported: true,
      droppedLegacyGoals,
      counts: {
        habits: habitOldToNew.size,
        projects: projectOldToNew.size,
        daily: dailyOldToNew.size,
        weekly: weeklyOldToNew.size,
        projectTasks: projectTaskOldToNew.size,
        goals: goals.length,
        completions: completions.length,
      },
    };
  },
});

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
