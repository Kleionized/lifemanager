// Undo infrastructure. Every state-mutating mutation routes its writes
// through an UndoRecorder, which captures the inverse op (what to do to
// roll the change back) and writes one undo_log row at the end of the
// mutation. The popUndo mutation pops the latest log row and applies its
// inverse ops in order.
//
// Subtree deletes are the tricky case — when you re-insert deleted rows,
// Convex assigns new ids, so any parentId/projectId/habitId references
// inside the subtree need to be remapped. We record those as one batched
// "insertTree" op that does insert+remap atomically at apply time.

import type { MutationCtx } from "./_generated/server";
import type { Id, DataModel } from "./_generated/dataModel";

type TableName = keyof DataModel;

const UNDO_CAP = 100;

// Tables that participate in undo. Every ref field listed here is a foreign
// key into the same table family — we'll remap it across the table set when
// re-inserting a tree.
type RefTable =
  | "daily_tasks"
  | "weekly_tasks"
  | "project_tasks"
  | "habit_completions"
  | "projects"
  | "goals"
  | "habits";

// Foreign-key fields per table. When a tree is reinserted and a doc has one
// of these fields pointing at an oldId we just remapped, the new id is
// patched in.
const REF_FIELDS: Record<string, string[]> = {
  daily_tasks: ["parentId", "habitId"],
  weekly_tasks: ["parentId", "habitId"],
  project_tasks: ["parentId", "projectId", "habitId"],
  habit_completions: ["habitId", "sourceTodoId"],
  goals: ["projectIds"], // array — handled specially
  habits: ["linkedProjectId"],
};

type InsertOp = {
  op: "insert";
  table: RefTable;
  oldId: string;
  doc: Record<string, any>;
};
type PatchOp = {
  op: "patch";
  table: RefTable;
  id: string;
  fields: Record<string, any>;
};
type DeleteOp = { op: "delete"; table: RefTable; id: string };
type InsertTreeOp = {
  op: "insertTree";
  inserts: { table: RefTable; oldId: string; doc: Record<string, any> }[];
};

export type InverseOp = InsertOp | PatchOp | DeleteOp | InsertTreeOp;

export class UndoRecorder {
  private ops: InverseOp[] = [];

  constructor(
    private ctx: MutationCtx,
    private userId: Id<"users">
  ) {}

  // Record a fresh insert. Inverse: delete the new row.
  async insert<T extends RefTable & TableName>(
    table: T,
    doc: Record<string, any>
  ): Promise<Id<T>> {
    const id = (await this.ctx.db.insert(table as any, doc as any)) as Id<T>;
    this.ops.push({ op: "delete", table, id: id as unknown as string });
    return id;
  }

  // Record a patch. Inverse: patch back to the previous values for those
  // exact keys (so we don't accidentally clobber unrelated fields touched
  // by a concurrent write).
  async patch(
    table: RefTable,
    id: any,
    fields: Record<string, any>
  ): Promise<void> {
    const prev = await this.ctx.db.get(id);
    if (!prev) throw new Error("Not found");
    const inverseFields: Record<string, any> = {};
    for (const k of Object.keys(fields)) {
      inverseFields[k] = (prev as any)[k];
    }
    await this.ctx.db.patch(id, fields as any);
    this.ops.push({ op: "patch", table, id, fields: inverseFields });
  }

  // Record a single-row delete (no descendants to track). Inverse:
  // re-insert the doc.
  async delete(table: RefTable, id: any): Promise<void> {
    const doc = await this.ctx.db.get(id);
    if (!doc) return;
    const stripped = stripReservedFields(doc as any);
    await this.ctx.db.delete(id);
    this.ops.push({
      op: "insertTree",
      inserts: [{ table, oldId: String(id), doc: stripped }],
    });
  }

  // Record a subtree delete as a single inverse op. `gather` is a function
  // that yields the rows to delete; this method handles deletion AND
  // serialization-for-undo. Rows are inserted back in original order; ref
  // fields in REF_FIELDS are remapped automatically at undo-apply time.
  async deleteTree(
    rows: { table: RefTable; doc: any }[]
  ): Promise<void> {
    const inserts: InsertTreeOp["inserts"] = [];
    for (const { table, doc } of rows) {
      inserts.push({
        table,
        oldId: String(doc._id),
        doc: stripReservedFields(doc),
      });
    }
    for (const { doc } of rows) {
      await this.ctx.db.delete(doc._id);
    }
    if (inserts.length > 0) {
      this.ops.push({ op: "insertTree", inserts });
    }
  }

  // Write the inverse log row and prune to UNDO_CAP entries. Call at the
  // end of every state-mutating mutation, even if `ops` is empty (no-op).
  async commit(description: string): Promise<void> {
    if (this.ops.length === 0) return;
    // Apply order at undo time: reverse of how operations were recorded
    // here (so the *last* thing we did is undone *first*).
    const inverse = [...this.ops].reverse();
    await this.ctx.db.insert("undo_log", {
      userId: this.userId,
      inverse,
      description,
      createdAt: Date.now(),
    });
    // Prune.
    const all = await this.ctx.db
      .query("undo_log")
      .withIndex("by_user_created", (q) => q.eq("userId", this.userId))
      .collect();
    if (all.length > UNDO_CAP) {
      const sorted = all.sort((a, b) => a.createdAt - b.createdAt);
      const overflow = sorted.length - UNDO_CAP;
      for (let i = 0; i < overflow; i++) {
        await this.ctx.db.delete(sorted[i]._id);
      }
    }
  }
}

function stripReservedFields(doc: Record<string, any>) {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}

// Apply a single inverse op. Returns a partial id remap (oldId → newId)
// from any insertTree ops; the caller doesn't use it across ops because
// each undo applies a self-contained set, but kept here for completeness.
export async function applyInverse(
  ctx: MutationCtx,
  inverse: InverseOp[],
  userId: Id<"users">
): Promise<void> {
  for (const op of inverse) {
    if (op.op === "delete") {
      const doc = await ctx.db.get(op.id as any);
      if (!doc) continue;
      if ((doc as any).userId !== userId) continue;
      await ctx.db.delete(op.id as any);
    } else if (op.op === "patch") {
      const doc = await ctx.db.get(op.id as any);
      if (!doc) continue;
      if ((doc as any).userId !== userId) continue;
      await ctx.db.patch(op.id as any, op.fields as any);
    } else if (op.op === "insertTree") {
      // Two-pass: insert all rows building oldId → newId, then patch ref
      // fields whose values appear in the map.
      const remap = new Map<string, any>();
      const inserted: { table: RefTable; oldId: string; newId: any }[] = [];
      for (const ins of op.inserts) {
        // Defensive: don't allow the inverse to re-create rows for some
        // other user, in case the log row was tampered with.
        if (ins.doc.userId && ins.doc.userId !== userId) continue;
        const newId = await ctx.db.insert(ins.table as any, ins.doc as any);
        remap.set(ins.oldId, newId);
        inserted.push({ table: ins.table, oldId: ins.oldId, newId });
      }
      for (const { table, newId } of inserted) {
        const refs = REF_FIELDS[table] || [];
        if (refs.length === 0) continue;
        const doc = await ctx.db.get(newId);
        if (!doc) continue;
        const patch: Record<string, any> = {};
        for (const field of refs) {
          const val = (doc as any)[field];
          if (val === undefined || val === null) continue;
          if (Array.isArray(val)) {
            // e.g. goals.projectIds[]
            const remapped = val.map((v: any) => remap.get(String(v)) ?? v);
            const changed = remapped.some(
              (v: any, i: number) => v !== val[i]
            );
            if (changed) patch[field] = remapped;
          } else {
            const mapped = remap.get(String(val));
            if (mapped !== undefined) patch[field] = mapped;
          }
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(newId, patch);
        }
      }
    }
  }
}

// Convenience: gather a daily/weekly/project task subtree (root + recursive
// children) plus any habit_completions sourced from any of those tasks,
// returning the docs so a deleteTree call can both record-and-delete them
// in one shot.
export async function gatherTaskSubtree(
  ctx: MutationCtx,
  table: "daily_tasks" | "weekly_tasks" | "project_tasks",
  rootId: any
): Promise<{ table: RefTable; doc: any }[]> {
  const rows: { table: RefTable; doc: any }[] = [];
  const visit = async (id: any) => {
    const doc = await ctx.db.get(id);
    if (!doc) return;
    rows.push({ table, doc });
    const kids = await ctx.db
      .query(table)
      .withIndex("by_parent" as any, (q: any) => q.eq("parentId", id))
      .collect();
    for (const k of kids as any[]) {
      await visit(k._id);
    }
  };
  await visit(rootId);

  // Sourced completions for each task in the subtree.
  for (const { doc } of [...rows]) {
    const sourced = await ctx.db
      .query("habit_completions")
      .withIndex("by_source", (q) => q.eq("sourceTodoId", doc._id))
      .collect();
    for (const c of sourced) {
      rows.push({ table: "habit_completions", doc: c });
    }
  }
  return rows;
}
