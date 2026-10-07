/**
 * Marks shared between modules that must agree without importing each other.
 *
 * @remarks
 * `Symbol.for` rather than `Symbol()` so two copies of this package in one
 * `node_modules` tree still recognise each other's marks.
 */

import type { AbilityLike } from './ability.js';

/** Keys the private handle {@link createCan} attaches to its `requireCan`. */
export const CAN_INTERNALS: unique symbol = Symbol.for('graphql-casl.canInternals');

/** What the optional `scoping` entry point needs from a `requireCan`. */
export interface CanInternals<TContext> {
  /** Authenticate, then resolve the request's memoized ability. */
  authorize(context: TContext): Promise<AbilityLike>;
}

/**
 * Reads the handle `createCan` attached to a `requireCan`.
 *
 * @param requireCan - The value to read.
 * @returns The handle, or `undefined` when `createCan` did not build the value.
 */
export function canInternalsOf(requireCan: object): CanInternals<unknown> | undefined {
  return (requireCan as Partial<Record<typeof CAN_INTERNALS, CanInternals<unknown>>>)[CAN_INTERNALS];
}

/**
 * Attaches the handle the `scoping` entry point reads.
 *
 * @typeParam TContext - The request context type.
 * @param requireCan - The function to mark; mutated.
 * @param internals - The handle.
 */
export function markCanInternals<TContext>(requireCan: object, internals: CanInternals<TContext>): void {
  Object.defineProperty(requireCan, CAN_INTERNALS, { value: internals });
}

/** Keys the mark an argument-scoping rule carries, so validation can read it. */
export const SCOPE_INFO: unique symbol = Symbol.for('graphql-casl.scopeInfo');

/** What an argument-scoping rule advertises about itself. */
export interface ScopeInfo {
  /**
   * The argument names filters are injected into. A list rather than one name
   * because `wrap()` composes rules into a single map entry, and the mark has
   * to survive that — otherwise nesting a scoping rule inside a wrapper would
   * silently switch off the check that its target argument exists.
   */
  readonly into: readonly string[];
}

/**
 * Reads the mark an argument-scoping rule carries.
 *
 * @param rule - The rule, or any other map value.
 * @returns The mark, or `undefined` when the value is not an argument-scoping rule.
 */
export function scopeInfoOf(rule: object): ScopeInfo | undefined {
  return (rule as Partial<Record<typeof SCOPE_INFO, ScopeInfo>>)[SCOPE_INFO];
}

/**
 * Marks a rule as injecting into the given arguments.
 *
 * @param rule - The rule to mark; mutated.
 * @param info - What the rule advertises.
 */
export function markScope(rule: object, info: ScopeInfo): void {
  Object.defineProperty(rule, SCOPE_INFO, { value: info });
}
