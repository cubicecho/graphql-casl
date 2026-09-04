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
  type ExecutionResult,
  type GraphQLAbstractType,
  GraphQLError,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  locatedError,
  responsePathAsArray,
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
 * The object types an abstract type stands for: an interface's implementors
 * (through interfaces that implement it, too) or a union's members. These are
 * the types an entry keyed on the abstract type actually guards, since
 * execution resolves every field against the concrete object type.
 */
function possibleTypesOf(
  schema: GraphQLSchema,
  abstract: GraphQLAbstractType,
): GraphQLObjectType[] {
  if (isUnionType(abstract)) return [...abstract.getTypes()];
  const objects = new Set<GraphQLObjectType>();
  const seen = new Set<GraphQLInterfaceType>();
  const visit = (iface: GraphQLInterfaceType): void => {
    if (seen.has(iface)) return;
    seen.add(iface);
    const implementations = schema.getImplementations(iface);
    for (const object of implementations.objects) objects.add(object);
    for (const sub of implementations.interfaces) visit(sub);
  };
  visit(abstract);
  return [...objects];
}

/**
 * Object type name -> the interface and union entries in the map that cover it,
 * in map order. Only types under at least one such entry are listed.
 */
type Supertypes = ReadonlyMap<string, readonly string[]>;

function supertypesOf(schema: GraphQLSchema, permissions: RawPermissions): Supertypes {
  const supertypes = new Map<string, string[]>();
  for (const [typeName, entry] of Object.entries(permissions)) {
    if (entry == null) continue;
    const type = schema.getType(typeName);
    if (!type || !isAbstractType(type)) continue;
    for (const object of possibleTypesOf(schema, type)) {
      const seen = supertypes.get(object.name);
      if (seen) seen.push(typeName);
      else supertypes.set(object.name, [typeName]);
    }
  }
  return supertypes;
}

/** `\`A\``, `\`A\` and \`B\``, `\`A\`, \`B\` and \`C\`` — for a problem message. */
function listed(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length === 1) return quoted[0] as string;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The abstract entries giving `typeName` a rule for `key`, by name — one per
 * distinct rule, so the same rule reached through two interfaces counts once.
 */
function sourcesOf(
  permissions: RawPermissions,
  abstracts: readonly string[],
  key: string,
): string[] {
  const byRule = new Map<Rule, string>();
  for (const name of abstracts) {
    const rule = fieldRuleOf(permissions[name], key);
    if (rule && !byRule.has(rule)) byRule.set(rule, name);
  }
  return [...byRule.values()];
}

/**
 * Where two abstract entries would both guard a field of one implementor and
 * the implementor does not choose between them.
 *
 * Inherited rules never compose, and picking one silently — by map order, say
 * — would make the outcome depend on which interface was listed first. So a
 * field two interfaces both cover is a problem until the object type's own
 * entry settles it: `T.f` settles `f` outright, and `T['*']` settles the
 * type-wide tier (an `I.f` still beats it, as the precedence table says).
 */
function ambiguityProblems(
  schema: GraphQLSchema,
  permissions: RawPermissions,
  supertypes: Supertypes,
): string[] {
  const problems: string[] = [];
  for (const [typeName, abstracts] of supertypes) {
    if (abstracts.length < 2) continue;
    const type = schema.getType(typeName) as GraphQLObjectType;
    const own = permissions[typeName];
    const ownWild = fieldRuleOf(own, WILDCARD) !== undefined;
    let wildSources: string[] | undefined;
    const unsettled: string[] = [];

    for (const fieldName of Object.keys(type.getFields())) {
      if (fieldRuleOf(own, fieldName)) continue;
      const fieldSources = sourcesOf(permissions, abstracts, fieldName);
      if (fieldSources.length > 1) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` gets a rule from ${listed(fieldSources)}, and ` +
            `\`${typeName}\` does not say which applies — add \`${typeName}: { ${fieldName}: … }\` to choose.`,
        );
        continue;
      }
      if (fieldSources.length === 1 || ownWild) continue;
      wildSources ??= sourcesOf(permissions, abstracts, WILDCARD);
      if (wildSources.length > 1) unsettled.push(fieldName);
    }

    if (wildSources && unsettled.length > 0) {
      problems.push(
        `\`${typeName}\` gets a type-wide rule from ${listed(wildSources)}, and nothing says ` +
          `which applies to ${listed(unsettled)} — add \`${typeName}: { '*': … }\`, or a rule per field, to choose.`,
      );
    }
  }
  return problems;
}

/**
 * Every way a permissions map can fail to line up with the schema.
 *
 * `graphql-middleware` does check that types and fields exist, but it fails on
 * the first one and crashes outright on a union (`type.getFields is not a
 * function`). More importantly it accepts entries that are silently inert: a rule
 * on an interface type type-checks, applies cleanly, and then never runs, because
 * execution resolves fields against the concrete object type. In an authorization
 * library a rule that quietly never runs is the worst possible failure, so
 * nothing here is allowed to be inert: an interface or union entry is resolved
 * onto the object types it stands for (see {@link supertypesOf}), and anything
 * that cannot be — an introspection type, a union's named field, a field the
 * interface does not declare — is rejected outright.
 */
function collectProblems(
  schema: GraphQLSchema,
  permissions: RawPermissions,
  supertypes: Supertypes,
): string[] {
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

  for (const [typeName, rawEntry] of Object.entries(permissions)) {
    if (rawEntry == null) continue;
    // `{ Note: rule }` is shorthand for `{ Note: { '*': rule } }`, and is
    // checked as such — a bare scoping rule still has arguments to verify.
    const entry = isRule(rawEntry) ? { [WILDCARD]: rawEntry } : rawEntry;

    // A wildcard type is not looked up in the schema; its field keys are checked
    // against every guardable field instead, so a typo there is still caught.
    if (typeName === WILDCARD) {
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
    if (!isObjectType(type) && !isAbstractType(type)) {
      problems.push(`\`${typeName}\` is ${describeKind(type)}, not an object type.`);
      continue;
    }

    // An abstract entry guards the fields of the object types it stands for. A
    // union declares no fields of its own, so only `'*'` can be attached to it.
    const declared = isUnionType(type) ? undefined : type.getFields();
    const guarded = isAbstractType(type) ? possibleTypesOf(schema, type) : [type];
    for (const [fieldName, rule] of Object.entries(entry)) {
      if (rule === undefined) continue;
      if (fieldName !== WILDCARD && !declared) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` is in the permissions map but \`${typeName}\` is a union type, ` +
            "which declares no fields — only `'*'` can be attached to a union.",
        );
        continue;
      }
      if (fieldName !== WILDCARD && !(fieldName in (declared as Record<string, AnyField>))) {
        problems.push(
          isInterfaceType(type)
            ? `Field \`${typeName}.${fieldName}\` is in the permissions map but interface \`${typeName}\` does not declare it.`
            : `Field \`${typeName}.${fieldName}\` is in the permissions map but not in the schema.`,
        );
        continue;
      }
      if (!isRule(rule)) {
        problems.push(`Rule for \`${typeName}.${fieldName}\` is ${typeof rule}, not a function.`);
        continue;
      }
      const targets =
        fieldName === WILDCARD
          ? guarded.flatMap((object) => Object.values(object.getFields()))
          : guarded.map((object) => object.getFields()[fieldName] as AnyField);
      const problem = scopeProblem(rule, `${typeName}.${fieldName}`, targets);
      if (problem) problems.push(problem);
    }
  }

  problems.push(...ambiguityProblems(schema, permissions, supertypes));
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
    // By name, once: an interface field's targets are that field on every implementor.
    const names = [...new Set(missing.map((field) => `\`${field.name}\``))];
    const shown =
      names.length > 4
        ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`
        : names.join(', ');
    return (
      `Rule for \`${label}\` injects a filter into an argument named \`${into}\`, but ` +
      `${shown} ${names.length === 1 ? 'has' : 'have'} no such argument. ` +
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
 * The rule the interfaces (and unions) an object type belongs to give one of its
 * field keys. Validation has already rejected the case where two of them
 * disagree, so the first one found is the only one.
 */
function inheritedRuleOf(
  permissions: RawPermissions,
  abstracts: readonly string[] | undefined,
  fieldName: string,
): Rule | undefined {
  if (!abstracts) return undefined;
  for (const name of abstracts) {
    const rule = fieldRuleOf(permissions[name], fieldName);
    if (rule) return rule;
  }
  return undefined;
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
  supertypes: Supertypes,
  fallbackRule: Rule | undefined,
): Rule | undefined {
  const named = permissions[typeName];
  const abstracts = supertypes.get(typeName);
  const wild = permissions[WILDCARD];
  return (
    fieldRuleOf(named, fieldName) ??
    inheritedRuleOf(permissions, abstracts, fieldName) ??
    fieldRuleOf(named, WILDCARD) ??
    inheritedRuleOf(permissions, abstracts, WILDCARD) ??
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

/**
 * The `extensions.code` a denial carries under `onDeny: 'filter'`.
 *
 * It is Apollo Router's code for a field its authorization directives removed
 * from a query, so clients and tooling that already handle the router's partial
 * responses handle these without learning a second vocabulary.
 */
export const UNAUTHORIZED_FIELD_OR_TYPE = 'UNAUTHORIZED_FIELD_OR_TYPE';

/**
 * The response extension {@link reportDenials} fills under
 * `report: 'extensions'` — again Apollo Router's key, holding the same error
 * objects it would otherwise put in `errors`.
 */
export const AUTHORIZATION_ERRORS_EXTENSION = 'authorizationErrors';

/** What a denied field does — see {@link ApplyPermissionsOptions.onDeny}. */
export type DenialMode = 'reject' | 'filter' | 'mask';

/** Where a filtered denial is reported — see {@link ApplyPermissionsOptions.report}. */
export type DenialReport = 'errors' | 'extensions';

/** Filtered denials the response itself could not carry, per request context. */
interface DenialRecord {
  report: DenialReport;
  errors: GraphQLError[];
}

const recorded = new WeakMap<object, DenialRecord>();

/** Whether a context value can key the record — a `WeakMap` needs an object. */
function isRecordable(context: unknown): context is object {
  return (typeof context === 'object' && context !== null) || typeof context === 'function';
}

/**
 * The error a filtered denial is reported as: the denial's own words under the
 * standard code. A denial that already names a code — a check that returned a
 * `GraphQLError` with one, or a `fallbackError` that built one — is the rule
 * author's deliberate choice and is kept as is.
 */
function standardized(denial: Error): Error {
  const extensions = (denial as { extensions?: unknown }).extensions;
  const own =
    typeof extensions === 'object' && extensions !== null
      ? (extensions as Record<string, unknown>)
      : undefined;
  if (typeof own?.code === 'string') return denial;
  return new GraphQLError(denial.message, {
    originalError: denial,
    extensions: { ...own, code: UNAUTHORIZED_FIELD_OR_TYPE },
  });
}

/**
 * Delivers a denial under `onDeny: 'filter'`: the field resolves to its mask and
 * the denial is reported.
 *
 * Where the field can carry the report itself it does — a nullable field that
 * rejects *is* `null` plus an error at that path, and needs no response hook.
 * Everything else goes through the per-request record {@link reportDenials}
 * drains: a non-null list, whose `[]` cannot also be an error, and every denial
 * under `report: 'extensions'`. A field with no mask at all — non-null, not a
 * list — cannot be filtered, and rejects with the standard code so the denial
 * propagates exactly as Apollo Router's does. So does a denial with nowhere to
 * be recorded, when the context is not an object.
 */
function deliver(
  denial: Error,
  mask: Mask | undefined,
  report: DenialReport,
  context: unknown,
  info: GraphQLResolveInfo,
): unknown {
  const error = standardized(denial);
  if (!mask || (mask === MASK_NULL && report === 'errors') || !isRecordable(context)) {
    return Promise.reject(error);
  }
  let record = recorded.get(context);
  if (!record) {
    record = { report, errors: [] };
    recorded.set(context, record);
  }
  record.errors.push(locatedError(error, info.fieldNodes, responsePathAsArray(info.path)));
  return mask();
}

/**
 * Merges the denials `onDeny: 'filter'` recorded for a request into its
 * execution result — the ones the response could not carry through the denied
 * field itself (see {@link ApplyPermissionsOptions.onDeny}).
 *
 * The `/envelop` entry point calls this for you. Under `applyPermissions` no
 * hook sees the finished response, so call it from your server's own — Apollo
 * Server's `willSendResponse`, or straight after `execute`:
 *
 * ```ts
 * const result = reportDenials(contextValue, await execute({ schema, document, contextValue }));
 * ```
 *
 * Under `report: 'errors'` the denials are appended to `result.errors`; under
 * `report: 'extensions'` they are formatted into
 * `result.extensions.authorizationErrors`. The record is drained, so a context
 * is reported once, and a context with nothing recorded returns the result
 * untouched. Nothing is recorded under `'reject'` or `'mask'`.
 *
 * @param context - The request's context value: the one the resolvers saw.
 * @param result - The execution result to report into.
 * @returns The result with the denials merged in, or `result` itself if there were none.
 */
export function reportDenials<TResult extends ExecutionResult>(
  context: unknown,
  result: TResult,
): TResult {
  if (!isRecordable(context)) return result;
  const record = recorded.get(context);
  if (!record) return result;
  recorded.delete(context);
  if (record.report === 'errors') {
    return { ...result, errors: [...(result.errors ?? []), ...record.errors] };
  }
  const existing = result.extensions?.[AUTHORIZATION_ERRORS_EXTENSION];
  const previous = Array.isArray(existing) ? existing : [];
  return {
    ...result,
    extensions: {
      ...result.extensions,
      [AUTHORIZATION_ERRORS_EXTENSION]: [
        ...previous,
        ...record.errors.map((error) => error.toJSON()),
      ],
    },
  };
}

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
function withErrorControl(rule: Rule, options: ErrorControl, mask: Mask | undefined): Rule {
  const { fallbackError, allowExternalErrors, debug, onDeny, report } = options;
  if (!fallbackError && allowExternalErrors && !debug && !mask && onDeny !== 'filter') return rule;

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

      // Filtering changes how a decision is delivered, not what it says: the
      // denial keeps its words, `fallbackError` still rewords a generic one,
      // and only then is it masked and reported.
      if (denialKind !== undefined && onDeny === 'filter') {
        const denial =
          fallbackError && denialKind === 'default'
            ? await resolveFallbackError(fallbackError, error, parent, args, context, info)
            : (error as Error);
        return deliver(denial, mask, report, context, info);
      }

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
  const { fallbackError, allowExternalErrors, debug, onDeny, report } = options;
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
    if (mask && onDeny === 'mask') return mask();
    const denial = denialFrom(result) as Error;
    // An explicit denial is the rule author's own words; only the generic
    // default is replaced.
    const explicit = denialKindOf(denial) === 'explicit';
    if (onDeny === 'filter') {
      if (fallbackError && !explicit) {
        return resolveFallbackError(fallbackError, denial, parent, args, context, info).then(
          (error) => deliver(error, mask, report, context, info),
        );
      }
      return deliver(denial, mask, report, context, info);
    }
    if (!fallbackError || explicit) return Promise.reject(denial);
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
  validated(schema, permissions as RawPermissions);
}

/** The check behind {@link validatePermissions}, handing back what the resolver reuses. */
function validated(schema: GraphQLSchema, permissions: RawPermissions): Supertypes {
  const supertypes = supertypesOf(schema, permissions);
  const problems = collectProblems(schema, permissions, supertypes);
  if (problems.length > 0) throw new PermissionsError(problems);
  return supertypes;
}

export function resolvePermissions<TResolvers = AnyResolvers>(
  schema: GraphQLSchema,
  // `NoInfer` keeps TS from inferring TResolvers *from the map being checked* —
  // which would resolve every type key to `unknown` and report every real field
  // name as unknown. Omitting the generic now falls back to the default instead.
  permissions: PermissionsMap<NoInfer<TResolvers>>,
  options?: ApplyPermissionsOptions,
): PermissionResolver {
  const raw = permissions as RawPermissions;
  const supertypes = validated(schema, raw);

  // `strict` moves the defaults, never the keys actually passed.
  const strict = options?.strict ?? false;
  const errorControl: ErrorControl = {
    fallbackError: options?.fallbackError,
    allowExternalErrors: options?.allowExternalErrors ?? !strict,
    debug: options?.debug ?? false,
    onDeny: denialModeOf(options),
    report: options?.report ?? 'errors',
  };

  // Validated and resolved exactly as usual, so a stale map or a contradictory
  // option still fails; only the lookup guards nothing.
  if (options?.disabled) return () => undefined;

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
    const rule = field
      ? ruleForField(raw, typeName, fieldName, supertypes, fallbackRule)
      : undefined;
    const guard =
      rule && field
        ? wrapped(rule, errorControl.onDeny === 'reject' ? undefined : maskFor(field.type))
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
  onDeny: DenialMode;
  report: DenialReport;
}

/**
 * Resolves `onDeny` — from the key itself, the `maskDenials` shorthand, or the
 * `strict` default — rejecting a contradiction. Shared with the entry points
 * that need the resolved mode rather than the key as passed.
 *
 * @internal
 */
export function denialModeOf(options: ApplyPermissionsOptions | undefined): DenialMode {
  const onDeny =
    options?.onDeny ?? (options?.maskDenials ? 'mask' : options?.strict ? 'filter' : 'reject');
  const problems: string[] = [];
  if (options?.maskDenials && onDeny !== 'mask') {
    problems.push(
      `\`maskDenials: true\` is \`onDeny: 'mask'\`, which contradicts \`onDeny: '${onDeny}'\``,
    );
  }
  if (options?.report !== undefined && onDeny !== 'filter') {
    problems.push(`\`report\` only applies under \`onDeny: 'filter'\`, not \`'${onDeny}'\``);
  }
  if (problems.length > 0)
    throw new PermissionsError(problems, 'the options contradict each other');
  return onDeny;
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
   * worse than leaving the choice explicit. Set it to `false` deliberately, or
   * set {@link strict}, which defaults it to `false` along with the other 2.0
   * default.
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
   * What a denied field does. Defaults to `'reject'`.
   *
   * - `'reject'` throws the denial. GraphQL null propagation then applies: deny
   *   one field of `todos: [Todo!]!` and the *entire* `data` payload becomes
   *   `null`, so an unauthorized corner of a query destroys the authorized rest
   *   of it.
   * - `'filter'` resolves the denied field to `null`, or to `[]` where it is a
   *   non-null list, keeps executing, and reports the denial under the standard
   *   code {@link UNAUTHORIZED_FIELD_OR_TYPE} with the field's path — the
   *   partial-response contract Apollo Router's authorization directives set,
   *   so clients that handle those handle this. Where it lands is
   *   {@link report}. `fallbackError` still rewords a generic denial first, and
   *   a denial that names its own code keeps it.
   * - `'mask'` resolves the field the same way and says nothing, so "you may
   *   not read this" and "this does not exist" become the same response. That
   *   is the point when the existence of a record is itself privileged, and a
   *   support burden otherwise.
   *
   * Two limits bound both `'filter'` and `'mask'`:
   *
   * - A non-null field that is not a list — `id: ID!` — has no value that
   *   satisfies it, so it still rejects (under the standard code with
   *   `'filter'`) and propagates to the nearest nullable ancestor, exactly as
   *   the router's do. Filtering is bounded by the schema.
   * - Only *denials* are filtered or masked. A rule that threw a bug of its
   *   own, or a resolver that failed, still surfaces its error; silently
   *   nulling those would hide outages as permission decisions.
   *
   * Under `'filter'`, a denial the field cannot carry itself — a non-null list
   * resolved to `[]`, and everything under `report: 'extensions'` — is held per
   * request until {@link reportDenials} merges it into the result. The
   * `/envelop` entry point does that for you; under `applyPermissions`, call it
   * from your server's response hook. Without that call those denials are
   * silently masked, which is the one way `'filter'` degrades. The record keys
   * on the context value, so it must be an object; with any other context the
   * denial rejects instead.
   *
   * The default stays `'reject'` for compatibility. `'filter'` is the better
   * choice for new code and becomes the default in 2.0 — or today, under
   * {@link strict}.
   */
  onDeny?: DenialMode;

  /**
   * Where a filtered denial is reported. Defaults to `'errors'`. Only applies
   * under `onDeny: 'filter'`, and is rejected alongside any other mode.
   *
   * - `'errors'` puts it in the response's `errors` array, as Apollo Router
   *   does by default. A nullable field carries it by rejecting — `null` plus
   *   an error at that path, no hook needed — and a non-null list's `[]` goes
   *   through {@link reportDenials}.
   * - `'extensions'` keeps `errors` clean and lists them under
   *   `extensions.authorizationErrors` instead — the router's key — for clients
   *   that treat any entry in `errors` as a failed request but still want to
   *   know which parts of the query were filtered. Every denial goes through
   *   {@link reportDenials} in this mode.
   */
  report?: DenialReport;

  /**
   * Shorthand for `onDeny: 'mask'`, from before {@link onDeny} existed. Setting
   * the two to different things is rejected.
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

  /**
   * The defaults planned for 2.0, today: `onDeny: 'filter'` and
   * `allowExternalErrors: false`. Defaults to `false`.
   *
   * Both 1.x defaults are compatibility choices — `'reject'` is what 1.0 did,
   * and letting resolver errors through is what this library has always done —
   * and both are the weaker choice for new code. `strict: true` picks the
   * stricter pair without you having to remember which two, and is what 2.0
   * will do without it.
   *
   * It moves defaults, never mandates. A key you pass still wins:
   * `{ strict: true, onDeny: 'reject' }` rejects, and `maskDenials: true` —
   * itself a choice of mode — still masks.
   */
  strict?: boolean;

  /**
   * Switches enforcement off while keeping validation on. Defaults to `false`.
   *
   * A test that wants the schema without its rules — to seed a fixture, or to
   * prove a failure is the resolver's and not authorization — should not have
   * to hand-roll a bypass. With `disabled: true`, `applyPermissions` still
   * checks the map against the schema, so a stale type or field still throws
   * {@link PermissionsError} and drift is still caught, but returns the schema
   * unguarded: the one you passed, untouched, with or without `inPlace`. The
   * envelop plugin likewise validates and wraps nothing.
   *
   * A test-only switch. Do not wire it to an environment variable you do not
   * control: a misconfigured deploy would ship with every rule off and nothing
   * to say so.
   */
  disabled?: boolean;
}

/**
 * Applies a {@link PermissionsMap} to an executable schema via `graphql-middleware`.
 *
 * The map is validated against the schema first: unknown types and fields,
 * non-function rules, and entries that would be silently inert (introspection
 * types, a named field on a union) all raise a {@link PermissionsError} listing
 * every problem at once. This catches what `PermissionsMap`'s compile-time keys
 * cannot — rules loaded from a database, built in plain JavaScript, or written
 * against a schema that has since drifted.
 *
 * An entry keyed on an interface guards that field on every type implementing
 * it, and a `'*'` entry on a union guards every field of every member; an
 * implementor's own entry overrides either. Two interfaces that both cover a
 * field of one implementor are ambiguous and rejected until the implementor
 * chooses — see {@link PermissionsMap} for the precedence table.
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
 * reporting them as denials, and {@link ApplyPermissionsOptions.onDeny} filters
 * or masks a denied field rather than raising an error.
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
  // Validated above; the schema goes back exactly as it came, on either path.
  if (options?.disabled) return schema;
  if (options?.inPlace) return guardInPlace(schema, permissionFor);
  return applyMiddleware(schema, resolveFieldRules(schema, permissionFor));
}
