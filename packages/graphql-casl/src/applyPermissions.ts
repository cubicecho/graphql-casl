/**
 * The schema walk behind {@link applyPermissions}.
 *
 * `PermissionsMap` validates type and field names at compile time, but only for
 * consumers who generate a `Resolvers` type. This module re-checks the map
 * against the runtime `GraphQLSchema` and resolves it into the concrete
 * per-field middleware map handed to `graphql-middleware`.
 */

import {
  defaultFieldResolver,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import {
  applyMiddleware,
  type IMiddlewareFieldMap,
  type IMiddlewareTypeMap,
} from 'graphql-middleware';
import { SCOPE_INFO, type ScopeInfo } from './internal.js';
import {
  type AnyResolvers,
  type Check,
  type CheckableRule,
  denialFrom,
  denialKindOf,
  isThenable,
  type PermissionsMap,
  PLAIN_RULE,
  passes,
  type Rule,
  type RuleResult,
} from './rules.js';

/** The wildcard key, in either the type or the field position. */
const WILDCARD = '*';

/**
 * Thrown by {@link applyPermissions} / {@link validatePermissions} when a
 * permissions map does not line up with the schema, and by
 * {@link validateGraphQLRules} when stored ability rules do not. Reports
 * *every* problem at once, in {@link problems}, so a mismatch is fixed in one
 * pass rather than one error per run.
 */
export class PermissionsError extends Error {
  /** Every problem found, one message per offending type, field or rule. */
  readonly problems: readonly string[];

  constructor(
    problems: readonly string[],
    heading = 'the permissions map does not match the schema',
  ) {
    super(`graphql-casl: ${heading}.\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'PermissionsError';
    this.problems = problems;
  }
}

/** The permissions map with its compile-time typing erased, for the walk. */
type RawPermissions = Record<string, Rule | Record<string, Rule | undefined> | undefined>;

function isRule(value: unknown): value is Rule {
  return typeof value === 'function';
}

/** Names a type's kind for an error message. Shared with `validateGraphQLRules`. */
export function describeKind(type: GraphQLNamedType): string {
  if (isInterfaceType(type)) return 'an interface type';
  if (isUnionType(type)) return 'a union type';
  if (isScalarType(type)) return 'a scalar type';
  if (isEnumType(type)) return 'an enum type';
  if (isInputObjectType(type)) return 'an input object type';
  return 'not an object type';
}

/**
 * Every way a permissions map can fail to line up with the schema.
 *
 * `graphql-middleware` does check that types and fields exist, but it fails on
 * the first one and crashes outright on a union (`type.getFields is not a
 * function`). More importantly it accepts entries that are silently inert: a rule
 * on an interface type type-checks, applies cleanly, and then never runs, because
 * execution resolves fields against the concrete object type. In an authorization
 * library a rule that quietly never runs is the worst possible failure, so these
 * are rejected outright.
 */
function collectProblems(schema: GraphQLSchema, permissions: RawPermissions): string[] {
  const problems: string[] = [];
  const typeMap = schema.getTypeMap();

  // Field name -> every object-type field with that name, so a `*`-keyed rule
  // can be checked against all the fields it would actually guard.
  const guardableFields = new Map<string, AnyField[]>();
  for (const type of Object.values(typeMap)) {
    if (isObjectType(type) && !isIntrospectionType(type)) {
      for (const field of Object.values(type.getFields())) {
        const seen = guardableFields.get(field.name);
        if (seen) seen.push(field);
        else guardableFields.set(field.name, [field]);
      }
    }
  }

  for (const [typeName, entry] of Object.entries(permissions)) {
    if (entry == null) continue;

    // A wildcard type is not looked up in the schema; its field keys are checked
    // against every guardable field instead, so a typo there is still caught.
    if (typeName === WILDCARD) {
      if (!isRule(entry)) {
        for (const [fieldName, rule] of Object.entries(entry)) {
          if (rule === undefined || fieldName === WILDCARD) continue;
          const targets = guardableFields.get(fieldName);
          if (!targets) {
            problems.push(
              `Field \`*.${fieldName}\` is in the permissions map but no type in the schema has a field named \`${fieldName}\`.`,
            );
          } else if (!isRule(rule)) {
            problems.push(`Rule for \`*.${fieldName}\` is ${typeof rule}, not a function.`);
          } else {
            const problem = scopeProblem(rule, `*.${fieldName}`, targets);
            if (problem) problems.push(problem);
          }
        }
        const wildRule = entry[WILDCARD];
        if (wildRule !== undefined && !isRule(wildRule)) {
          problems.push(`Rule for \`*.*\` is ${typeof wildRule}, not a function.`);
        } else if (wildRule !== undefined && scopeTargetsOf(wildRule).length > 0) {
          problems.push(
            'Rule for `*.*` rewrites a field argument, which cannot be right for every field of ' +
              'every type. Attach the scoping rule to the fields it filters.',
          );
        }
      }
      continue;
    }

    const type = typeMap[typeName];
    if (!type) {
      problems.push(`Type \`${typeName}\` is in the permissions map but not in the schema.`);
      continue;
    }
    if (isIntrospectionType(type)) {
      problems.push(`\`${typeName}\` is an introspection type and cannot be guarded.`);
      continue;
    }
    if (!isObjectType(type)) {
      const hint =
        isInterfaceType(type) || isUnionType(type)
          ? ' Fields are resolved against the concrete object type, so the rule would never run — attach it to each implementing type instead.'
          : '';
      problems.push(`\`${typeName}\` is ${describeKind(type)}, not an object type.${hint}`);
      continue;
    }
    if (isRule(entry)) continue;

    const fields = type.getFields();
    for (const [fieldName, rule] of Object.entries(entry)) {
      if (rule === undefined) continue;
      if (fieldName !== WILDCARD && !(fieldName in fields)) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` is in the permissions map but not in the schema.`,
        );
        continue;
      }
      if (!isRule(rule)) {
        problems.push(`Rule for \`${typeName}.${fieldName}\` is ${typeof rule}, not a function.`);
        continue;
      }
      const targets =
        fieldName === WILDCARD ? Object.values(fields) : [fields[fieldName] as AnyField];
      const problem = scopeProblem(rule, `${typeName}.${fieldName}`, targets);
      if (problem) problems.push(problem);
    }
  }

  return problems;
}

// biome-ignore lint/suspicious/noExplicitAny: any field of any type is a target
type AnyField = GraphQLField<any, any>;

/** The arguments an argument-scoping rule injects into. Empty if it is not one. */
function scopeTargetsOf(rule: unknown): readonly string[] {
  const info = (rule as Partial<Record<typeof SCOPE_INFO, ScopeInfo>>)[SCOPE_INFO];
  return info?.into ?? [];
}

/**
 * Checks that every field a scoping rule guards actually has the argument the
 * rule injects into.
 *
 * This matters more than a normal typo check: a rule runs *downstream* of
 * GraphQL's input coercion, so an injected argument is never validated. Writing
 * a filter into an argument the field does not declare fails silently — the
 * resolver ignores it and the field returns unscoped rows.
 */
function scopeProblem(rule: Rule, label: string, targets: AnyField[]): string | undefined {
  for (const into of scopeTargetsOf(rule)) {
    const missing = targets.filter((field) => !field.args.some((arg) => arg.name === into));
    if (missing.length === 0) continue;
    const names = missing.map((field) => `\`${field.name}\``);
    const listed =
      names.length > 4
        ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`
        : names.join(', ');
    return (
      `Rule for \`${label}\` injects a filter into an argument named \`${into}\`, but ` +
      `${listed} ${missing.length === 1 ? 'has' : 'have'} no such argument. ` +
      'An injected argument bypasses GraphQL validation, so this would silently leave the field unscoped.'
    );
  }
  return undefined;
}

/** Reads a rule out of a map entry, tolerating the type-level-`Rule` shorthand. */
function fieldRuleOf(
  entry: Rule | Record<string, Rule | undefined> | undefined,
  fieldName: string,
): Rule | undefined {
  if (entry === undefined) return undefined;
  // `{ Note: rule }` is shorthand for `{ Note: { '*': rule } }`.
  if (isRule(entry)) return fieldName === WILDCARD ? entry : undefined;
  const rule = entry[fieldName];
  return isRule(rule) ? rule : undefined;
}

/**
 * The single rule guarding one field, or `undefined` to leave it unguarded.
 *
 * Wildcards never compose — exactly one rule applies, and the most specific
 * entry wins. See {@link PermissionsMap} for the precedence table; the order of
 * the lookups below *is* that table.
 */
function ruleForField(
  permissions: RawPermissions,
  typeName: string,
  fieldName: string,
  fallbackRule: Rule | undefined,
): Rule | undefined {
  const named = permissions[typeName];
  const wild = permissions[WILDCARD];
  return (
    fieldRuleOf(named, fieldName) ??
    fieldRuleOf(named, WILDCARD) ??
    fieldRuleOf(wild, fieldName) ??
    fieldRuleOf(wild, WILDCARD) ??
    fallbackRule
  );
}

/** Resolves a {@link FallbackError} to the error to throw. */
async function resolveFallbackError(
  fallbackError: FallbackError,
  original: unknown,
  parent: unknown,
  args: unknown,
  context: unknown,
  info: GraphQLResolveInfo,
): Promise<Error> {
  if (typeof fallbackError === 'string') return new Error(fallbackError);
  if (typeof fallbackError === 'function') {
    return fallbackError(original, parent, args, context, info);
  }
  return fallbackError;
}

/**
 * The value a denied field is masked with, or `undefined` if it cannot be masked.
 *
 * A factory, not a value: `[]` handed to two requests would be the same array.
 *
 * Masking is bounded by the schema. A nullable field becomes `null`, and a
 * non-null *list* becomes `[]` — an empty list satisfies non-null, which is what
 * makes masking useful for the `[Todo!]!` shape where a thrown denial otherwise
 * nulls the whole branch. A non-null field of any other kind has no value that
 * satisfies it, so it keeps throwing.
 */
function maskFor(fieldType: GraphQLOutputType): Mask | undefined {
  if (!isNonNullType(fieldType)) return MASK_NULL;
  if (isListType(fieldType.ofType)) return MASK_LIST;
  return undefined;
}

type Mask = () => unknown;

// Shared instances, so a wrapper built for one mask can serve every field with
// the same one — see `withErrorControl`.
const MASK_NULL: Mask = () => null;
const MASK_LIST: Mask = () => [];

/** A rule whose middleware is exactly "run `.check`, then `resolve`". */
function isPlainRule(rule: Rule): rule is CheckableRule {
  return (rule as Partial<Record<typeof PLAIN_RULE, boolean>>)[PLAIN_RULE] === true;
}

/**
 * Wraps one field's rule with the error-control options.
 *
 * Three kinds of failure have to be told apart: a **denial** (the rule did its
 * job), a **rule failure** (the rule itself broke — a `getAbility` that threw),
 * and a **resolver error** (the field was allowed and the resolver failed).
 *
 * A rule built by `rule()` — which is every rule this library produces except
 * `onResult`, `scopeArgs` and `wrap` — exposes its decision as a check, and the
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
function withErrorControl(rule: Rule, options: ErrorControl, mask: Mask | undefined): Rule {
  const { fallbackError, allowExternalErrors, debug } = options;
  if (!fallbackError && allowExternalErrors && !debug && !mask) return rule;

  if (isPlainRule(rule)) return withCheckedErrorControl(rule.check, options, mask);

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
      if (denialKind === undefined && !isResolverError && debug) throw error;

      // Masking replaces a decision the rule made, never a failure it suffered:
      // a broken rule or a broken resolver still surfaces.
      if (mask && denialKind !== undefined) return mask();

      // An explicit denial is the rule author's own words; only the generic
      // default is replaced.
      if (denialKind === 'explicit') throw error;
      if (isResolverError && allowExternalErrors) throw error;
      if (!fallbackError) throw error;

      throw await resolveFallbackError(fallbackError, error, parent, args, context, info);
    }
  };
}

/** The check-based wrapper — see {@link withErrorControl}. */
function withCheckedErrorControl(
  check: Check,
  options: ErrorControl,
  mask: Mask | undefined,
): Rule {
  const { fallbackError, allowExternalErrors, debug } = options;
  const replaceResolverErrors = !allowExternalErrors && fallbackError !== undefined;

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
    if (debug || !fallbackError) return Promise.reject(error);
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
    if (!replaceResolverErrors) return resolve(parent, args, context, info);
    let result: unknown;
    try {
      result = resolve(parent, args, context, info);
    } catch (error) {
      return replaced(fallbackError, error, parent, args, context, info);
    }
    return isThenable(result)
      ? Promise.resolve(result).catch((error) =>
          replaced(fallbackError, error, parent, args, context, info),
        )
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
    if (passes(result)) return allowed(resolve, parent, args, context, info);
    // Masking replaces a decision the rule made, whatever words it chose.
    if (mask) return mask();
    const denial = denialFrom(result) as Error;
    // An explicit denial is the rule author's own words; only the generic
    // default is replaced.
    if (!fallbackError || denialKindOf(denial) === 'explicit') return Promise.reject(denial);
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

/**
 * Looks up the rule guarding one field, already wrapped with the error-control
 * and masking options. Returns `undefined` for a field left unguarded.
 *
 * This is the whole permission layer minus the binding to `graphql-middleware`
 * — see {@link resolvePermissions}.
 */
export type PermissionResolver = (typeName: string, fieldName: string) => Rule | undefined;

/**
 * Resolves a {@link PermissionsMap} against a schema into a per-field lookup,
 * without applying it to anything.
 *
 * {@link applyPermissions} is this plus `graphql-middleware`. Use this directly to
 * enforce the same map through another integration — an Apollo plugin,
 * hand-wrapped resolvers — and get identical wildcard precedence,
 * `fallbackRule` coverage, error control and masking, rather than a second
 * implementation that drifts. The `@vantreeseba/graphql-casl/envelop` entry
 * point is exactly that, already written.
 *
 * The map is validated up front, exactly as `applyPermissions` validates it, so
 * a mismatched map fails at wiring time rather than mid-query. Lookups are
 * memoized, so calling this per resolver call is cheap.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The schema the map is checked against.
 * @param permissions - The permissions map to resolve.
 * @param options - Optional {@link ApplyPermissionsOptions}.
 * @returns A lookup from type and field name to the rule guarding that field.
 * @throws {@link PermissionsError} if the map does not line up with the schema.
 * @example
 * ```ts
 * const permissionFor = resolvePermissions<Resolvers>(schema, permissions);
 * const rule = permissionFor(info.parentType.name, info.fieldName);
 * return rule ? rule(resolver, root, args, context, info) : resolver(root, args, context, info);
 * ```
 */
/**
 * Checks a {@link PermissionsMap} against a schema and throws
 * {@link PermissionsError} if anything in it is stale — without building any
 * middleware.
 *
 * This is the cheap half of {@link applyPermissions}. That function validates
 * *and* wraps a resolver for every guarded field, which is O(fields) and, with a
 * `fallbackRule` set, means every field in the schema. The wrapping dominates by
 * orders of magnitude: on a 4,400-type / 35,200-field generated CRUD schema,
 * `applyPermissions` takes ~1.6s and this takes ~8ms. Validation is the half a
 * test actually wants.
 *
 * The check is the same one `applyPermissions` runs, so a map that passes here
 * passes there.
 *
 * @param schema - The schema to check against.
 * @param permissions - The map to check.
 * @throws {PermissionsError} Aggregating *every* problem, not just the first.
 * @example
 * ```ts
 * it('has no stale keys', () => {
 *   expect(() => validatePermissions(schema, permissions)).not.toThrow();
 * });
 * ```
 */
export function validatePermissions<TResolvers = AnyResolvers>(
  schema: GraphQLSchema,
  permissions: PermissionsMap<NoInfer<TResolvers>>,
): void {
  const problems = collectProblems(schema, permissions as RawPermissions);
  if (problems.length > 0) throw new PermissionsError(problems);
}

export function resolvePermissions<TResolvers = AnyResolvers>(
  schema: GraphQLSchema,
  // `NoInfer` keeps TS from inferring TResolvers *from the map being checked* —
  // which would resolve every type key to `unknown` and report every real field
  // name as unknown. Omitting the generic now falls back to the default instead.
  permissions: PermissionsMap<NoInfer<TResolvers>>,
  options?: ApplyPermissionsOptions,
): PermissionResolver {
  validatePermissions(schema, permissions);
  const raw = permissions as RawPermissions;

  const errorControl: ErrorControl = {
    fallbackError: options?.fallbackError,
    allowExternalErrors: options?.allowExternalErrors ?? true,
    debug: options?.debug ?? false,
    maskDenials: options?.maskDenials ?? false,
  };
  const fallbackRule = options?.fallbackRule;
  const resolved = new Map<string, Rule | undefined>();

  // One wrapper per distinct (rule, mask) pair rather than one per field. The
  // wrapper depends on nothing else, and with a `fallbackRule` set every field
  // in the schema gets one — on a 35,000-field generated CRUD schema that is
  // 35,000 closures for what is really three.
  const wrappers = new Map<Rule, Map<Mask | undefined, Rule>>();
  function wrapped(rule: Rule, mask: Mask | undefined): Rule {
    let byMask = wrappers.get(rule);
    if (!byMask) {
      byMask = new Map();
      wrappers.set(rule, byMask);
    }
    let wrapper = byMask.get(mask);
    if (!wrapper) {
      wrapper = withErrorControl(rule, errorControl, mask);
      byMask.set(mask, wrapper);
    }
    return wrapper;
  }

  return (typeName, fieldName) => {
    const key = `${typeName}.${fieldName}`;
    const cached = resolved.get(key);
    if (cached !== undefined || resolved.has(key)) return cached;

    const type = schema.getTypeMap()[typeName];
    // Introspection is never guarded, so even `fallbackRule: deny` leaves it
    // working; a non-object type has no field to guard in the first place.
    const field =
      isObjectType(type) && !isIntrospectionType(type) ? type.getFields()[fieldName] : undefined;
    const rule = field ? ruleForField(raw, typeName, fieldName, fallbackRule) : undefined;
    const guard =
      rule && field
        ? wrapped(rule, errorControl.maskDenials ? maskFor(field.type) : undefined)
        : undefined;

    resolved.set(key, guard);
    return guard;
  };
}

/**
 * Resolves the map into the per-field middleware `graphql-middleware` consumes.
 *
 * Walks the schema rather than the map, because a wildcard or a `fallbackRule`
 * can guard a field no map entry names. Introspection types are skipped by the
 * resolver itself, so even `fallbackRule: deny` leaves introspection working.
 */
function resolveFieldRules(
  schema: GraphQLSchema,
  permissionFor: PermissionResolver,
): IMiddlewareTypeMap {
  const middleware: IMiddlewareTypeMap = {};

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || isIntrospectionType(type)) continue;

    const fieldRules: IMiddlewareFieldMap = {};
    for (const fieldName of Object.keys(type.getFields())) {
      const rule = permissionFor(type.name, fieldName);
      if (rule) fieldRules[fieldName] = rule;
    }

    if (Object.keys(fieldRules).length > 0) middleware[type.name] = fieldRules;
  }

  return middleware;
}

/**
 * Fields already guarded in place, across every schema this module has touched.
 * Guarding a field twice would stack two rules on it, and a second `inPlace`
 * apply to a schema that was already guarded is far more likely to be a test
 * reusing one base schema than a deliberate layering, so it is refused.
 */
const guardedInPlace = new WeakSet<AnyField>();

/**
 * Wraps one field's resolver in a rule, the same way `graphql-middleware` does:
 * the `resolve` handed to the rule defaults every argument to the current call,
 * so a rule may call it bare or with rewritten arguments.
 */
function wrapResolver(
  resolver: GraphQLFieldResolver<unknown, unknown>,
  rule: Rule,
): GraphQLFieldResolver<unknown, unknown> {
  return (parent, args, context, info) =>
    rule(
      (p = parent, a = args, c = context, i = info) =>
        resolver(p, a as Record<string, unknown>, c, i as GraphQLResolveInfo) as Promise<unknown>,
      parent,
      args,
      context,
      info,
    );
}

/**
 * Guards the schema's fields by replacing their resolvers in place, with the
 * same field selection `graphql-middleware` makes: a field's own resolver if it
 * has one, else a subscription field's `subscribe`, else the default resolver.
 */
function guardInPlace(schema: GraphQLSchema, permissionFor: PermissionResolver): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || isIntrospectionType(type)) continue;

    for (const field of Object.values(type.getFields())) {
      const rule = permissionFor(type.name, field.name);
      if (!rule) continue;
      if (guardedInPlace.has(field)) {
        throw new Error(
          `graphql-casl: \`${type.name}.${field.name}\` is already guarded. ` +
            '`applyPermissions` with `inPlace: true` mutates the schema, so apply it once per ' +
            'schema — or drop `inPlace` to get a guarded copy each time.',
        );
      }
      guardedInPlace.add(field);

      if (field.resolve && field.resolve !== defaultFieldResolver) {
        field.resolve = wrapResolver(field.resolve, rule);
      } else if (field.subscribe) {
        field.subscribe = wrapResolver(field.subscribe, rule);
      } else {
        field.resolve = wrapResolver(defaultFieldResolver, rule);
      }
    }
  }
  return schema;
}

/**
 * A replacement error for denials that did not name one: an `Error`, a message,
 * or a mapper that receives the original error and the resolver arguments.
 *
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
interface ErrorControl {
  fallbackError: FallbackError | undefined;
  allowExternalErrors: boolean;
  debug: boolean;
  maskDenials: boolean;
}

/** Options for {@link applyPermissions}. */
export interface ApplyPermissionsOptions {
  /**
   * Rule for every field no map entry covers — the deny-by-default switch.
   *
   * Without it the map is a whitelist of what to guard, so a type or field it
   * does not name is left completely unguarded, and a field added to the schema
   * later ships unprotected. `fallbackRule: deny` inverts that: every field is
   * guarded unless the map says otherwise. Introspection is unaffected either
   * way.
   *
   * This is the lowest-precedence entry — every map entry, wildcards included,
   * overrides it.
   */
  fallbackRule?: Rule;

  /**
   * Replaces the error thrown by a denial that did not name its own.
   *
   * `Error('Forbidden')` says nothing a client can act on and carries no code.
   * Supply a `GraphQLError` with `extensions.code`, a message, or a mapper that
   * builds one from the field being guarded.
   *
   * A denial that *did* name its error — a check that returned a string or an
   * `Error`, or a CASL `cannot(...).because(...)` reason — is left alone. The
   * rule author was specific on purpose.
   *
   * @example
   * ```ts
   * fallbackError: (_err, _parent, _args, _ctx, info) =>
   *   new GraphQLError(`Not authorized to read ${info.parentType.name}.${info.fieldName}`, {
   *     extensions: { code: 'FORBIDDEN' },
   *   }),
   * ```
   */
  fallbackError?: FallbackError;

  /**
   * Whether an error thrown by the *resolver* of a permitted field reaches the
   * client unchanged. Defaults to `true`.
   *
   * Setting it to `false` replaces those errors with `fallbackError`, so an
   * internal failure — a database message, a stack-revealing library error —
   * cannot leak through a guarded field. It has no effect without a
   * `fallbackError` to replace them with.
   *
   * **This default is the opposite of `graphql-shield`'s**, which masks by
   * default. Masking is the safer behaviour, but it is not what this library has
   * done since 1.0, and silently swallowing resolver errors on upgrade would be
   * worse than leaving the choice explicit. Set it to `false` deliberately.
   */
  allowExternalErrors?: boolean;

  /**
   * Whether an error raised *inside a rule* is rethrown untouched. Defaults to
   * `false`.
   *
   * A rule that breaks — a `getAbility` that throws, a check with a bug — is not
   * a denial, but it arrives as a thrown error just like one, so in production it
   * is treated as a failure to authorize. That makes it indistinguishable from a
   * legitimate `Forbidden` while debugging. `debug: true` lets it through with
   * its original message and stack.
   *
   * Note this only bypasses `fallbackError`; the rule still denied the field.
   */
  debug?: boolean;

  /**
   * Whether a denied field resolves to an empty value instead of raising an
   * error. Defaults to `false`.
   *
   * A thrown denial propagates up the non-null chain: deny one field of
   * `todos: [Todo!]!` and the *entire* `data` payload becomes `null`, so an
   * unauthorized corner of a query destroys the authorized rest of it. Masking
   * makes partial responses usable — the denied field comes back as `null`, or
   * as `[]` where the field is a non-null list, and the rest of the response
   * survives.
   *
   * The trade-off is that the client is no longer told *why* something is
   * missing: "you may not read this" and "this does not exist" become the same
   * response. That is a feature when the existence of the record is itself
   * privileged, and a support burden otherwise.
   *
   * Two limits worth knowing:
   *
   * - A non-null field that is not a list — `id: ID!` — has no value that
   *   satisfies it, so it still throws. Masking is bounded by the schema.
   * - Only *denials* are masked. A rule that threw a bug of its own, or a
   *   resolver that failed, still surfaces its error; silently nulling those
   *   would hide outages as permission decisions.
   */
  maskDenials?: boolean;

  /**
   * Whether to guard the schema you passed in, instead of a guarded copy.
   * Defaults to `false`.
   *
   * By default `applyPermissions` hands the map to `graphql-middleware`, which
   * rebuilds the schema. That rebuild is the whole cost of applying: on a
   * 1,000-type schema it is tens of milliseconds, and on a large generated CRUD
   * schema it is seconds. `inPlace: true` skips it — the rules are resolved
   * exactly as before, then each guarded field's resolver is replaced on the
   * schema itself, in a single walk. Enforcement is identical: the same fields
   * are guarded, the same resolver (a field's own, a subscription's
   * `subscribe`, or the default resolver) is wrapped.
   *
   * This saves apply time only; per-request cost is the same either way. A
   * server that builds its schema once gains a few tens of milliseconds at
   * startup and should keep the default. It is meant for the places
   * `applyPermissions` runs repeatedly — a test suite guarding a fresh schema
   * per test, hot reload, per-tenant schemas, a recomposing gateway.
   *
   * The schema is **mutated** and returned for convenience. Apply once per
   * schema — guarding a schema that is already guarded throws, since stacking
   * two maps is almost always a test reusing one base schema. Leave this off
   * when you need the unguarded original too, or when something else already
   * holds the schema and expects it to stay as built.
   *
   * Ignored by `resolvePermissions` and the envelop plugin, which apply nothing.
   */
  inPlace?: boolean;
}

/**
 * Applies a {@link PermissionsMap} to an executable schema via `graphql-middleware`.
 *
 * The map is validated against the schema first: unknown types and fields,
 * non-function rules, and entries that would be silently inert (introspection
 * types, and interfaces/unions, whose fields are resolved against the concrete
 * object type) all raise a {@link PermissionsError} listing every problem at once.
 * This catches what `PermissionsMap`'s compile-time keys cannot — rules loaded
 * from a database, built in plain JavaScript, or written against a schema that has
 * since drifted.
 *
 * Types not named in the map are left unguarded — the map is a whitelist of what
 * to guard, not a schema-coverage guarantee. Pass
 * {@link ApplyPermissionsOptions.fallbackRule} to invert that.
 *
 * This is also where the error-control options apply, since they have to wrap
 * every guarded field: {@link ApplyPermissionsOptions.fallbackError} replaces the
 * generic denial error, {@link ApplyPermissionsOptions.allowExternalErrors}
 * governs whether resolver errors reach the client, and
 * {@link ApplyPermissionsOptions.debug} surfaces a rule's own failures instead of
 * reporting them as denials, and {@link ApplyPermissionsOptions.maskDenials}
 * resolves a denied field to `null`/`[]` rather than raising an error.
 *
 * The returned schema is a guarded *copy* built by `graphql-middleware`. That
 * rebuild is where all the time goes on a big schema;
 * {@link ApplyPermissionsOptions.inPlace} guards the schema you passed instead
 * and skips it.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The executable schema to guard.
 * @param permissions - The permissions map to enforce.
 * @param options - Optional {@link ApplyPermissionsOptions}.
 * @returns The schema wrapped with the permission middleware — or, with
 * `inPlace`, the same schema, now guarded.
 * @throws {@link PermissionsError} if the map does not line up with the schema.
 * @example
 * ```ts
 * const schema = applyPermissions<Resolvers>(makeExecutableSchema({ typeDefs, resolvers }), permissions);
 * ```
 */
export function applyPermissions<TResolvers = AnyResolvers>(
  schema: GraphQLSchema,
  // `NoInfer` keeps TS from inferring TResolvers *from the map being checked* —
  // which would resolve every type key to `unknown` and report every real field
  // name as unknown. Omitting the generic now falls back to the default instead.
  permissions: PermissionsMap<NoInfer<TResolvers>>,
  options?: ApplyPermissionsOptions,
): GraphQLSchema {
  const permissionFor = resolvePermissions(schema, permissions, options);
  if (options?.inPlace) return guardInPlace(schema, permissionFor);
  return applyMiddleware(schema, resolveFieldRules(schema, permissionFor));
}
