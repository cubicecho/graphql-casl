/**
 * Logic combinators over {@link CheckableRule}s: `and`, `or`, `not`, `chain` and
 * `race`. Each returns a `CheckableRule`, so combinators nest freely.
 *
 * {@link wrap} sits apart from those: it composes *any* rules, including ones
 * that decide by running the resolver, and returns a plain {@link Rule}.
 */

import type { GraphQLResolveInfo } from 'graphql';
import { SCOPE_INFO, type ScopeInfo } from './internal.js';
import {
  type Check,
  type CheckableRule,
  denialFrom,
  isCheckableRule,
  type Rule,
  rule,
} from './rules.js';

/**
 * Extracts the operands' checks, rejecting anything that cannot be combined.
 *
 * A plain {@link Rule} decides by running, and running it may run the resolver —
 * so it cannot be evaluated speculatively as one branch of an `or`. Rather than
 * degrade silently, name the offending operand and fail while the permissions
 * map is being built.
 */
function checksOf(combinator: string, rules: readonly Rule[]): Check[] {
  if (rules.length === 0) {
    throw new Error(`graphql-casl: \`${combinator}()\` needs at least one rule.`);
  }
  return rules.map((operand, index) => {
    if (!isCheckableRule(operand)) {
      throw new Error(
        `graphql-casl: \`${combinator}()\` operand ${index} is not a checkable rule, so its ` +
          'verdict cannot be evaluated without also running the resolver. Build it with `rule()` ' +
          'or `createCan(...)`. `createCan(...).onResult` and `scopeArgs(...)` rules are never ' +
          'combinable — one needs the resolved value to decide, the other decides by rewriting ' +
          'the arguments and calling the resolver itself. Compose those with `wrap()` instead.',
      );
    }
    return operand.check;
  });
}

/** Labels a combinator for error messages, e.g. `and(isSelf, isAdmin)`. */
function label(combinator: string, rules: readonly Rule[]): string {
  return `${combinator}(${rules.map((r) => (isCheckableRule(r) ? r.ruleName : '') || '?').join(', ')})`;
}

/**
 * Passes when **every** operand passes. Operands are evaluated **in parallel**;
 * on failure the **first** failing operand's error is thrown.
 *
 * Use {@link chain} when the operands must run in order, or when a later one is
 * expensive and should be skipped once an earlier one has already failed.
 *
 * @example
 * ```ts
 * Mutation: { publish: and(isAuthor, isNotBanned) }
 * ```
 */
export function and(...rules: Rule[]): CheckableRule {
  const checks = checksOf('and', rules);
  return rule(
    async (parent, args, context, info) => {
      const results = await Promise.all(checks.map((check) => check(parent, args, context, info)));
      for (const result of results) {
        const denial = denialFrom(result);
        if (denial) return denial;
      }
      return true;
    },
    { name: label('and', rules) },
  );
}

/**
 * Passes when **any** operand passes. Operands are evaluated **in parallel**;
 * when all of them fail the **last** operand's error is thrown, on the reasoning
 * that the last branch is the most specific fallback and so the most useful
 * thing to tell the caller.
 *
 * Use {@link race} to stop at the first operand that passes instead of always
 * evaluating all of them.
 *
 * @example
 * ```ts
 * Query: { invoice: or(isOwner, isAccountant) }
 * ```
 */
export function or(...rules: Rule[]): CheckableRule {
  const checks = checksOf('or', rules);
  return rule(
    async (parent, args, context, info) => {
      const results = await Promise.all(checks.map((check) => check(parent, args, context, info)));
      const denials = results.map(denialFrom);
      if (denials.some((denial) => denial === undefined)) return true;
      return denials[denials.length - 1] as Error;
    },
    { name: label('or', rules) },
  );
}

/**
 * Sequential {@link and}: evaluates operands in order and stops at the first
 * failure, throwing its error. Later operands are not evaluated at all.
 *
 * Prefer this over `and` when an operand is expensive — a database lookup, a
 * call to an external policy decision point — and should be reached only after
 * the cheap checks have passed.
 *
 * @example
 * ```ts
 * Query: { document: chain(isAuthenticated, isInOrg, askOpenFga) }
 * ```
 */
export function chain(...rules: Rule[]): CheckableRule {
  const checks = checksOf('chain', rules);
  return rule(
    async (parent, args, context, info) => {
      for (const check of checks) {
        const denial = denialFrom(await check(parent, args, context, info));
        if (denial) return denial;
      }
      return true;
    },
    { name: label('chain', rules) },
  );
}

/**
 * Sequential {@link or}: evaluates operands in order and stops at the first one
 * that passes. When all of them fail, the last operand's error is thrown.
 *
 * Put the cheap or common case first — a passing first operand means the rest
 * never run.
 *
 * @example
 * ```ts
 * Query: { report: race(isCachedAsAllowed, askOpenFga) }
 * ```
 */
export function race(...rules: Rule[]): CheckableRule {
  const checks = checksOf('race', rules);
  return rule(
    async (parent, args, context, info) => {
      let denial: Error | undefined;
      for (const check of checks) {
        denial = denialFrom(await check(parent, args, context, info));
        if (!denial) return true;
      }
      return denial as Error;
    },
    { name: label('race', rules) },
  );
}

/**
 * Inverts a rule: passes when the operand denies, denies when it passes.
 *
 * The operand's error is discarded — it explains why the operand failed, which
 * is the *reason this rule passed*. Supply `error` to say why the inverted rule
 * denied; without one it denies with `Forbidden`.
 *
 * @param operand - The rule to invert.
 * @param error - The denial message or error to use when `operand` passes.
 * @example
 * ```ts
 * Mutation: { deleteAccount: not(isImpersonating, 'Not while impersonating') }
 * ```
 */
export function not(operand: Rule, error?: string | Error): CheckableRule {
  const [check] = checksOf('not', [operand]);
  return rule(
    async (parent, args, context, info) => {
      const denial = denialFrom(await check(parent, args, context, info));
      return denial ? true : (error ?? false);
    },
    { name: label('not', [operand]) },
  );
}

/**
 * Composes rules as nested middleware: each one receives the next as its
 * `resolve`, and the last receives the field's real resolver.
 *
 * This is the escape hatch from the combinators' one restriction. `and`, `or`,
 * `not`, `chain` and `race` all need to ask an operand for a verdict *without*
 * side effects, so they accept only {@link CheckableRule}s. `wrap` never asks —
 * it just nests — so it accepts anything, including the two rules that decide by
 * running the resolver: `createCan(...).onResult` and `scopeArgs(...)`.
 *
 * ```ts
 * Query: {
 *   notes: wrap(isNotBanned, scopeArgs(canUser, Actions.read, 'Note', { adapter })),
 * }
 * ```
 *
 * `isNotBanned` runs first. If it passes it calls what it thinks is the
 * resolver, which is really the scoping rule, which narrows `where` and calls
 * the resolver for real. Stacking works in both directions, so a field can be
 * scoped *and* have its result re-checked:
 *
 * ```ts
 * Query: {
 *   notes: wrap(scopeArgs(canUser, Actions.read, 'Note', { adapter }),
 *               canUser.onResult(Actions.read, 'Note')),
 * }
 * ```
 *
 * The result is a plain `Rule`, never a `CheckableRule`, even when every operand
 * happens to be checkable — a wrapper's verdict is only knowable by running it.
 * So a `wrap` cannot itself be an operand of `and` / `or` / `not` / `chain` /
 * `race`. When every operand *is* checkable, prefer {@link chain}: it means the
 * same thing, costs no resolver nesting, and stays combinable.
 *
 * Order matters and is left to right, outermost first. A rule that never calls
 * its `resolve` stops the chain there, exactly as it would if it were the only
 * rule on the field.
 *
 * @param rules - The rules to nest, outermost first. At least one.
 * @example
 * ```ts
 * Mutation: { publish: wrap(chain(isAuthenticated, isNotBanned), auditTrail) }
 * ```
 */
export function wrap(...rules: Rule[]): Rule {
  if (rules.length === 0) {
    throw new Error('graphql-casl: `wrap()` needs at least one rule.');
  }
  for (const [index, operand] of rules.entries()) {
    if (typeof operand !== 'function') {
      throw new Error(
        `graphql-casl: \`wrap()\` operand ${index} is ${typeof operand}, not a rule.`,
      );
    }
  }

  const composed = rules.reduceRight<Rule>(
    (next, current) => (resolve, parent, args, context, info) =>
      current(
        // What `current` believes is the resolver. `context` and `info` are
        // ambient — a middleware that calls `resolve(parent, args)` and drops
        // them would otherwise starve every rule beneath it — so they fall back
        // to this rule's own. `parent` and `args` pass through verbatim, since
        // rewriting those is the whole point of a wrapping rule.
        (nextParent, nextArgs, nextContext, nextInfo) =>
          next(resolve, nextParent, nextArgs, nextContext ?? context, nextInfo ?? info),
        parent,
        args,
        context,
        info,
      ),
    (resolve, parent, args, context, info) =>
      resolve(parent, args, context, info as GraphQLResolveInfo),
  );

  // Argument-scoping rules advertise the argument they inject into so
  // `applyPermissions` can check the field declares it. Nesting one must not
  // hide it, so the composed rule re-advertises every target beneath it.
  const targets = [
    ...new Set(
      rules.flatMap(
        (operand) =>
          (operand as Partial<Record<typeof SCOPE_INFO, ScopeInfo>>)[SCOPE_INFO]?.into ?? [],
      ),
    ),
  ];
  if (targets.length > 0) {
    const info: ScopeInfo = { into: targets };
    Object.defineProperty(composed, SCOPE_INFO, { value: info });
  }
  return composed;
}
