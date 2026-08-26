/**
 * graphql-casl — generic CASL permissions middleware for GraphQL resolvers.
 *
 * Everything here is schema-agnostic: pass your own generated `Resolvers` /
 * `ResolversTypes` to the type helpers and you get a fully-derived subject
 * union without any manual type listing. The runtime helpers (`createCan`,
 * `createTyped`, `createSubjects`, `accept`, `deny`) are bound to your app's
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
 * - `subjects` — `createSubjects` / `createTyped`
 * - `createCan` — the factory tying abilities to rules
 *
 * @packageDocumentation
 */

export type { AbilityLike, Action } from './ability.js';
export { Actions } from './ability.js';
export { applyPermissions, PermissionsError } from './applyPermissions.js';
export type {
  BuildSubject,
  CreateCanOptions,
  RequireCan,
  RequireCanBare,
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
export type { PermissionsMap, Rule } from './rules.js';
export { accept, deny } from './rules.js';
export type { ArgsOf, ContextOf, ParentOf, SubjectMap, SubjectName } from './schemaTypes.js';
export { createSubjects, createTyped } from './subjects.js';
