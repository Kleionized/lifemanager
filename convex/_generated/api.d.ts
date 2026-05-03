/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _auth_helpers from "../_auth_helpers.js";
import type * as _undo from "../_undo.js";
import type * as auth from "../auth.js";
import type * as dailyTasks from "../dailyTasks.js";
import type * as goals from "../goals.js";
import type * as habitCompletions from "../habitCompletions.js";
import type * as habits from "../habits.js";
import type * as http from "../http.js";
import type * as migration from "../migration.js";
import type * as plans from "../plans.js";
import type * as projectTasks from "../projectTasks.js";
import type * as projects from "../projects.js";
import type * as ui from "../ui.js";
import type * as undo from "../undo.js";
import type * as weeklyTasks from "../weeklyTasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _auth_helpers: typeof _auth_helpers;
  _undo: typeof _undo;
  auth: typeof auth;
  dailyTasks: typeof dailyTasks;
  goals: typeof goals;
  habitCompletions: typeof habitCompletions;
  habits: typeof habits;
  http: typeof http;
  migration: typeof migration;
  plans: typeof plans;
  projectTasks: typeof projectTasks;
  projects: typeof projects;
  ui: typeof ui;
  undo: typeof undo;
  weeklyTasks: typeof weeklyTasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
