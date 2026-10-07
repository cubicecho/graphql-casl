/**
 * The schema-typed ability.
 *
 * @remarks
 * {@link GraphQLAbility} is a CASL `MongoAbility` whose subjects are detected
 * by `__typename` and whose `can`/`cannot` conditions are statically typed
 * against each subject's fields. {@link createGraphQLAbility} returns a builder
 * bound to your subject map; {@link buildGraphQLAbility} reconstructs an
 * ability from stored {@link GraphQLRule}s.
 *
 * Subjects are discriminated by `__typename` — CASL's `TaggedInterface` natively
 * accepts a required `__typename` tag, so no `__caslSubjectType__` is needed.
 * Conditions use CASL's standard mongo-query operators (`$eq`, `$in`, `$gt`, …),
 * matched by CASL's own `mongoQueryMatcher`. Rules are plain JSON
 * ({@link GraphQLRule}), so they can be persisted in a database and
 * loaded/cached at startup.
 */

import {
  AbilityBuilder,
  type AbilityOptionsOf,
  createMongoAbility,
  type MongoAbility,
  type RawRuleOf,
} from '@casl/ability';
import type { Action } from './ability.js';

/** Requires a literal `__typename` so CASL classifies the subject (type-level). */
type Tagged<K extends string, T> = T & { __typename: K };

/**
 * The CASL ability-tuple union derived from a {@link SubjectMap}: each subject
 * name `K` is paired with both its `__typename`-tagged object type and the bare
 * string literal, plus a `[Action, 'all']` member for `manage`/`all`-style rules.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type GraphQLAbilities<TSubjectMap extends Record<string, object>> =
  | {
      [K in keyof TSubjectMap & string]: [Action, Tagged<K, TSubjectMap[K]> | K];
    }[keyof TSubjectMap & string]
  | [Action, 'all'];

/**
 * A CASL {@link https://casl.js.org | MongoAbility} whose conditions are
 * statically typed against your schema. `can('update', 'Note', { userId })` only
 * accepts fields that exist on `Note`, and conditions use the standard CASL
 * mongo-query operators (`$eq`/`$ne`/`$in`/`$nin`/`$gt`/`$gte`/`$lt`/`$lte`/…).
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type GraphQLAbility<TSubjectMap extends Record<string, object>> = MongoAbility<
  GraphQLAbilities<TSubjectMap>
>;

/**
 * A single serializable permission rule for a {@link GraphQLAbility}. This is a
 * plain JSON object (`action`, `subject`, optional `conditions`, `inverted`,
 * `fields`, `reason`), so a set of rules can be persisted in a database and
 * rehydrated with {@link buildGraphQLAbility} at app start.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type GraphQLRule<TSubjectMap extends Record<string, object>> = RawRuleOf<
  GraphQLAbility<TSubjectMap>
>;

/** Options accepted by {@link buildGraphQLAbility} / the builder's `build()`. */
export type GraphQLAbilityOptions<TSubjectMap extends Record<string, object>> = Partial<
  AbilityOptionsOf<GraphQLAbility<TSubjectMap>>
>;

/**
 * Reads a subject's `__typename`. CASL only calls this for object subjects (bare
 * string subject names and `undefined` are handled before this runs), so a
 * missing or non-string `__typename` means an untagged object reached the check —
 * fail loud rather than silently denying, since CASL can't classify it.
 */
function detectSubjectType(subject: { __typename?: unknown }): string {
  const typename = subject.__typename;
  if (typeof typename !== 'string') {
    throw new Error(
      'graphql-casl: subject is missing a string `__typename`. Tag it with `typed()` ' +
        '(from `createTyped`) before checking, or pass the bare subject-name string.',
    );
  }
  return typename;
}

function gqlAbilityOptions<TSubjectMap extends Record<string, object>>(
  overrides?: GraphQLAbilityOptions<TSubjectMap>,
): AbilityOptionsOf<GraphQLAbility<TSubjectMap>> {
  // Drop present-but-`undefined` overrides so they can't silently clobber the
  // default `__typename` detection (e.g. `build({ detectSubjectType: undefined })`).
  const defined = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  );
  return {
    detectSubjectType,
    ...defined,
    // Cast bridges our broad `__typename: string` reader to CASL's literal
    // `ExtractSubjectType` return; detection is validated by tests instead.
  } as unknown as AbilityOptionsOf<GraphQLAbility<TSubjectMap>>;
}

/**
 * Reconstructs a {@link GraphQLAbility} from previously-stored {@link GraphQLRule}s
 * — the path for loading rules persisted in a database (and caching them) at app
 * start. Applies `__typename` detection (the mongo conditions matcher is built in).
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @param rules - The stored rules.
 * @param options - Extra CASL ability options to override or extend the defaults.
 *
 * @example
 * ```ts
 * const rules: GraphQLRule<AppSubjectMap>[] = await db.loadPermissionRules();
 * const ability = buildGraphQLAbility<AppSubjectMap>(rules);
 * ```
 */
export function buildGraphQLAbility<TSubjectMap extends Record<string, object>>(
  rules: GraphQLRule<TSubjectMap>[],
  options?: GraphQLAbilityOptions<TSubjectMap>,
): GraphQLAbility<TSubjectMap> {
  return createMongoAbility<GraphQLAbility<TSubjectMap>>(rules, gqlAbilityOptions(options));
}

/**
 * Creates a CASL `AbilityBuilder` typed against your {@link SubjectMap}, with
 * `__typename` detection applied by `build()` (the mongo conditions matcher is
 * built in).
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @returns A typed `AbilityBuilder` whose `build()` wires the GraphQL defaults.
 *
 * @remarks
 * The returned builder's `can` / `cannot` type their conditions per subject (see
 * {@link GraphQLAbility}). Read `builder.rules` (or `ability.rules`) to persist
 * the rules and later rehydrate them with {@link buildGraphQLAbility}.
 *
 * @example
 * ```ts
 * type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;
 *
 * function defineAbilitiesFor(userId: string | undefined) {
 *   const { can, cannot, build } = createGraphQLAbility<AppSubjectMap>();
 *   if (!userId) return build(); // no rules ⇒ everything denied
 *   can('read', 'Note');
 *   can('update', 'Note', { userId });                  // equality
 *   can('read', 'Note', { status: { $in: ['live'] } }); // operators
 *   return build();
 * }
 * ```
 */
export function createGraphQLAbility<TSubjectMap extends Record<string, object>>() {
  const builder = new AbilityBuilder<GraphQLAbility<TSubjectMap>>(createMongoAbility);
  const build = builder.build;
  builder.build = (options?: GraphQLAbilityOptions<TSubjectMap>) =>
    build(gqlAbilityOptions(options));
  return builder;
}
