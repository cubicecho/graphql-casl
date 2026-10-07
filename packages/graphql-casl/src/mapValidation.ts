/**
 * The check of a permissions map against the runtime schema.
 *
 * @remarks
 * `PermissionsMap` validates type and field names at compile time, but only for
 * consumers who generate a `Resolvers` type. This module re-checks the map
 * against the `GraphQLSchema` it is about to guard and reports every mismatch
 * at once.
 */

import {
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  isAbstractType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  isUnionType,
} from 'graphql';
import { getOrCreate, scopeInfoOf } from './internal.js';
import { describeKind, PermissionsError } from './permissionsError.js';
import {
  fieldRuleOf,
  isRule,
  possibleTypesOf,
  type RawPermissions,
  type Supertypes,
  supertypesOf,
} from './rulePrecedence.js';
import { type AnyResolvers, type PermissionsMap, type Rule, WILDCARD } from './rules.js';

// biome-ignore lint/suspicious/noExplicitAny: any field of any type is a target
export type AnyField = GraphQLField<any, any>;

/** How many field names a scope problem lists before it says `and N more`. */
const MAX_LISTED_NAMES = 4;

/**
 * `\`A\``, `\`A\` and \`B\``, `\`A\`, \`B\` and \`C\`` — for a problem message.
 *
 * @param names - The names to list.
 * @returns The names in backticks, joined as a phrase.
 */
function listed(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length === 1) {
    return quoted[0];
  }
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The abstract entries giving `typeName` a rule for `key`, by name — one per
 * distinct rule, so the same rule reached through two interfaces counts once.
 *
 * @param permissions - The permissions map.
 * @param abstracts - The abstract entries covering the type.
 * @param key - The field name, or the wildcard.
 * @returns The names of the entries that supply a rule.
 */
function sourcesOf(permissions: RawPermissions, abstracts: readonly string[], key: string): string[] {
  const byRule = new Map<Rule, string>();
  for (const name of abstracts) {
    const rule = fieldRuleOf(permissions[name], key);
    if (rule && byRule.has(rule) === false) {
      byRule.set(rule, name);
    }
  }
  return [...byRule.values()];
}

/**
 * Where two abstract entries would both guard a field of one implementor and
 * the implementor does not choose between them.
 *
 * @param schema - The schema.
 * @param permissions - The permissions map.
 * @param supertypes - Each object type's covering abstract entries.
 * @returns One message per ambiguous field.
 *
 * @remarks
 * Inherited rules never compose, and picking one silently — by map order, say
 * — would make the outcome depend on which interface was listed first. So a
 * field two interfaces both cover is a problem until the object type's own
 * entry settles it: `T.f` settles `f` outright, and `T['*']` settles the
 * type-wide tier (an `I.f` still beats it, as the precedence table says).
 */
function ambiguityProblems(schema: GraphQLSchema, permissions: RawPermissions, supertypes: Supertypes): string[] {
  const problems: string[] = [];
  for (const [typeName, abstracts] of supertypes) {
    if (abstracts.length < 2) {
      continue;
    }
    const type = schema.getType(typeName) as GraphQLObjectType;
    const own = permissions[typeName];
    const ownWild = fieldRuleOf(own, WILDCARD) !== undefined;
    let wildSources: string[] | undefined;
    const unsettled: string[] = [];

    for (const fieldName of Object.keys(type.getFields())) {
      if (fieldRuleOf(own, fieldName)) {
        continue;
      }
      const fieldSources = sourcesOf(permissions, abstracts, fieldName);
      if (fieldSources.length > 1) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` gets a rule from ${listed(fieldSources)}, and ` +
            `\`${typeName}\` does not say which applies — add \`${typeName}: { ${fieldName}: … }\` to choose.`,
        );
        continue;
      }
      if (fieldSources.length === 1 || ownWild) {
        continue;
      }
      wildSources ??= sourcesOf(permissions, abstracts, WILDCARD);
      if (wildSources.length > 1) {
        unsettled.push(fieldName);
      }
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
 * The arguments an argument-scoping rule injects into. Empty if it is not one.
 *
 * @param rule - The map value to inspect.
 * @returns The argument names.
 */
function scopeTargetsOf(rule: object): readonly string[] {
  return scopeInfoOf(rule)?.into ?? [];
}

/**
 * Checks that every field a scoping rule guards actually has the argument the
 * rule injects into.
 *
 * @param rule - The rule to check.
 * @param label - The map key, for the message.
 * @param targets - The fields the rule guards.
 * @returns The problem, or `undefined` when every field has the argument.
 *
 * @remarks
 * This matters more than a normal typo check: a rule runs *downstream* of
 * GraphQL's input coercion, so an injected argument is never validated. Writing
 * a filter into an argument the field does not declare fails silently — the
 * resolver ignores it and the field returns unscoped rows.
 */
function scopeProblem(rule: Rule, label: string, targets: AnyField[]): string | undefined {
  for (const into of scopeTargetsOf(rule)) {
    const missing = targets.filter((field) => field.args.some((arg) => arg.name === into) === false);
    if (missing.length === 0) {
      continue;
    }
    // By name, once: an interface field's targets are that field on every implementor.
    const names = [...new Set(missing.map((field) => `\`${field.name}\``))];
    const shown =
      names.length > MAX_LISTED_NAMES
        ? `${names.slice(0, MAX_LISTED_NAMES).join(', ')} and ${names.length - MAX_LISTED_NAMES} more`
        : names.join(', ');
    return (
      `Rule for \`${label}\` injects a filter into an argument named \`${into}\`, but ` +
      `${shown} ${names.length === 1 ? 'has' : 'have'} no such argument. ` +
      'An injected argument bypasses GraphQL validation, so this would silently leave the field unscoped.'
    );
  }
  return undefined;
}

/**
 * Every way a permissions map can fail to line up with the schema.
 *
 * @param schema - The schema.
 * @param permissions - The permissions map.
 * @param supertypes - Each object type's covering abstract entries.
 * @returns One message per problem; empty when the map is sound.
 *
 * @remarks
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
function collectProblems(schema: GraphQLSchema, permissions: RawPermissions, supertypes: Supertypes): string[] {
  const problems: string[] = [];
  const typeMap = schema.getTypeMap();

  // Field name -> every object-type field with that name, so a `*`-keyed rule
  // can be checked against all the fields it would actually guard.
  const guardableFields = new Map<string, AnyField[]>();
  for (const type of Object.values(typeMap)) {
    if (isObjectType(type) && isIntrospectionType(type) === false) {
      for (const field of Object.values(type.getFields())) {
        getOrCreate(guardableFields, field.name, () => []).push(field);
      }
    }
  }

  for (const [typeName, rawEntry] of Object.entries(permissions)) {
    if (rawEntry == null) {
      continue;
    }
    // `{ Note: rule }` is shorthand for `{ Note: { '*': rule } }`, and is
    // checked as such — a bare scoping rule still has arguments to verify.
    const entry = isRule(rawEntry) ? { [WILDCARD]: rawEntry } : rawEntry;

    // A wildcard type is not looked up in the schema; its field keys are checked
    // against every guardable field instead, so a typo there is still caught.
    if (typeName === WILDCARD) {
      for (const [fieldName, rule] of Object.entries(entry)) {
        if (rule === undefined || fieldName === WILDCARD) {
          continue;
        }
        const targets = guardableFields.get(fieldName);
        if (!targets) {
          problems.push(
            `Field \`*.${fieldName}\` is in the permissions map but no type in the schema has a field named \`${fieldName}\`.`,
          );
        } else if (isRule(rule) === false) {
          problems.push(`Rule for \`*.${fieldName}\` is ${typeof rule}, not a function.`);
        } else {
          const problem = scopeProblem(rule, `*.${fieldName}`, targets);
          if (problem) {
            problems.push(problem);
          }
        }
      }
      const wildRule = entry[WILDCARD];
      if (wildRule !== undefined && isRule(wildRule) === false) {
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
    if (isObjectType(type) === false && isAbstractType(type) === false) {
      problems.push(`\`${typeName}\` is ${describeKind(type)}, not an object type.`);
      continue;
    }

    // An abstract entry guards the fields of the object types it stands for. A
    // union declares no fields of its own, so only `'*'` can be attached to it.
    const declared = isUnionType(type) ? undefined : type.getFields();
    const guarded = isAbstractType(type) ? possibleTypesOf(schema, type) : [type];
    for (const [fieldName, rule] of Object.entries(entry)) {
      if (rule === undefined) {
        continue;
      }
      if (fieldName !== WILDCARD && !declared) {
        problems.push(
          `Field \`${typeName}.${fieldName}\` is in the permissions map but \`${typeName}\` is a union type, ` +
            "which declares no fields — only `'*'` can be attached to a union.",
        );
        continue;
      }
      const isDeclared = fieldName === WILDCARD || fieldName in (declared as Record<string, AnyField>);
      if (isDeclared === false) {
        problems.push(
          isInterfaceType(type)
            ? `Field \`${typeName}.${fieldName}\` is in the permissions map but interface \`${typeName}\` does not declare it.`
            : `Field \`${typeName}.${fieldName}\` is in the permissions map but not in the schema.`,
        );
        continue;
      }
      if (isRule(rule) === false) {
        problems.push(`Rule for \`${typeName}.${fieldName}\` is ${typeof rule}, not a function.`);
        continue;
      }
      const targets =
        fieldName === WILDCARD
          ? guarded.flatMap((object) => Object.values(object.getFields()))
          : guarded.map((object) => object.getFields()[fieldName]);
      const problem = scopeProblem(rule, `${typeName}.${fieldName}`, targets);
      if (problem) {
        problems.push(problem);
      }
    }
  }

  problems.push(...ambiguityProblems(schema, permissions, supertypes));
  return problems;
}

/**
 * Checks a {@link PermissionsMap} against a schema and throws
 * {@link PermissionsError} if anything in it is stale — without building any
 * middleware.
 *
 * @param schema - The schema to check against.
 * @param permissions - The map to check.
 * @throws {@link PermissionsError} Aggregating *every* problem, not just the first.
 *
 * @remarks
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

/**
 * The check behind {@link validatePermissions}, handing back what the resolver reuses.
 *
 * @param schema - The schema.
 * @param permissions - The permissions map.
 * @returns Each object type's covering abstract entries.
 */
export function validated(schema: GraphQLSchema, permissions: RawPermissions): Supertypes {
  const supertypes = supertypesOf(schema, permissions);
  const problems = collectProblems(schema, permissions, supertypes);
  if (problems.length > 0) {
    throw new PermissionsError(problems);
  }
  return supertypes;
}
