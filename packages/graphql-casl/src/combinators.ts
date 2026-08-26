/**
 * Logic combinators over {@link CheckableRule}s: `and`, `or`, `not`, `chain` and
 * `race`. Each returns a `CheckableRule`, so combinators nest freely.
 */

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
          'or `createCan(...)`, and note that `createCan(...).onResult` rules are never ' +
          'combinable — they need the resolved value to decide.',
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
