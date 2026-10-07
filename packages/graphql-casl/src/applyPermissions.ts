/**
 * The schema walk behind {@link applyPermissions}.
 *
 * @remarks
 * Resolves a validated permissions map into a per-field rule lookup, wrapped
 * with the error-control options, and binds it to the schema — through
 * `graphql-middleware`, or in place.
 */

import {
  defaultFieldResolver,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  isIntrospectionType,
  isObjectType,
} from 'graphql';
import { applyMiddleware, type IMiddlewareFieldMap, type IMiddlewareTypeMap } from 'graphql-middleware';
import {
  DenialMode,
  DenialReport,
  type Mask,
  maskFor,
  // The two below are named only by the option docs' `{@link}`s.
  type reportDenials,
  type UNAUTHORIZED_FIELD_OR_TYPE,
} from './denials.js';
import { type ErrorControl, type FallbackError, withErrorControl } from './errorControl.js';
import { getOrCreate } from './internal.js';
import { type AnyField, validated } from './mapValidation.js';
import { PermissionsError } from './permissionsError.js';
import { type RawPermissions, ruleForField } from './rulePrecedence.js';
import type { AnyResolvers, PermissionsMap, Rule } from './rules.js';

/**
 * Resolves `onDeny` — from the key itself, the `maskDenials` shorthand, or the
 * `strict` default — rejecting a contradiction. Shared with the entry points
 * that need the resolved mode rather than the key as passed.
 *
 * @param options - The options as passed.
 * @returns The mode in force.
 * @internal
 */
export function denialModeOf(options: ApplyPermissionsOptions | undefined): DenialMode {
  const onDeny =
    options?.onDeny ??
    (options?.maskDenials ? DenialMode.Mask : options?.strict ? DenialMode.Filter : DenialMode.Reject);
  const problems: string[] = [];
  if (options?.maskDenials && onDeny !== DenialMode.Mask) {
    problems.push(`\`maskDenials: true\` is \`onDeny: 'mask'\`, which contradicts \`onDeny: '${onDeny}'\``);
  }
  if (options?.report !== undefined && onDeny !== DenialMode.Filter) {
    problems.push(`\`report\` only applies under \`onDeny: 'filter'\`, not \`'${onDeny}'\``);
  }
  if (problems.length > 0) {
    throw new PermissionsError(problems, 'the options contradict each other');
  }
  return onDeny;
}

/** Options for {@link applyPermissions}. */
export interface ApplyPermissionsOptions {
  /**
   * Rule for every field no map entry covers — the deny-by-default switch.
   *
   * @remarks
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
   * @remarks
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
   * client unchanged.
   *
   * @remarks
   * Defaults to `true`.
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
   * Whether an error raised *inside a rule* is rethrown untouched.
   *
   * @remarks
   * Defaults to `false`.
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
   * What a denied field does.
   *
   * @remarks
   * Defaults to `'reject'`.
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
   * Where a filtered denial is reported.
   *
   * @remarks
   * Defaults to `'errors'`. Only applies under `onDeny: 'filter'`, and is
   * rejected alongside any other mode.
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
   *
   * @remarks
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
   * `allowExternalErrors: false`.
   *
   * @remarks
   * Defaults to `false`.
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
   * Switches enforcement off while keeping validation on.
   *
   * @remarks
   * Defaults to `false`.
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
 * Looks up the rule guarding one field, already wrapped with the error-control
 * and masking options.
 *
 * @remarks
 * Returns `undefined` for a field left unguarded.
 *
 * This is the whole permission layer minus the binding to `graphql-middleware`
 * — see {@link resolvePermissions}.
 */
export type PermissionResolver = (typeName: string, fieldName: string) => Rule | undefined;

/**
 * Resolves a {@link PermissionsMap} against a schema into a per-field lookup,
 * without applying it to anything.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The schema the map is checked against.
 * @param permissions - The permissions map to resolve.
 * @param options - Optional {@link ApplyPermissionsOptions}.
 * @returns A lookup from type and field name to the rule guarding that field.
 * @throws {@link PermissionsError} if the map does not line up with the schema.
 *
 * @remarks
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
 * @example
 * ```ts
 * const permissionFor = resolvePermissions<Resolvers>(schema, permissions);
 * const rule = permissionFor(info.parentType.name, info.fieldName);
 * return rule ? rule(resolver, root, args, context, info) : resolver(root, args, context, info);
 * ```
 */
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
    allowExternalErrors: options?.allowExternalErrors ?? strict === false,
    debug: options?.debug ?? false,
    onDeny: denialModeOf(options),
    report: options?.report ?? DenialReport.Errors,
  };

  // Validated and resolved exactly as usual, so a stale map or a contradictory
  // option still fails; only the lookup guards nothing.
  if (options?.disabled) {
    return () => undefined;
  }

  const fallbackRule = options?.fallbackRule;
  const resolved = new Map<string, Rule | undefined>();

  // One wrapper per distinct (rule, mask) pair rather than one per field. The
  // wrapper depends on nothing else, and with a `fallbackRule` set every field
  // in the schema gets one — on a 35,000-field generated CRUD schema that is
  // 35,000 closures for what is really three.
  const wrappers = new Map<Rule, Map<Mask | undefined, Rule>>();
  function wrapped(rule: Rule, mask: Mask | undefined): Rule {
    const byMask = getOrCreate(wrappers, rule, () => new Map());
    return getOrCreate(byMask, mask, () => withErrorControl(rule, errorControl, mask));
  }

  return (typeName, fieldName) => {
    const key = `${typeName}.${fieldName}`;
    const cached = resolved.get(key);
    if (cached !== undefined || resolved.has(key)) {
      return cached;
    }

    const type = schema.getTypeMap()[typeName];
    // Introspection is never guarded, so even `fallbackRule: deny` leaves it
    // working; a non-object type has no field to guard in the first place.
    const field = isObjectType(type) && isIntrospectionType(type) === false ? type.getFields()[fieldName] : undefined;
    const rule = field ? ruleForField(raw, typeName, fieldName, supertypes, fallbackRule) : undefined;
    const guard =
      rule && field
        ? wrapped(rule, errorControl.onDeny === DenialMode.Reject ? undefined : maskFor(field.type))
        : undefined;

    resolved.set(key, guard);
    return guard;
  };
}

/**
 * Resolves the map into the per-field middleware `graphql-middleware` consumes.
 *
 * @param schema - The schema.
 * @param permissionFor - Looks up the rule for a field.
 * @returns Type name to field name to middleware.
 *
 * @remarks
 * Walks the schema rather than the map, because a wildcard or a `fallbackRule`
 * can guard a field no map entry names. Introspection types are skipped by the
 * resolver itself, so even `fallbackRule: deny` leaves introspection working.
 */
function resolveFieldRules(schema: GraphQLSchema, permissionFor: PermissionResolver): IMiddlewareTypeMap {
  const middleware: IMiddlewareTypeMap = {};

  for (const type of Object.values(schema.getTypeMap())) {
    if (isObjectType(type) === false || isIntrospectionType(type)) {
      continue;
    }

    const fieldRules: IMiddlewareFieldMap = {};
    for (const fieldName of Object.keys(type.getFields())) {
      const rule = permissionFor(type.name, fieldName);
      if (rule) {
        fieldRules[fieldName] = rule;
      }
    }

    if (Object.keys(fieldRules).length > 0) {
      middleware[type.name] = fieldRules;
    }
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
 *
 * @param resolver - The field's resolver.
 * @param rule - The rule guarding it.
 * @returns The guarded resolver.
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
 *
 * @param schema - The schema; its field definitions are mutated.
 * @param permissionFor - Looks up the rule for a field.
 * @returns The same schema.
 */
function guardInPlace(schema: GraphQLSchema, permissionFor: PermissionResolver): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (isObjectType(type) === false || isIntrospectionType(type)) {
      continue;
    }

    for (const field of Object.values(type.getFields())) {
      const rule = permissionFor(type.name, field.name);
      if (!rule) {
        continue;
      }
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
 * Applies a {@link PermissionsMap} to an executable schema via `graphql-middleware`.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The executable schema to guard.
 * @param permissions - The permissions map to enforce.
 * @param options - Optional {@link ApplyPermissionsOptions}.
 * @returns The schema wrapped with the permission middleware — or, with
 * `inPlace`, the same schema, now guarded.
 * @throws {@link PermissionsError} if the map does not line up with the schema.
 *
 * @remarks
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
  if (options?.disabled) {
    return schema;
  }
  if (options?.inPlace) {
    return guardInPlace(schema, permissionFor);
  }
  return applyMiddleware(schema, resolveFieldRules(schema, permissionFor));
}
