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

/** The wildcard key, in either the type or the field position. */
const WILDCARD = '*';

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

  const guardableFields = new Set<string>();
  for (const type of Object.values(typeMap)) {
    if (isObjectType(type) && !isIntrospectionType(type)) {
      for (const fieldName of Object.keys(type.getFields())) guardableFields.add(fieldName);
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
          if (!guardableFields.has(fieldName)) {
            problems.push(
              `Field \`*.${fieldName}\` is in the permissions map but no type in the schema has a field named \`${fieldName}\`.`,
            );
          } else if (!isRule(rule)) {
            problems.push(`Rule for \`*.${fieldName}\` is ${typeof rule}, not a function.`);
          }
        }
        const wildRule = entry[WILDCARD];
        if (wildRule !== undefined && !isRule(wildRule)) {
          problems.push(`Rule for \`*.*\` is ${typeof wildRule}, not a function.`);
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
      }
    }
  }

  return problems;
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

/**
 * Resolves the map into one rule per guarded field.
 *
 * Walks the schema rather than the map, because a wildcard or a `fallbackRule`
 * can guard a field no map entry names. Introspection types are skipped here, so
 * even `fallbackRule: deny` leaves introspection working. Only called after
 * {@link collectProblems} returns clean.
 */
function resolveFieldRules(
  schema: GraphQLSchema,
  permissions: RawPermissions,
  fallbackRule: Rule | undefined,
): IMiddlewareTypeMap {
  const middleware: IMiddlewareTypeMap = {};

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || isIntrospectionType(type)) continue;

    const fieldRules: IMiddlewareFieldMap = {};
    for (const fieldName of Object.keys(type.getFields())) {
      const rule = ruleForField(permissions, type.name, fieldName, fallbackRule);
      if (rule) fieldRules[fieldName] = rule;
    }

    if (Object.keys(fieldRules).length > 0) middleware[type.name] = fieldRules;
  }

  return middleware;
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
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The executable schema to guard.
 * @param permissions - The permissions map to enforce.
 * @param options - Optional {@link ApplyPermissionsOptions}.
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
  options?: ApplyPermissionsOptions,
): GraphQLSchema {
  const raw = permissions as RawPermissions;
  const problems = collectProblems(schema, raw);
  if (problems.length > 0) throw new PermissionsError(problems);
  return applyMiddleware(schema, resolveFieldRules(schema, raw, options?.fallbackRule));
}
