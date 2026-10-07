/**
 * The error-control wrapper every guarded field's rule runs in.
 *
 * @remarks
 * This is where `fallbackError`, `allowExternalErrors`, `debug` and `onDeny`
 * take effect: the wrapper tells a denial from a rule failure from a resolver
 * error, and delivers each as the options say. It runs once per field
 * resolution, so it stays synchronous wherever the rule and the resolver are.
 */

import type { GraphQLResolveInfo } from 'graphql';
import { DenialMode, type DenialReport, deliver, type Mask } from './denials.js';
import {
  type Check,
  type CheckableRule,
  DenialKind,
  denialKindOf,
  denialOf,
  isThenable,
  PLAIN_RULE,
  passes,
  type Rule,
  type RuleResult,
} from './rules.js';

/**
 * A replacement error for denials that did not name one: an `Error`, a message,
 * or a mapper that receives the original error and the resolver arguments.
 *
 * @remarks
 * The mapper is the form that lets a denial become a `GraphQLError` with a code
 * and extensions, or vary by field.
 */
export type FallbackError =
  | Error
  | string
  | ((
      original: unknown,
      parent: unknown,
      args: unknown,
      context: unknown,
      info: GraphQLResolveInfo,
    ) => Error | Promise<Error>);

/** The error-control options, resolved to their defaults. Internal. */
export interface ErrorControl {
  fallbackError: FallbackError | undefined;
  allowExternalErrors: boolean;
  debug: boolean;
  onDeny: DenialMode;
  report: DenialReport;
}

/**
 * Resolves a {@link FallbackError} to the error to throw.
 *
 * @param fallbackError - The option as passed.
 * @param original - The error being replaced.
 * @param parent - The field's parent value.
 * @param args - The field's arguments.
 * @param context - The request context.
 * @param info - The field's resolve info.
 * @returns The error to throw.
 */
async function resolveFallbackError(
  fallbackError: FallbackError,
  original: unknown,
  parent: unknown,
  args: unknown,
  context: unknown,
  info: GraphQLResolveInfo,
): Promise<Error> {
  if (typeof fallbackError === 'string') {
    return new Error(fallbackError);
  }
  if (typeof fallbackError === 'function') {
    return fallbackError(original, parent, args, context, info);
  }
  return fallbackError;
}

/**
 * A rule whose middleware is exactly "run `.check`, then `resolve`".
 *
 * @param rule - The rule to test.
 * @returns `true` when its check can be called directly.
 */
function isPlainRule(rule: Rule): rule is CheckableRule {
  return (rule as Partial<Record<typeof PLAIN_RULE, boolean>>)[PLAIN_RULE] === true;
}

/**
 * Wraps one field's rule with the error-control options.
 *
 * @param rule - The field's rule.
 * @param options - The resolved error-control options.
 * @param mask - Produces the field's masked value.
 * @returns The wrapped rule, or `rule` itself when no option applies.
 *
 * @remarks
 * Three kinds of failure have to be told apart: a **denial** (the rule did its
 * job), a **rule failure** (the rule itself broke — a `getAbility` that threw),
 * and a **resolver error** (the field was allowed and the resolver failed).
 *
 * A rule built by `rule()` — which is every rule this library produces except
 * `onResult`, `scopeArgs`, `validateArgs` and `wrap` — exposes its decision as a check, and the
 * wrapper asks that directly. A denial is then a *returned* value, not a thrown
 * one, so masking it costs no `Error` construction and no stack capture: on a
 * 100-row list with 5 masked fields that is 500 errors never built. It also
 * keeps a synchronous check synchronous end to end. Anything the check throws
 * is a rule failure; anything the resolver throws is a resolver error.
 *
 * Any other rule is run as middleware, and the three kinds arrive as thrown
 * errors: denials carry a marker from `rule()`, resolver errors are identified
 * by capturing what the wrapped `resolve` threw, and the rest are rule failures.
 */
export function withErrorControl(rule: Rule, options: ErrorControl, mask: Mask | undefined): Rule {
  const { fallbackError, allowExternalErrors, debug, onDeny, report } = options;
  if (!fallbackError && allowExternalErrors && debug === false && !mask && onDeny !== DenialMode.Filter) {
    return rule;
  }

  if (isPlainRule(rule)) {
    return withCheckedErrorControl(rule.check, options, mask);
  }

  return async (resolve, parent, args, context, info) => {
    // Identity, not a flag: the rule may catch and rethrow, and a denial thrown
    // after a successful resolve must not be mistaken for a resolver error.
    let resolverError: unknown;
    let threw = false;
    const tracked = async (
      p?: unknown,
      a?: unknown,
      c?: unknown,
      i?: GraphQLResolveInfo,
      // biome-ignore lint/suspicious/noExplicitAny: mirrors the resolver's return
    ): Promise<any> => {
      try {
        return await resolve(p, a, c, i);
      } catch (error) {
        resolverError = error;
        threw = true;
        throw error;
      }
    };

    try {
      return await rule(tracked, parent, args, context, info);
    } catch (error) {
      const isResolverError = threw && error === resolverError;
      const denialKind = isResolverError ? undefined : denialKindOf(error);

      // A rule that broke is not a denial. Surfacing it as one would report a
      // bug as an authorization decision, so `debug` rethrows it untouched.
      if (denialKind === undefined && isResolverError === false && debug) {
        throw error;
      }

      // Filtering changes how a decision is delivered, not what it says: the
      // denial keeps its words, `fallbackError` still rewords a generic one,
      // and only then is it masked and reported.
      if (denialKind !== undefined && onDeny === DenialMode.Filter) {
        const denial =
          fallbackError && denialKind === DenialKind.Default
            ? await resolveFallbackError(fallbackError, error, parent, args, context, info)
            : (error as Error);
        return deliver(denial, mask, report, context, info);
      }

      // Masking replaces a decision the rule made, never a failure it suffered:
      // a broken rule or a broken resolver still surfaces.
      if (mask && denialKind !== undefined) {
        return mask();
      }

      // An explicit denial is the rule author's own words; only the generic
      // default is replaced.
      if (denialKind === DenialKind.Explicit) {
        throw error;
      }
      if (isResolverError && allowExternalErrors) {
        throw error;
      }
      if (!fallbackError) {
        throw error;
      }

      throw await resolveFallbackError(fallbackError, error, parent, args, context, info);
    }
  };
}

/**
 * The check-based wrapper — see {@link withErrorControl}.
 *
 * @param check - The rule's check.
 * @param options - The resolved error-control options.
 * @param mask - Produces the field's masked value.
 * @returns The wrapped rule.
 */
function withCheckedErrorControl(check: Check, options: ErrorControl, mask: Mask | undefined): Rule {
  const { fallbackError, allowExternalErrors, debug, onDeny, report } = options;
  const replaceResolverErrors = allowExternalErrors === false && fallbackError !== undefined;

  /** Rejects with the `fallbackError` built for `original`. */
  function replaced(
    fallback: FallbackError,
    original: unknown,
    parent: unknown,
    args: unknown,
    context: unknown,
    info: GraphQLResolveInfo,
  ): Promise<never> {
    return resolveFallbackError(fallback, original, parent, args, context, info).then((error) => {
      throw error;
    });
  }

  /** A rule failure: rethrown untouched under `debug`, else `fallbackError`. */
  function failed(
    error: unknown,
    parent: unknown,
    args: unknown,
    context: unknown,
    info: GraphQLResolveInfo,
  ): Promise<never> {
    if (debug || !fallbackError) {
      return Promise.reject(error);
    }
    return replaced(fallbackError, error, parent, args, context, info);
  }

  /** The field was allowed: run the resolver, replacing its errors if asked. */
  function allowed(
    resolve: Parameters<Rule>[0],
    parent: unknown,
    args: unknown,
    context: unknown,
    info: GraphQLResolveInfo,
  ): unknown {
    if (replaceResolverErrors === false) {
      return resolve(parent, args, context, info);
    }
    let result: unknown;
    try {
      result = resolve(parent, args, context, info);
    } catch (error) {
      return replaced(fallbackError, error, parent, args, context, info);
    }
    return isThenable(result)
      ? Promise.resolve(result).catch((error) => replaced(fallbackError, error, parent, args, context, info))
      : result;
  }

  /** The check answered: mask or reject a denial, or run the resolver. */
  function settle(
    result: RuleResult,
    resolve: Parameters<Rule>[0],
    parent: unknown,
    args: unknown,
    context: unknown,
    info: GraphQLResolveInfo,
  ): unknown {
    if (passes(result)) {
      return allowed(resolve, parent, args, context, info);
    }
    // Masking replaces a decision the rule made, whatever words it chose.
    if (mask && onDeny === DenialMode.Mask) {
      return mask();
    }
    const denial = denialOf(result);
    // An explicit denial is the rule author's own words; only the generic
    // default is replaced.
    const explicit = denialKindOf(denial) === DenialKind.Explicit;
    if (onDeny === DenialMode.Filter) {
      if (fallbackError && explicit === false) {
        return resolveFallbackError(fallbackError, denial, parent, args, context, info).then((error) =>
          deliver(error, mask, report, context, info),
        );
      }
      return deliver(denial, mask, report, context, info);
    }
    if (!fallbackError || explicit) {
      return Promise.reject(denial);
    }
    return replaced(fallbackError, denial, parent, args, context, info);
  }

  return (resolve, parent, args, context, info) => {
    let answer: RuleResult | Promise<RuleResult>;
    try {
      answer = check(parent, args, context, info);
    } catch (error) {
      return failed(error, parent, args, context, info);
    }
    if (isThenable(answer)) {
      return Promise.resolve(answer).then(
        (result) => settle(result, resolve, parent, args, context, info),
        (error) => failed(error, parent, args, context, info),
      );
    }
    // Synchronous end to end when the check and the resolver both are; see
    // `Rule` on why that is within contract.
    return settle(answer, resolve, parent, args, context, info) as Promise<unknown>;
  };
}
