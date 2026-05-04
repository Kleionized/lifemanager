// Plans backend.
//
// One plan owns its schedules (per (energy, phase)), recurring lectures
// (per dow), per-date energy choices, per-block tracking, and decision
// rules. The seed mutation below installs the Trinity-term defaults the
// HTML life-plan ships with. Schedules are editable; nothing is hardcoded
// in the React layer beyond category colors.

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId, getOwned } from "./_auth_helpers";
import type { Doc } from "./_generated/dataModel";

const BLOCK_VALIDATOR = v.object({
  s: v.string(),
  e: v.string(),
  t: v.string(),
  c: v.string(),
  d: v.string(),
});

// ─────────────── Canonical seed data ───────────────
// Block titles are intentionally generic ("Startup block" not "LNAT —
// talk to one user") so the schedule doesn't dictate what to do inside
// each block. Category id "lnat" is preserved (foreign key on existing
// data); the visible label flips to "Startup" on the React side.

// 30-min breakfast right after wake (hall closes 9:30). Schedules
// shifted 30 min earlier vs. the previous template so there's no
// awkward gap between breakfast and the first study block. Last
// startup block extended to 2 hours (was 90 min) per the
// "extend-the-previous-session-when-there's-a-gap" hint.
const SEED_SCHEDULES: { energy: string; phase: string; blocks: any[] }[] = [
  {
    energy: "high",
    phase: "essay",
    blocks: [
      { s: "08:00", e: "08:30", t: "Wake & water", c: "rest", d: "30m" },
      { s: "08:30", e: "09:00", t: "Breakfast", c: "life", d: "30m" },
      { s: "09:00", e: "10:30", t: "Finals block", c: "finals", d: "90m" },
      { s: "10:30", e: "12:00", t: "Essay block", c: "essays", d: "90m" },
      { s: "12:00", e: "13:00", t: "Lunch", c: "life", d: "60m" },
      { s: "13:00", e: "14:30", t: "Essay block", c: "essays", d: "90m" },
      { s: "14:30", e: "15:00", t: "Power nap", c: "rest", d: "30m" },
      { s: "15:00", e: "16:00", t: "Finals review", c: "finals", d: "60m" },
      { s: "16:00", e: "17:00", t: "Gym", c: "fitness", d: "60m" },
      { s: "17:00", e: "18:00", t: "Startup block", c: "lnat", d: "60m" },
      { s: "18:00", e: "19:00", t: "Dinner", c: "life", d: "60m" },
      { s: "19:00", e: "21:00", t: "Startup block", c: "lnat", d: "120m" },
      { s: "21:00", e: "23:00", t: "Wind-down", c: "rest", d: "120m" },
    ],
  },
  {
    energy: "high",
    phase: "revision",
    blocks: [
      { s: "08:00", e: "08:30", t: "Wake & water", c: "rest", d: "30m" },
      { s: "08:30", e: "09:00", t: "Breakfast", c: "life", d: "30m" },
      { s: "09:00", e: "10:30", t: "Finals block", c: "finals", d: "90m" },
      { s: "10:30", e: "12:00", t: "Past papers", c: "finals", d: "90m" },
      { s: "12:00", e: "13:00", t: "Lunch", c: "life", d: "60m" },
      { s: "13:00", e: "14:30", t: "Startup block", c: "lnat", d: "90m" },
      { s: "14:30", e: "15:00", t: "Power nap", c: "rest", d: "30m" },
      { s: "15:00", e: "16:00", t: "Finals review", c: "finals", d: "60m" },
      { s: "16:00", e: "17:00", t: "Gym", c: "fitness", d: "60m" },
      { s: "17:00", e: "18:00", t: "Startup block", c: "lnat", d: "60m" },
      { s: "18:00", e: "19:00", t: "Dinner", c: "life", d: "60m" },
      { s: "19:00", e: "21:00", t: "Startup block", c: "lnat", d: "120m" },
      { s: "21:00", e: "23:00", t: "Wind-down", c: "rest", d: "120m" },
    ],
  },
  {
    energy: "low",
    phase: "",
    blocks: [
      { s: "08:00", e: "08:30", t: "Wake slowly", c: "rest", d: "30m" },
      { s: "08:30", e: "09:00", t: "Breakfast", c: "life", d: "30m" },
      { s: "09:00", e: "10:00", t: "Finals block (light)", c: "finals", d: "60m" },
      { s: "10:00", e: "10:30", t: "Quiet time", c: "rest", d: "30m" },
      { s: "10:30", e: "12:00", t: "Startup block", c: "lnat", d: "90m" },
      { s: "12:00", e: "13:00", t: "Lunch + slow walk", c: "life", d: "60m" },
      { s: "13:00", e: "14:00", t: "Flashcards", c: "finals", d: "60m" },
      { s: "14:00", e: "14:30", t: "Mobility / easy walk", c: "fitness", d: "30m" },
      { s: "14:30", e: "16:30", t: "Tea / nap", c: "rest", d: "120m" },
      { s: "16:30", e: "17:30", t: "Startup block (optional)", c: "lnat", d: "60m" },
      { s: "17:30", e: "18:30", t: "Dinner", c: "life", d: "60m" },
      { s: "18:30", e: "22:00", t: "Wind-down", c: "rest", d: "210m" },
    ],
  },
  {
    energy: "moderate",
    phase: "",
    blocks: [
      { s: "08:00", e: "08:30", t: "Wake gently", c: "rest", d: "30m" },
      { s: "08:30", e: "09:00", t: "Breakfast", c: "life", d: "30m" },
      { s: "09:00", e: "10:00", t: "Audiobook (finals)", c: "finals", d: "60m" },
      { s: "10:00", e: "11:30", t: "Rest / nap", c: "rest", d: "90m" },
      { s: "11:30", e: "12:30", t: "Lunch", c: "life", d: "60m" },
      { s: "12:30", e: "14:30", t: "Sleep / quiet rest", c: "rest", d: "120m" },
      { s: "14:30", e: "15:00", t: "Gentle walk", c: "fitness", d: "30m" },
      { s: "15:00", e: "17:00", t: "Rest", c: "rest", d: "120m" },
      { s: "17:00", e: "18:00", t: "Dinner", c: "life", d: "60m" },
      { s: "18:00", e: "21:00", t: "Wind-down", c: "rest", d: "180m" },
    ],
  },
];

const SEED_LECTURES: Record<number, any[]> = {
  2: [
    { s: "10:40", e: "11:00", t: "Walk to lecture", c: "lecture", d: "20m" },
    { s: "11:00", e: "12:00", t: "Psych Lecture", c: "lecture", d: "60m" },
    { s: "12:00", e: "12:20", t: "Walk back", c: "lecture", d: "20m" },
  ],
  3: [
    { s: "15:25", e: "15:45", t: "Walk to tutorial", c: "lecture", d: "20m" },
    { s: "15:45", e: "16:45", t: "Psych Tutorial", c: "lecture", d: "60m" },
    { s: "16:45", e: "17:05", t: "Walk back", c: "lecture", d: "20m" },
  ],
  5: [
    { s: "13:40", e: "14:00", t: "Walk to lecture", c: "lecture", d: "20m" },
    { s: "14:00", e: "15:00", t: "Gen Phil", c: "lecture", d: "60m" },
    { s: "15:00", e: "15:20", t: "Walk between", c: "lecture", d: "20m" },
    { s: "15:20", e: "16:50", t: "Stats", c: "lecture", d: "90m" },
    { s: "16:50", e: "17:10", t: "Walk back", c: "lecture", d: "20m" },
  ],
};

// ─────────────── Plans ───────────────

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("plans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

// Bundle every plan-related table for a single plan into one query, so
// the React layer subscribes once and gets atomic updates.
export const getBundle = query({
  args: { planId: v.id("plans") },
  handler: async (ctx, { planId }) => {
    const userId = await requireUserId(ctx);
    const plan = await getOwned<Doc<"plans">>(ctx, planId, userId);
    const [schedules, lectures, days, tracking, rules] = await Promise.all([
      ctx.db
        .query("plan_schedules")
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .collect(),
      ctx.db
        .query("plan_lectures")
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .collect(),
      ctx.db
        .query("plan_days")
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .collect(),
      ctx.db
        .query("plan_tracking")
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .collect(),
      ctx.db
        .query("plan_rules")
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .collect(),
    ]);
    return {
      plan,
      schedules,
      lectures,
      days,
      tracking,
      rules: rules.sort((a, b) => a.order - b.order),
    };
  },
});

// First-time setup. Idempotent: if a plan already exists for this user,
// returns it. Otherwise inserts the Trinity-term defaults from the
// life-plan HTML.
export const ensureTrinitySeed = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("plans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing._id;

    const planId = await ctx.db.insert("plans", {
      userId,
      name: "Trinity Term",
      startDate: "2026-04-27",
      weekCount: 8,
      phaseShiftWeek: 5,
      examWeek: 8,
      goalLinks: {},
      active: true,
      createdAt: Date.now(),
    });

    for (const sched of SEED_SCHEDULES) {
      await ctx.db.insert("plan_schedules", {
        userId,
        planId,
        energy: sched.energy,
        phase: sched.phase,
        blocks: sched.blocks,
      });
    }
    for (const dowStr of Object.keys(SEED_LECTURES)) {
      const dow = Number(dowStr);
      await ctx.db.insert("plan_lectures", {
        userId,
        planId,
        dow,
        blocks: SEED_LECTURES[dow],
      });
    }

    // Rules.
    const RULES = [
      { ifText: "two low-energy days in a row", thenText: "take a sick day, don't push through" },
      { ifText: "finals coverage slips", thenText: "cut social/buffer time first, not startup (protect both pillars)" },
      { ifText: "startup has a real fire (outage, customer crisis)", thenText: "flip the day: startup primary, finals = flashcards only" },
      { ifText: "a week ends and 3+ gym sessions missed", thenText: "the schedule is wrong, drop one lift day to three" },
    ];
    for (let i = 0; i < RULES.length; i++) {
      await ctx.db.insert("plan_rules", {
        userId,
        planId,
        ifText: RULES[i].ifText,
        thenText: RULES[i].thenText,
        order: i,
      });
    }

    return planId;
  },
});

// Wipe an existing plan's schedules + lectures and reinsert the canonical
// seed values. Useful when the seed data evolves (renames, added blocks)
// and you want your existing plan to pick up the new defaults without
// editing every block by hand. Does NOT touch tracking, energy choices,
// rules, or goal links — those represent user intent.
export const resetTrinityDefaults = mutation({
  args: { planId: v.id("plans") },
  handler: async (ctx, { planId }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);

    const oldSchedules = await ctx.db
      .query("plan_schedules")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .collect();
    for (const s of oldSchedules) await ctx.db.delete(s._id);

    const oldLectures = await ctx.db
      .query("plan_lectures")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .collect();
    for (const l of oldLectures) await ctx.db.delete(l._id);

    for (const sched of SEED_SCHEDULES) {
      await ctx.db.insert("plan_schedules", {
        userId,
        planId,
        energy: sched.energy,
        phase: sched.phase,
        blocks: sched.blocks,
      });
    }
    for (const dowStr of Object.keys(SEED_LECTURES)) {
      const dow = Number(dowStr);
      await ctx.db.insert("plan_lectures", {
        userId,
        planId,
        dow,
        blocks: SEED_LECTURES[dow],
      });
    }
  },
});

// ─────────────── Plan settings ───────────────

export const updatePlan = mutation({
  args: {
    id: v.id("plans"),
    name: v.optional(v.string()),
    startDate: v.optional(v.string()),
    weekCount: v.optional(v.number()),
    phaseShiftWeek: v.optional(v.number()),
    examWeek: v.optional(v.number()),
    phaseOverride: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...rest }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const patch: any = {};
    for (const k of [
      "name",
      "startDate",
      "weekCount",
      "phaseShiftWeek",
      "examWeek",
      "phaseOverride",
    ] as const) {
      if (rest[k] !== undefined) patch[k] = rest[k];
    }
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(id, patch);
  },
});

// Set goal link for a single category. Pass goalId=undefined to unlink.
export const setGoalLink = mutation({
  args: {
    id: v.id("plans"),
    category: v.string(),
    goalId: v.optional(v.id("goals")),
  },
  handler: async (ctx, { id, category, goalId }) => {
    const userId = await requireUserId(ctx);
    const plan = await getOwned<Doc<"plans">>(ctx, id, userId);
    if (goalId) await getOwned(ctx, goalId, userId);
    const next = { ...(plan.goalLinks || {}) };
    if (goalId) next[category] = goalId;
    else delete next[category];
    await ctx.db.patch(id, { goalLinks: next });
  },
});

// ─────────────── Schedules ───────────────

export const upsertSchedule = mutation({
  args: {
    planId: v.id("plans"),
    energy: v.string(),
    phase: v.string(),
    blocks: v.array(BLOCK_VALIDATOR),
  },
  handler: async (ctx, { planId, energy, phase, blocks }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_schedules")
      .withIndex("by_plan_lookup", (q) =>
        q.eq("planId", planId).eq("energy", energy).eq("phase", phase)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { blocks });
      return existing._id;
    }
    return await ctx.db.insert("plan_schedules", {
      userId,
      planId,
      energy,
      phase,
      blocks,
    });
  },
});

// ─────────────── Lectures ───────────────

export const upsertLectures = mutation({
  args: {
    planId: v.id("plans"),
    dow: v.number(),
    blocks: v.array(BLOCK_VALIDATOR),
  },
  handler: async (ctx, { planId, dow, blocks }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_lectures")
      .withIndex("by_plan_dow", (q) =>
        q.eq("planId", planId).eq("dow", dow)
      )
      .unique();
    if (blocks.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { blocks });
      return existing._id;
    }
    return await ctx.db.insert("plan_lectures", {
      userId,
      planId,
      dow,
      blocks,
    });
  },
});

// ─────────────── Days (energy + phase override) ───────────────

export const setDayEnergy = mutation({
  args: {
    planId: v.id("plans"),
    date: v.string(),
    energy: v.string(),
  },
  handler: async (ctx, { planId, date, energy }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_days")
      .withIndex("by_plan_date", (q) =>
        q.eq("planId", planId).eq("date", date)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { energy });
      return existing._id;
    }
    return await ctx.db.insert("plan_days", {
      userId,
      planId,
      date,
      energy,
    });
  },
});

export const setPhaseOverride = mutation({
  args: {
    planId: v.id("plans"),
    date: v.string(),
    phaseOverride: v.optional(v.string()),
  },
  handler: async (ctx, { planId, date, phaseOverride }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_days")
      .withIndex("by_plan_date", (q) =>
        q.eq("planId", planId).eq("date", date)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { phaseOverride });
      return existing._id;
    }
    // No row yet: create one with default energy "high" so we have somewhere
    // to hang the override.
    return await ctx.db.insert("plan_days", {
      userId,
      planId,
      date,
      energy: "high",
      phaseOverride,
    });
  },
});

// Per-date override for the schedule template — used when the user
// chose "edit only today" instead of "edit the whole schedule". The
// blocks array fully replaces the template for that one date.
export const setDayScheduleOverride = mutation({
  args: {
    planId: v.id("plans"),
    date: v.string(),
    blocks: v.array(BLOCK_VALIDATOR),
  },
  handler: async (ctx, { planId, date, blocks }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_days")
      .withIndex("by_plan_date", (q) =>
        q.eq("planId", planId).eq("date", date)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { scheduleOverride: blocks });
      return existing._id;
    }
    return await ctx.db.insert("plan_days", {
      userId,
      planId,
      date,
      energy: "high",
      scheduleOverride: blocks,
    });
  },
});

// Same idea for recurring lectures — used when a user wants to skip,
// move, or rename a lecture for one specific date.
export const setDayLectureOverride = mutation({
  args: {
    planId: v.id("plans"),
    date: v.string(),
    blocks: v.array(BLOCK_VALIDATOR),
  },
  handler: async (ctx, { planId, date, blocks }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_days")
      .withIndex("by_plan_date", (q) =>
        q.eq("planId", planId).eq("date", date)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lectureOverride: blocks });
      return existing._id;
    }
    return await ctx.db.insert("plan_days", {
      userId,
      planId,
      date,
      energy: "high",
      lectureOverride: blocks,
    });
  },
});

// ─────────────── Tracking ───────────────

export const setTracking = mutation({
  args: {
    planId: v.id("plans"),
    date: v.string(),
    blockKey: v.string(),
    blockTitle: v.string(),
    category: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("half"),
      v.literal("missed"),
      v.literal("clear")
    ),
  },
  handler: async (
    ctx,
    { planId, date, blockKey, blockTitle, category, status }
  ) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_tracking")
      .withIndex("by_plan_date_block", (q) =>
        q.eq("planId", planId).eq("date", date).eq("blockKey", blockKey)
      )
      .unique();
    if (status === "clear") {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { status, blockTitle, category });
      return existing._id;
    }
    return await ctx.db.insert("plan_tracking", {
      userId,
      planId,
      date,
      blockKey,
      blockTitle,
      category,
      status,
    });
  },
});

// ─────────────── Rules ───────────────

export const addRule = mutation({
  args: {
    planId: v.id("plans"),
    ifText: v.string(),
    thenText: v.string(),
  },
  handler: async (ctx, { planId, ifText, thenText }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, planId, userId);
    const existing = await ctx.db
      .query("plan_rules")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .collect();
    const order =
      existing.reduce((m, r) => (r.order > m ? r.order : m), -1) + 1;
    return await ctx.db.insert("plan_rules", {
      userId,
      planId,
      ifText,
      thenText,
      order,
    });
  },
});

export const updateRule = mutation({
  args: {
    id: v.id("plan_rules"),
    ifText: v.optional(v.string()),
    thenText: v.optional(v.string()),
  },
  handler: async (ctx, { id, ifText, thenText }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    const patch: any = {};
    if (ifText !== undefined) patch.ifText = ifText;
    if (thenText !== undefined) patch.thenText = thenText;
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(id, patch);
  },
});

export const deleteRule = mutation({
  args: { id: v.id("plan_rules") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    await getOwned(ctx, id, userId);
    await ctx.db.delete(id);
  },
});
