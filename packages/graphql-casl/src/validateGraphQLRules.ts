/**
 * Validating stored ability rules against the schema.
 *
 * `createGraphQLAbility` types `can`/`cannot` against the subject map, but rules
 * that live in a database are edited outside the type system and rehydrated
 * with `buildGraphQLAbility`, which accepts anything. A stale rule fails
 * *silently*: a condition on a field that has since been renamed never
 * matches, so the rule grants nothing; a subject that no longer exists is never
 * asked about; an operator CASL does not know throws on the first `can()` that
 * reaches it, mid-request. This module re-checks the rules against the runtime
 * `GraphQLSchema`, the way `validatePermissions` re-checks the map.
 */

import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  isUnionType,
} from 'graphql';
import { Actions } from './ability.js';
import { describeKind, PermissionsError } from './applyPermissions.js';

/** Options for {@link validateGraphQLRules}. */
export interface ValidateGraphQLRulesOptions {
  /**
   * Whether a condition's field names are checked against the subject type.
   *
   * `'schema'` (the default) requires every path in `conditions` to name a
   * field of the subject — and, for a dotted path, a field of each type along
   * the way. `'none'` checks only the shape of the conditions (the operators,
   * `$and`/`$or`/`$nor` groups) and lets any field name through.
   *
   * Use `'none'` when subjects are database models rather than GraphQL types —
   * codegen `mappers`, say — and a rule legitimately conditions on a column the
   * schema does not expose. Subject and `fields` names are always checked;
   * those *are* schema names.
   */
  readonly conditionFields?: 'schema' | 'none';
}

/** The parts of a raw CASL rule this walk looks at, typing erased. */
interface RawRule {
  readonly action?: unknown;
  readonly subject?: unknown;
  readonly fields?: unknown;
  readonly conditions?: unknown;
  readonly inverted?: unknown;
  readonly reason?: unknown;
}

/** A type whose fields a condition path can descend into. */
type Composite = GraphQLObjectType | GraphQLInterfaceType;

/** The operators CASL's `mongoQueryMatcher` accepts on a single field. */
const FIELD_OPERATORS: ReadonlySet<string> = new Set([
  '$eq',
  '$ne',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$in',
  '$nin',
  '$all',
  '$size',
  '$regex',
  '$options',
  '$elemMatch',
  '$exists',
  '$mod',
  '$not',
]);

/** The operators it accepts at the top level of a condition object. */
const GROUP_OPERATORS: ReadonlySet<string> = new Set(['$and', '$or', '$nor']);

const ACTION_NAMES = Object.values(Actions);

/**
 * Checks stored {@link GraphQLRule}s against a schema and throws
 * {@link PermissionsError} if any of them could not do what it says.
 *
 * `buildGraphQLAbility` accepts whatever it is given, and CASL evaluates rules
 * lazily, so a stale rule is not an error — it is a rule that silently never
 * grants. That is the wrong failure mode for rows edited outside the type
 * system, which is what DB-backed rules are. Call this on the rows before (or
 * after) rehydrating them, ideally at startup and in a test.
 *
 * Checked, per rule:
 * - the shape: an object with a string (or string array) `action` and `subject`,
 *   a boolean `inverted` and a string `reason` if present;
 * - `action` is one of {@link Actions};
 * - `subject` is `'all'` or an object type in the schema — not a root operation
 *   type, an interface or a union (subjects are detected by `__typename`, which
 *   is always a concrete type, so a rule on an interface never matches);
 * - each of `fields` is a field of the subject (`*` patterns are let through);
 * - `conditions` uses only operators CASL's matcher knows, does not mix
 *   operators with plain keys, and — by default — names only fields of the
 *   subject, following dotted paths through object-typed fields. See
 *   {@link ValidateGraphQLRulesOptions.conditionFields} to relax that last check
 *   when subjects are database models rather than GraphQL types.
 *
 * Every problem is reported at once, labelled by the rule's index in the array.
 * Condition *values* are not checked against field types; CASL compares them
 * structurally at check time.
 *
 * @param schema - The schema the rules are checked against.
 * @param rules - The stored rules, as loaded — typing is deliberately loose.
 * @param options - See {@link ValidateGraphQLRulesOptions}.
 * @throws {PermissionsError} Aggregating *every* problem, not just the first.
 * @example
 * ```ts
 * const rules: GraphQLRule<AppSubjectMap>[] = await db.loadPermissionRules();
 * validateGraphQLRules(schema, rules); // throws PermissionsError on drift
 * const ability = buildGraphQLAbility<AppSubjectMap>(rules);
 * ```
 */
export function validateGraphQLRules(
  schema: GraphQLSchema,
  rules: readonly unknown[],
  options?: ValidateGraphQLRulesOptions,
): void {
  const checkPaths = (options?.conditionFields ?? 'schema') === 'schema';
  const problems: string[] = [];
  for (const [index, rule] of rules.entries()) {
    collectRuleProblems(schema, rule, index, checkPaths, problems);
  }
  if (problems.length > 0) {
    throw new PermissionsError(problems, 'the ability rules do not match the schema');
  }
}

function collectRuleProblems(
  schema: GraphQLSchema,
  raw: unknown,
  index: number,
  checkPaths: boolean,
  problems: string[],
): void {
  if (!isPlainObject(raw)) {
    problems.push(`Rule ${index} is ${describeValue(raw)}, not an object.`);
    return;
  }
  const rule = raw as RawRule;
  const label = labelOf(rule, index);

  for (const action of stringList(rule.action, 'action', label, problems) ?? []) {
    if (!ACTION_NAMES.includes(action as (typeof ACTION_NAMES)[number])) {
      problems.push(
        `${label}: action \`${action}\` is not one of ${ACTION_NAMES.map((name) => `\`${name}\``).join(', ')}.`,
      );
    }
  }

  // The object types the rule is about; `'all'` contributes nothing to check
  // fields against, and a subject that failed is already reported.
  const subjects: Composite[] = [];
  for (const subject of stringList(rule.subject, 'subject', label, problems) ?? []) {
    if (subject === 'all') continue;
    const type = subjectType(schema, subject, label, problems);
    if (type) subjects.push(type);
  }

  if (rule.fields !== undefined) {
    for (const field of stringList(rule.fields, 'fields', label, problems) ?? []) {
      // `createMongoAbility` matches fields by pattern, so `address.*` is legal.
      const [head = ''] = field.split('.');
      if (head.includes('*')) continue;
      for (const type of subjects) {
        if (!(head in type.getFields())) {
          problems.push(`${label}: field \`${field}\` is not a field of \`${type.name}\`.`);
        }
      }
    }
  }

  if (rule.conditions !== undefined) {
    if (!isPlainObject(rule.conditions)) {
      problems.push(
        `${label}: \`conditions\` is ${describeValue(rule.conditions)}, not an object.`,
      );
    } else {
      walkConditions(rule.conditions, checkPaths ? subjects : undefined, label, problems);
    }
  }

  if (rule.inverted !== undefined && typeof rule.inverted !== 'boolean') {
    problems.push(
      `${label}: \`inverted\` is ${describeValue(rule.inverted)}, not a boolean. ` +
        'CASL reads any truthy value as a denial.',
    );
  }
  if (rule.reason !== undefined && typeof rule.reason !== 'string') {
    problems.push(`${label}: \`reason\` is ${describeValue(rule.reason)}, not a string.`);
  }
}

/**
 * Resolves a subject name to the object type it names, reporting why it cannot
 * be a subject otherwise. Mirrors what `SubjectName` excludes at the type level.
 */
function subjectType(
  schema: GraphQLSchema,
  name: string,
  label: string,
  problems: string[],
): Composite | undefined {
  const type: GraphQLNamedType | undefined = schema.getType(name);
  if (!type) {
    problems.push(`${label}: subject \`${name}\` is not a type in the schema.`);
    return undefined;
  }
  if (isIntrospectionType(type)) {
    problems.push(
      `${label}: subject \`${name}\` is an introspection type and cannot be a subject.`,
    );
    return undefined;
  }
  if (
    type === schema.getQueryType() ||
    type === schema.getMutationType() ||
    type === schema.getSubscriptionType()
  ) {
    problems.push(`${label}: subject \`${name}\` is a root operation type, not a subject.`);
    return undefined;
  }
  if (isObjectType(type)) return type;
  const hint =
    isInterfaceType(type) || isUnionType(type)
      ? ' Subjects are detected by `__typename`, which is always a concrete object type, so this rule would never match a tagged object — attach it to each implementing type instead.'
      : '';
  problems.push(
    `${label}: subject \`${name}\` is ${describeKind(type)}, not an object type.${hint}`,
  );
  return undefined;
}

/**
 * One condition object — an implicit AND over its keys. `types` is what a
 * path is checked against, or `undefined` to check only shape and operators.
 */
function walkConditions(
  conditions: object,
  types: readonly Composite[] | undefined,
  label: string,
  problems: string[],
): void {
  for (const [key, value] of Object.entries(conditions)) {
    if (GROUP_OPERATORS.has(key)) {
      if (!Array.isArray(value)) {
        problems.push(
          `${label}: \`${key}\` must be an array of conditions, not ${describeValue(value)}.`,
        );
        continue;
      }
      value.forEach((member, i) => {
        if (isPlainObject(member)) walkConditions(member, types, label, problems);
        else {
          problems.push(
            `${label}: \`${key}[${i}]\` is ${describeValue(member)}, not a condition object.`,
          );
        }
      });
      continue;
    }
    if (key.startsWith('$')) {
      problems.push(
        `${label}: \`${key}\` is not an operator CASL supports at the top level of a condition (only \`$and\`, \`$or\` and \`$nor\` are).`,
      );
      continue;
    }
    const leaves = types ? resolvePath(key, types, label, problems) : undefined;
    checkOperators(key, value, leaves, label, problems);
  }
}

/**
 * Follows a dotted path from each subject type, reporting the first segment
 * that is not a field. Returns the named types the path ends on, for
 * `$elemMatch` to descend into — or `undefined` when nothing further can be
 * checked.
 *
 * The walk stops, and accepts the rest of the path, at a type it cannot look
 * inside: a scalar (a `JSON` column has whatever keys it has), an enum, or a
 * union.
 */
function resolvePath(
  path: string,
  types: readonly Composite[],
  label: string,
  problems: string[],
): readonly Composite[] | undefined {
  const segments = path.split('.');
  const leaves: Composite[] = [];
  let ok = true;

  for (const type of types) {
    let current: GraphQLNamedType = type;
    for (const [i, segment] of segments.entries()) {
      if (!isObjectType(current) && !isInterfaceType(current)) break;
      const field: GraphQLField<unknown, unknown> | undefined = current.getFields()[segment];
      if (!field) {
        ok = false;
        problems.push(
          i === 0
            ? `${label}: condition field \`${segment}\` is not a field of \`${current.name}\`.`
            : `${label}: condition path \`${path}\`: \`${current.name}\` has no field \`${segment}\`.`,
        );
        break;
      }
      current = getNamedType(field.type);
    }
    if (ok && (isObjectType(current) || isInterfaceType(current))) leaves.push(current);
  }

  return ok && leaves.length > 0 ? leaves : undefined;
}

/**
 * One `field: <rhs>` entry. A bare value, an array, or a nested object without
 * `$` keys is an equality comparison and needs no checking; an object of `$`
 * keys is a set of operators, each of which must be one CASL knows.
 */
function checkOperators(
  path: string,
  value: unknown,
  leaves: readonly Composite[] | undefined,
  label: string,
  problems: string[],
): void {
  if (!isPlainObject(value)) return;
  const entries = Object.entries(value);
  const dollars = entries.filter(([key]) => key.startsWith('$'));
  if (dollars.length === 0) return;
  if (dollars.length !== entries.length) {
    const plain = entries.find(([key]) => !key.startsWith('$'))?.[0];
    problems.push(
      `${label}: condition \`${path}\` mixes operators with plain keys (\`${plain}\` alongside \`${dollars[0]?.[0]}\`).`,
    );
    return;
  }
  for (const [operator, operand] of entries) {
    if (!FIELD_OPERATORS.has(operator)) {
      problems.push(
        `${label}: \`${operator}\` on \`${path}\` is not a condition operator CASL supports.`,
      );
    } else if (operator === '$not') {
      checkOperators(path, operand, leaves, label, problems);
    } else if (operator === '$elemMatch') {
      if (isPlainObject(operand)) walkConditions(operand, leaves, label, problems);
      else {
        problems.push(
          `${label}: \`$elemMatch\` on \`${path}\` must be a condition object, not ${describeValue(operand)}.`,
        );
      }
    }
  }
}

/**
 * A string or array-of-strings rule property as a list, or `undefined` after
 * reporting that it is neither. `action`, `subject` and `fields` all take this
 * shape in CASL.
 */
function stringList(
  value: unknown,
  property: string,
  label: string,
  problems: string[],
): readonly string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    if (value.length > 0) return value;
    problems.push(`${label}: \`${property}\` is an empty array.`);
    return undefined;
  }
  const what = Array.isArray(value) ? 'an array with a non-string item' : describeValue(value);
  problems.push(
    value === undefined
      ? `${label} has no \`${property}\`.`
      : `${label}: \`${property}\` is ${what}, not a string or array of strings.`,
  );
  return undefined;
}

/** `Rule 2 (\`update\` on \`Note\`)`, or just `Rule 2` when the rule cannot say. */
function labelOf(rule: RawRule, index: number): string {
  const actions = quietStringList(rule.action);
  const subjects = quietStringList(rule.subject);
  if (!actions || !subjects) return `Rule ${index}`;
  const quote = (names: readonly string[]) => names.map((name) => `\`${name}\``).join(', ');
  return `Rule ${index} (${quote(actions)} on ${quote(subjects)})`;
}

function quietStringList(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names a value for an error message: `null`, `an array`, `the string "x"`, `a number`. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
