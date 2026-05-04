// Adapter between Convex (flat parentId rows, separate cadence fields, etc.)
// and the shape Todos.jsx already expects (`state` blob with nested
// `children[]` and `cadence: { kind, ... }`).
//
// Refactor strategy: instead of touching every read/write site in the 5800-line
// component, this hook exposes the same `{state, ...mutators}` API the
// component already uses. Each mutator is mapped to the equivalent Convex
// mutation. Path-based mutators (legacy of nested arrays) collapse to the
// leaf id — only the last element of a `path` array identifies the row.

import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { isoDate, mondayOf, addDays, dayOffsetFromMonday, todayKey } from "./dates";

function nestTasks(flat) {
  // Reconstructs the flat parentId rows into the legacy nested
  // children[] shape Todos.jsx expects. Surfaces the optional `color`
  // field so weekly + daily TaskRow share the same render code.
  const byParent = new Map();
  for (const t of flat) {
    const k = t.parentId || "__root__";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(t);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const attach = (parentId) => {
    const kids = byParent.get(parentId || "__root__") || [];
    return kids.map((c) => ({
      id: c._id,
      title: c.title,
      done: c.done,
      createdAt: c.createdAt,
      habitId: c.habitId || null,
      color: c.color || null,
      day: c.day,
      date: c.date || null,
      order: c.order ?? 0,
      children: attach(c._id),
    }));
  };
  return attach(null);
}

function habitFromConvex(h) {
  const cadence =
    h.cadenceKind === "weekly_count"
      ? { kind: "weekly_count", count: h.cadenceCount ?? 1 }
      : h.cadenceKind === "weekdays"
      ? { kind: "weekdays", days: h.cadenceDays || [] }
      : { kind: "daily" };
  return {
    id: h._id,
    title: h.title,
    cadence,
    autoGenerateTodo: !!h.autoGenerateTodo,
    linkedProjectId: h.linkedProjectId || null,
    createdAt: h.createdAt,
  };
}

function goalFromConvex(g) {
  return {
    id: g._id,
    title: g.title,
    description: g.description || "",
    targetDate: g.targetDate || null,
    status: g.status,
    progress: g.progress ?? null,
    projectIds: g.projectIds || [],
    createdAt: g.createdAt,
  };
}

function projectFromConvex(p, tasksFlat) {
  return {
    id: p._id,
    title: p.title,
    type: p.type,
    icon: p.icon,
    startMonday: p.startMonday,
    mainGoal: p.mainGoal || "",
    deadline: p.deadline || null,
    milestones: p.milestones || {},
    tasks: nestTasks(tasksFlat),
    weeks: [],
    createdAt: p.createdAt,
  };
}

function completionFromConvex(c) {
  return {
    id: c._id,
    habitId: c.habitId,
    date: c.date,
    sourceTodoId: c.sourceTodoId || null,
    createdAt: c.createdAt,
  };
}

// Take last element of path; if empty, undefined (for "root").
function leafId(path) {
  if (!path || !Array.isArray(path) || path.length === 0) return undefined;
  return path[path.length - 1];
}

export function useDataLayer() {
  // ── Queries ───────────────────────────────────────────────────────
  const ui = useQuery(api.ui.get);
  const dailyFlat = useQuery(api.dailyTasks.list);
  const weeklyFlat = useQuery(api.weeklyTasks.list);
  const projectsRaw = useQuery(api.projects.list);
  const projectTasksFlat = useQuery(api.projectTasks.listAll);
  const goalsRaw = useQuery(api.goals.list);
  const habitsRaw = useQuery(api.habits.list);
  const habitCompletionsRaw = useQuery(api.habitCompletions.list);

  const ready =
    ui !== undefined &&
    dailyFlat !== undefined &&
    weeklyFlat !== undefined &&
    projectsRaw !== undefined &&
    projectTasksFlat !== undefined &&
    goalsRaw !== undefined &&
    habitsRaw !== undefined &&
    habitCompletionsRaw !== undefined;

  // ── Reconstruct UI-shape state ────────────────────────────────────
  const state = useMemo(() => {
    if (!ready) {
      return {
        daily: [],
        weekly: [],
        projects: [],
        goals: [],
        habits: [],
        habitCompletions: [],
      };
    }
    const daily = nestTasks(dailyFlat);
    const weekly = nestTasks(weeklyFlat);
    const tasksByProject = new Map();
    for (const t of projectTasksFlat) {
      if (!tasksByProject.has(t.projectId)) {
        tasksByProject.set(t.projectId, []);
      }
      tasksByProject.get(t.projectId).push(t);
    }
    const projects = projectsRaw.map((p) =>
      projectFromConvex(p, tasksByProject.get(p._id) || [])
    );
    return {
      daily,
      weekly,
      projects,
      goals: goalsRaw.map(goalFromConvex),
      habits: habitsRaw.map(habitFromConvex),
      habitCompletions: habitCompletionsRaw.map(completionFromConvex),
    };
  }, [
    ready,
    dailyFlat,
    weeklyFlat,
    projectsRaw,
    projectTasksFlat,
    goalsRaw,
    habitsRaw,
    habitCompletionsRaw,
  ]);

  // ── Mutations ─────────────────────────────────────────────────────
  // UI
  const mSetTheme = useMutation(api.ui.setTheme);
  const mSetSidebar = useMutation(api.ui.setSidebarOpen);
  const mSetWeeklyMode = useMutation(api.ui.setWeeklyMode);
  const mSetView = useMutation(api.ui.setView);
  const mSetCollapsedIds = useMutation(api.ui.setCollapsedIds);

  // Daily — toggle/update/delete are hot (clicked while looking at the row),
  // so they patch the local query optimistically to keep the UI snappy.
  const mAddDaily = useMutation(api.dailyTasks.add);
  const mAddAtDaily = useMutation(api.dailyTasks.addAt);
  const mUpdateDaily = useMutation(
    api.dailyTasks.updateTitle
  ).withOptimisticUpdate((local, { id, title }) => {
    const cur = local.getQuery(api.dailyTasks.list);
    if (cur === undefined) return;
    local.setQuery(
      api.dailyTasks.list,
      {},
      cur.map((t) => (t._id === id ? { ...t, title } : t))
    );
  });
  const mToggleDaily = useMutation(
    api.dailyTasks.toggleDone
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.dailyTasks.list);
    if (cur === undefined) return;
    local.setQuery(
      api.dailyTasks.list,
      {},
      cur.map((t) => (t._id === id ? { ...t, done: !t.done } : t))
    );
  });
  const mDeleteDaily = useMutation(
    api.dailyTasks.remove
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.dailyTasks.list);
    if (cur === undefined) return;
    // Drop id and its descendants.
    const drop = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of cur) {
        if (t.parentId && drop.has(t.parentId) && !drop.has(t._id)) {
          drop.add(t._id);
          changed = true;
        }
      }
    }
    local.setQuery(
      api.dailyTasks.list,
      {},
      cur.filter((t) => !drop.has(t._id))
    );
  });
  const mSetDailyHabitTag = useMutation(api.dailyTasks.setHabitTag);
  const mReorderToDaily = useMutation(api.dailyTasks.reorderTo);
  const mSetDailyColor = useMutation(api.dailyTasks.setColor);

  // Weekly
  const mAddWeekly = useMutation(api.weeklyTasks.add);
  const mAddAtWeekly = useMutation(api.weeklyTasks.addAt);
  const mUpdateWeekly = useMutation(
    api.weeklyTasks.updateTitle
  ).withOptimisticUpdate((local, { id, title }) => {
    const cur = local.getQuery(api.weeklyTasks.list);
    if (cur === undefined) return;
    local.setQuery(
      api.weeklyTasks.list,
      {},
      cur.map((t) => (t._id === id ? { ...t, title } : t))
    );
  });
  const mToggleWeekly = useMutation(
    api.weeklyTasks.toggleDone
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.weeklyTasks.list);
    if (cur === undefined) return;
    local.setQuery(
      api.weeklyTasks.list,
      {},
      cur.map((t) => (t._id === id ? { ...t, done: !t.done } : t))
    );
  });
  const mDeleteWeekly = useMutation(
    api.weeklyTasks.remove
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.weeklyTasks.list);
    if (cur === undefined) return;
    const drop = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of cur) {
        if (t.parentId && drop.has(t.parentId) && !drop.has(t._id)) {
          drop.add(t._id);
          changed = true;
        }
      }
    }
    local.setQuery(
      api.weeklyTasks.list,
      {},
      cur.filter((t) => !drop.has(t._id))
    );
  });
  const mSetWeeklyHabitTag = useMutation(api.weeklyTasks.setHabitTag);
  const mReorderToWeekly = useMutation(api.weeklyTasks.reorderTo);
  const mSetWeeklyColor = useMutation(api.weeklyTasks.setColor);

  // Projects
  const mAddProject = useMutation(api.projects.add);
  const mDeleteProject = useMutation(api.projects.remove);
  const mUpdateProjectTitle = useMutation(api.projects.updateTitle);
  const mCycleProjectType = useMutation(api.projects.cycleType);
  const mSetProjectIcon = useMutation(api.projects.setIcon);
  const mSetProjectMainGoal = useMutation(api.projects.setMainGoal);
  const mSetProjectDeadline = useMutation(api.projects.setDeadline);
  const mSetProjectMilestone = useMutation(api.projects.setMilestone);

  // Project tasks
  const mAddProjectTask = useMutation(api.projectTasks.add);
  const mAddAtProjectTask = useMutation(api.projectTasks.addAt);
  const mUpdateProjectTask = useMutation(
    api.projectTasks.updateTitle
  ).withOptimisticUpdate((local, { id, title }) => {
    const cur = local.getQuery(api.projectTasks.listAll);
    if (cur === undefined) return;
    local.setQuery(
      api.projectTasks.listAll,
      {},
      cur.map((t) => (t._id === id ? { ...t, title } : t))
    );
  });
  const mToggleProjectTask = useMutation(
    api.projectTasks.toggleDone
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.projectTasks.listAll);
    if (cur === undefined) return;
    local.setQuery(
      api.projectTasks.listAll,
      {},
      cur.map((t) => (t._id === id ? { ...t, done: !t.done } : t))
    );
  });
  const mSetProjectTaskDate = useMutation(api.projectTasks.setDate);
  const mDeleteProjectTask = useMutation(
    api.projectTasks.remove
  ).withOptimisticUpdate((local, { id }) => {
    const cur = local.getQuery(api.projectTasks.listAll);
    if (cur === undefined) return;
    const drop = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of cur) {
        if (t.parentId && drop.has(t.parentId) && !drop.has(t._id)) {
          drop.add(t._id);
          changed = true;
        }
      }
    }
    local.setQuery(
      api.projectTasks.listAll,
      {},
      cur.filter((t) => !drop.has(t._id))
    );
  });
  const mReorderProjectTask = useMutation(
    api.projectTasks.reorder
  ).withOptimisticUpdate((local, { id, direction }) => {
    const cur = local.getQuery(api.projectTasks.listAll);
    if (cur === undefined) return;
    const target = cur.find((t) => t._id === id);
    if (!target) return;
    const group = cur
      .filter(
        (t) =>
          t.projectId === target.projectId &&
          (t.parentId ?? null) === (target.parentId ?? null) &&
          (t.date ?? null) === (target.date ?? null)
      )
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = group.findIndex((t) => t._id === id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= group.length) return;
    const a = group[idx];
    const b = group[swapIdx];
    local.setQuery(
      api.projectTasks.listAll,
      {},
      cur.map((t) => {
        if (t._id === a._id) return { ...t, order: b.order };
        if (t._id === b._id) return { ...t, order: a.order };
        return t;
      })
    );
  });
  const mSetProjectTaskHabitTag = useMutation(api.projectTasks.setHabitTag);

  // Goals
  const mAddGoal = useMutation(api.goals.add);
  const mUpdateGoal = useMutation(api.goals.update);
  const mSetGoalStatus = useMutation(api.goals.setStatus);
  const mSetGoalProgress = useMutation(api.goals.setProgress);
  const mLinkGoal = useMutation(api.goals.linkProject);
  const mUnlinkGoal = useMutation(api.goals.unlinkProject);
  const mDeleteGoal = useMutation(api.goals.remove);

  // Habits
  const mAddHabit = useMutation(api.habits.add);
  const mUpdateHabit = useMutation(api.habits.update);
  const mDeleteHabit = useMutation(api.habits.remove);
  const mToggleHabitVirtual = useMutation(api.habitCompletions.toggleVirtual);

  // Plans
  const plansList = useQuery(api.plans.list);
  const mEnsureTrinitySeed = useMutation(api.plans.ensureTrinitySeed);
  const activePlan = (plansList || []).find((p) => p.active) || (plansList || [])[0] || null;
  const planBundle = useQuery(
    api.plans.getBundle,
    activePlan ? { planId: activePlan._id } : "skip"
  );

  // Migration
  const mImportV3 = useMutation(api.migration.importV3);

  // Undo
  const mPopUndo = useMutation(api.undo.pop);
  const undoPeek = useQuery(api.undo.peek);

  // Used to look up a daily task by id (for habit-tag toggle bookkeeping).
  const findDailyTaskFlat = (id) =>
    (dailyFlat || []).find((t) => t._id === id);
  const findWeeklyTaskFlat = (id) =>
    (weeklyFlat || []).find((t) => t._id === id);

  // ── Mutator API (matches Todos.jsx existing names) ───────────────

  // Daily — every adder returns Promise<id> so the caller can await
  // the new row's id and immediately enter edit mode on it.
  const addDaily = (title) => {
    const t = (title || "").trim();
    if (!t) return mAddDaily({ title: "" });
    return mAddDaily({ title: t });
  };
  const addDailyChild = (parentPath, title) => {
    const t = (title || "").trim();
    return mAddDaily({ title: t, parentId: leafId(parentPath) });
  };
  const addAtDaily = (parentPath = []) =>
    mAddDaily({ title: "", parentId: leafId(parentPath) });
  const toggleDaily = (path) => {
    const id = leafId(path);
    if (!id) return;
    mToggleDaily({ id, date: isoDate(new Date()) });
  };
  const updateDaily = (path, title) => {
    const id = leafId(path);
    if (!id) return;
    const t = (title || "").trim();
    if (!t) {
      mDeleteDaily({ id });
      return;
    }
    mUpdateDaily({ id, title: t });
  };
  const deleteDaily = (path) => {
    const id = leafId(path);
    if (!id) return;
    mDeleteDaily({ id });
  };
  const reorderDailyTo = (id, targetIndex) =>
    mReorderToDaily({ id, targetIndex });
  const setDailyColor = (id, color) =>
    mSetDailyColor({ id, color: color || undefined });

  // Weekly
  const addWeekly = (title, day) => {
    const t = (title || "").trim();
    const d = day || todayKey();
    return mAddWeekly({ title: t, day: d });
  };
  const addWeeklyChild = (parentPath, title) => {
    const t = (title || "").trim();
    const parentId = leafId(parentPath);
    const parent = parentId ? findWeeklyTaskFlat(parentId) : null;
    const day = parent?.day || todayKey();
    return mAddWeekly({ title: t, day, parentId });
  };
  const addAtWeekly = (parentPath, day) => {
    const parentId = leafId(parentPath);
    const parent = parentId ? findWeeklyTaskFlat(parentId) : null;
    const d = parent?.day || day || todayKey();
    return mAddWeekly({ title: "", day: d, parentId });
  };
  const toggleWeekly = (path) => {
    const id = leafId(path);
    if (!id) return;
    const task = findWeeklyTaskFlat(id);
    const day = task?.day || todayKey();
    const monday = mondayOf(new Date());
    const dayDate = addDays(monday, dayOffsetFromMonday(day));
    mToggleWeekly({ id, date: isoDate(dayDate) });
  };
  const updateWeekly = (path, title) => {
    const id = leafId(path);
    if (!id) return;
    const t = (title || "").trim();
    if (!t) {
      mDeleteWeekly({ id });
      return;
    }
    mUpdateWeekly({ id, title: t });
  };
  const deleteWeekly = (path) => {
    const id = leafId(path);
    if (!id) return;
    mDeleteWeekly({ id });
  };
  const reorderWeeklyTo = (id, targetIndex) =>
    mReorderToWeekly({ id, targetIndex });
  const setWeeklyColor = (id, color) =>
    mSetWeeklyColor({ id, color: color || undefined });

  // Projects
  const addProject = (type) => {
    const startMonday = isoDate(mondayOf(new Date()));
    const icon = type === "goal" ? "flag" : "target";
    mAddProject({
      title: "Untitled project",
      type: type === "goal" ? "goal" : "project",
      icon,
      startMonday,
    });
  };
  const deleteProject = (projectId) => mDeleteProject({ id: projectId });
  const updateProjectTitle = (projectId, title) => {
    const t = (title || "").trim();
    if (!t) return;
    mUpdateProjectTitle({ id: projectId, title: t });
  };
  const cycleProjectType = (projectId) =>
    mCycleProjectType({ id: projectId });
  const setProjectIcon = (projectId, iconName) =>
    mSetProjectIcon({ id: projectId, icon: iconName });

  // Legacy goal-shape no-ops (legacy goal projects are dropped on migration).
  const addWeek = () => {};
  const deleteWeek = () => {};
  const addProjectTask = () => {};
  const addProjectTaskChild = () => {};
  const addAtProjectTask = () => {};
  const toggleProjectTask = () => {};
  const updateProjectTaskTitle = () => {};
  const deleteProjectTask = () => {};

  const setProjectMainGoal = (projectId, text) =>
    mSetProjectMainGoal({ id: projectId, mainGoal: text || "" });
  const setProjectDeadline = (projectId, iso) =>
    mSetProjectDeadline({ id: projectId, deadline: iso || undefined });
  const setProjectMilestone = (projectId, weekStartIso, text) =>
    mSetProjectMilestone({
      id: projectId,
      iso: weekStartIso,
      text: text || "",
    });

  const addProjectDatedTask = (projectId, date, title) => {
    const t = (title || "").trim();
    return mAddProjectTask({
      projectId,
      title: t,
      date: date || undefined,
    });
  };
  const addProjectDatedTaskChild = (projectId, parentPath, title) => {
    const t = (title || "").trim();
    return mAddProjectTask({
      projectId,
      title: t,
      parentId: leafId(parentPath),
    });
  };
  const addAtProjectDatedTask = (projectId, parentPath, dateForRoot) => {
    const parentId = leafId(parentPath);
    if (parentId) {
      return mAddProjectTask({ projectId, title: "", parentId });
    }
    return mAddProjectTask({
      projectId,
      title: "",
      date: dateForRoot || undefined,
    });
  };
  const toggleProjectDatedTask = (projectId, path) => {
    const id = leafId(path);
    if (!id) return;
    mToggleProjectTask({ id });
  };
  const updateProjectDatedTaskTitle = (projectId, path, title) => {
    const id = leafId(path);
    if (!id) return;
    const t = (title || "").trim();
    if (!t) {
      mDeleteProjectTask({ id });
      return;
    }
    mUpdateProjectTask({ id, title: t });
  };
  const deleteProjectDatedTask = (projectId, path) => {
    const id = leafId(path);
    if (!id) return;
    mDeleteProjectTask({ id });
  };
  const setProjectTaskDate = (projectId, path, dateIso) => {
    const id = leafId(path);
    if (!id) return;
    mSetProjectTaskDate({ id, date: dateIso || undefined });
  };
  const reorderProjectDatedTask = (projectId, path, direction) => {
    const id = leafId(path);
    if (!id) return;
    mReorderProjectTask({ id, direction });
  };

  // Goals
  const addGoal = (title) => {
    const t = (title || "").trim();
    if (!t) return null;
    mAddGoal({ title: t, description: "", projectIds: [] });
    return null; // no sync id available
  };
  const updateGoal = (goalId, patch) => {
    const arg = { id: goalId };
    if (patch.title !== undefined) arg.title = patch.title;
    if (patch.description !== undefined) arg.description = patch.description;
    if (patch.targetDate !== undefined) {
      arg.targetDate = patch.targetDate || undefined;
    }
    mUpdateGoal(arg);
  };
  const setGoalStatus = (goalId, status) =>
    mSetGoalStatus({ id: goalId, status });
  const setGoalProgress = (goalId, progress) =>
    mSetGoalProgress({
      id: goalId,
      progress: progress === null ? undefined : progress,
    });
  const linkGoalToProject = (goalId, projectId) =>
    mLinkGoal({ id: goalId, projectId });
  const unlinkGoalFromProject = (goalId, projectId) =>
    mUnlinkGoal({ id: goalId, projectId });
  const deleteGoal = (goalId) => mDeleteGoal({ id: goalId });

  // Habits
  const addHabit = (title, cadenceOverride) => {
    const t = (title || "").trim();
    if (!t) return;
    const cadence = cadenceOverride || { kind: "daily" };
    mAddHabit({
      title: t,
      cadenceKind: cadence.kind,
      cadenceCount:
        cadence.kind === "weekly_count" ? cadence.count : undefined,
      cadenceDays: cadence.kind === "weekdays" ? cadence.days : undefined,
      autoGenerateTodo: false,
    });
  };
  const updateHabit = (habitId, patch) => {
    const arg = { id: habitId };
    if (patch.title !== undefined) arg.title = patch.title;
    if (patch.cadence !== undefined) {
      arg.cadenceKind = patch.cadence.kind;
      if (patch.cadence.kind === "weekly_count") {
        arg.cadenceCount = patch.cadence.count;
      }
      if (patch.cadence.kind === "weekdays") {
        arg.cadenceDays = patch.cadence.days;
      }
    }
    if (patch.autoGenerateTodo !== undefined) {
      arg.autoGenerateTodo = patch.autoGenerateTodo;
    }
    if (patch.linkedProjectId !== undefined) {
      arg.linkedProjectId = patch.linkedProjectId || undefined;
    }
    mUpdateHabit(arg);
  };
  const setHabitCadence = (habitId, cadence) =>
    updateHabit(habitId, { cadence });
  const setHabitLinkedProject = (habitId, projectId) =>
    updateHabit(habitId, { linkedProjectId: projectId || undefined });
  const setHabitAutoGenerate = (habitId, value) =>
    updateHabit(habitId, { autoGenerateTodo: !!value });
  const deleteHabit = (habitId) => mDeleteHabit({ id: habitId });

  // Habit completions
  const toggleHabitVirtual = (habitId, date) =>
    mToggleHabitVirtual({ habitId, date });
  // The completion lifecycle for tagged tasks runs server-side via the
  // toggle mutations. These two are kept as no-ops for compatibility.
  const addHabitCompletion = () => {};
  const removeHabitCompletion = () => {};

  const setTaskHabitTag = (scope, path, habitId) => {
    const id = leafId(path);
    if (!id) return;
    if (scope === "daily")
      mSetDailyHabitTag({ id, habitId: habitId || undefined });
    else if (scope === "weekly")
      mSetWeeklyHabitTag({ id, habitId: habitId || undefined });
    else if (scope && scope.projectId)
      mSetProjectTaskHabitTag({ id, habitId: habitId || undefined });
  };

  return {
    // data
    ready,
    state,
    ui: ui || null,
    // ui setters
    setTheme: (t) => mSetTheme({ theme: t }),
    setSidebarOpen: (open) => mSetSidebar({ sidebarOpen: !!open }),
    setWeeklyMode: (m) => mSetWeeklyMode({ weeklyMode: m }),
    setView: (v) => mSetView({ view: v }),
    setCollapsedIds: (arr) => mSetCollapsedIds({ collapsedIds: arr }),
    // daily
    addDaily,
    addDailyChild,
    addAtDaily,
    toggleDaily,
    updateDaily,
    deleteDaily,
    reorderDailyTo,
    setDailyColor,
    // weekly
    addWeekly,
    addWeeklyChild,
    addAtWeekly,
    toggleWeekly,
    updateWeekly,
    deleteWeekly,
    reorderWeeklyTo,
    setWeeklyColor,
    // projects
    addProject,
    deleteProject,
    updateProjectTitle,
    cycleProjectType,
    setProjectIcon,
    addWeek,
    deleteWeek,
    addProjectTask,
    addProjectTaskChild,
    addAtProjectTask,
    toggleProjectTask,
    updateProjectTaskTitle,
    deleteProjectTask,
    setProjectMainGoal,
    setProjectDeadline,
    setProjectMilestone,
    addProjectDatedTask,
    addProjectDatedTaskChild,
    addAtProjectDatedTask,
    toggleProjectDatedTask,
    updateProjectDatedTaskTitle,
    deleteProjectDatedTask,
    setProjectTaskDate,
    reorderProjectDatedTask,
    // goals
    addGoal,
    updateGoal,
    setGoalStatus,
    setGoalProgress,
    linkGoalToProject,
    unlinkGoalFromProject,
    deleteGoal,
    // habits
    addHabit,
    updateHabit,
    setHabitCadence,
    setHabitLinkedProject,
    setHabitAutoGenerate,
    deleteHabit,
    addHabitCompletion,
    removeHabitCompletion,
    toggleHabitVirtual,
    setTaskHabitTag,
    // plans
    plansList: plansList || null,
    activePlan,
    planBundle: planBundle || null,
    ensureTrinitySeed: () => mEnsureTrinitySeed({}),
    // migration
    importV3: mImportV3,
    // undo
    popUndo: mPopUndo,
    undoPeek: undoPeek || null,
  };
}
