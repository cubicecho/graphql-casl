/**
 * graphql-casl — generic CASL permissions middleware for GraphQL resolvers.
 *
 * Everything here is schema-agnostic: pass your own generated `Resolvers` /
 * `ResolversTypes` to the type helpers and you get a fully-derived subject
 * union without any manual type listing. The runtime helpers (`createCan`,
 * `createTyped`, `subjectsOf`, `accept`, `deny`) are bound to your app's
 * context shape and ability builder at call time.
 *
 * Abilities are statically typed: derive a {@link GraphQLAbility} from your
 * `SubjectMap` and build it with {@link createGraphQLAbility} (or rehydrate
 * stored rules with {@link buildGraphQLAbility}). Conditions use CASL's standard
 * mongo-query operators (`$eq`/`$in`/`$gt`/…); subjects are detected via `__typename`.
 *
 * Modules:
 * - `schemaTypes` — type helpers derived from generated `Resolvers`/`ResolversTypes`
 * - `rules` — the `graphql-middleware` rule layer (`Rule`, `PermissionsMap`, `accept`, `deny`)
 * - `applyPermissions` — validates a map against the schema and applies it
 * - `ability` — CASL `Action` / `Actions` / `AbilityLike`
 * - `graphqlAbility` — the schema-typed `GraphQLAbility` / `createGraphQLAbility` / `buildGraphQLAbility`
 * - `subjects` — `subjectsOf` / `createTyped` (and deprecated `createSubjects`)
 * - `createCan` — the factory tying abilities to rules
 *
 * @packageDocumentation
 */

export type { AbilityLike, Action } from './ability.js';
export { Actions } from './ability.js';
export type { AccessibleFilter } from './accessibleBy.js';
export { accessibleBy } from './accessibleBy.js';
export type {
  ApplyPermissionsOptions,
  FallbackError,
  PermissionResolver,
} from './applyPermissions.js';
export {
  applyPermissions,
  PermissionsError,
  resolvePermissions,
  validatePermissions,
} from './applyPermissions.js';
export { and, chain, not, or, race, wrap } from './combinators.js';
export type {
  AdapterCore,
  FilterAdapter,
  LeafAdapter,
  LeafCondition,
  LeafOperator,
  SkeletonAdapter,
} from './conditions.js';
export type {
  BuildSubject,
  CreateCanOptions,
  RequireCan,
  RequireCanBare,
  RequireCanFields,
  RequireCanOnResult,
  UnconditionedSubjectMode,
} from './createCan.js';
export { createCan } from './createCan.js';
export type {
  GraphQLAbilities,
  GraphQLAbility,
  GraphQLAbilityOptions,
  GraphQLRule,
} from './graphqlAbility.js';
export { buildGraphQLAbility, createGraphQLAbility } from './graphqlAbility.js';
export type { Check, CheckableRule, PermissionsMap, Rule, RuleResult, Wildcard } from './rules.js';
export { accept, deny, isCheckableRule, rule } from './rules.js';
export type { ArgsOf, ContextOf, ParentOf, SubjectMap, SubjectName } from './schemaTypes.js';
export { createSubjects, createTyped, type Subjects, subjectsOf } from './subjects.js';
