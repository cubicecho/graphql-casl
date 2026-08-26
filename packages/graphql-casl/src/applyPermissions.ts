/**
 * The schema walk behind {@link applyPermissions}.
 *
 * `PermissionsMap` validates type and field names at compile time, but only for
 * consumers who generate a `Resolvers` type. This module re-checks the map
 * against the runtime `GraphQLSchema` and resolves it into the concrete
 * per-field middleware map handed to `graphql-middleware`.
 */

import {
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import {
  applyMiddleware,
  type IMiddlewareFieldMap,
  type IMiddlewareTypeMap,
} from 'graphql-middleware';
import type { PermissionsMap, Rule } from './rules.js';

/**
 * Thrown by {@link applyPermissions} when a permissions map does not line up with
 * the schema. Reports *every* problem at once, in {@link problems}, so a mismatched
 * map is fixed in one pass rather than one error per run.
 */
export class PermissionsError extends Error {
  /** Every problem found, one message per offending type or field. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `graphql-casl: the permissions map does not match the schema.\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
    this.name = 'PermissionsError';
    this.problems = problems;
  }
}

/** The permissions map with its compile-time typing erased, for the walk. */
type RawPermissions = Record<string, Rule | Record<string, Rule | undefined> | undefined>;

function isRule(value: unknown): value is Rule {
  return typeof value === 'function';
}

/** Names a type's kind for an error message. */
function describeKind(type: GraphQLNamedType): string {
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

  for (const [typeName, entry] of Object.entries(permissions)) {
    if (entry == null) continue;

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
      if (!(fieldName in fields)) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` is in the permissions map but not in the schema.`,
        );
        continue;
      }
      if (!isRule(rule)) {
        problems.push(`Rule for \`${typeName}.${fieldName}\` is ${typeof rule}, not a function.`);
      }
    }
  }

  return problems;
}

/**
 * Resolves the map into one rule per guarded field.
 *
 * A type-level rule is expanded across the type's fields here rather than left to
 * `graphql-middleware` — the expansion is identical, but doing it in the walk is
 * what lets later features (schema-wide fallbacks, wildcards) decide precedence
 * per field. Only called after {@link collectProblems} returns clean, so every
 * lookup here is known to resolve.
 */
function resolveFieldRules(schema: GraphQLSchema, permissions: RawPermissions): IMiddlewareTypeMap {
  const middleware: IMiddlewareTypeMap = {};
  const typeMap = schema.getTypeMap();

  for (const [typeName, entry] of Object.entries(permissions)) {
    if (entry == null) continue;

    const type = typeMap[typeName] as GraphQLObjectType;
    const fieldRules: IMiddlewareFieldMap = {};

    if (isRule(entry)) {
      for (const fieldName of Object.keys(type.getFields())) {
        fieldRules[fieldName] = entry;
      }
    } else {
      for (const [fieldName, rule] of Object.entries(entry)) {
        if (isRule(rule)) fieldRules[fieldName] = rule;
      }
    }

    if (Object.keys(fieldRules).length > 0) middleware[typeName] = fieldRules;
  }

  return middleware;
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
 * Types not named in the map are left unguarded; the map is a whitelist of what to
 * guard, not a schema-coverage guarantee.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The executable schema to guard.
 * @param permissions - The permissions map to enforce.
 * @returns The schema wrapped with the permission middleware.
 * @throws {@link PermissionsError} if the map does not line up with the schema.
 * @example
 * ```ts
 * const schema = applyPermissions<Resolvers>(makeExecutableSchema({ typeDefs, resolvers }), permissions);
 * ```
 */
export function applyPermissions<TResolvers>(
  schema: GraphQLSchema,
  permissions: PermissionsMap<TResolvers>,
): GraphQLSchema {
  const raw = permissions as RawPermissions;
  const problems = collectProblems(schema, raw);
  if (problems.length > 0) throw new PermissionsError(problems);
  return applyMiddleware(schema, resolveFieldRules(schema, raw));
}
