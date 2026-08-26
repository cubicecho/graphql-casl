/**
 * Symbols shared between modules that must agree without importing each other.
 *
 * `Symbol.for` rather than `Symbol()` so two copies of this package in one
 * `node_modules` tree still recognise each other's marks.
 */

import type { AbilityLike } from './ability.js';

/** Keys the private handle {@link createCan} attaches to its `requireCan`. */
export const CAN_INTERNALS: unique symbol = Symbol.for('graphql-casl.canInternals') as never;

/** What the optional `scoping` entry point needs from a `requireCan`. */
export interface CanInternals<TContext> {
  /** Authenticate, then resolve the request's memoized ability. */
  authorize(context: TContext): Promise<AbilityLike>;
}

/** Keys the mark an argument-scoping rule carries, so validation can read it. */
export const SCOPE_INFO: unique symbol = Symbol.for('graphql-casl.scopeInfo') as never;

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
