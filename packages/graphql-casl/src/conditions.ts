/**
 * Translating CASL's condition objects into another dialect's *leaves*.
 *
 * @remarks
 * {@link FilterAdapter} has two shapes. A {@link SkeletonAdapter} controls only
 * the boolean skeleton and passes each rule's conditions through as written —
 * fine when the conditions are already in the target dialect's terms. A
 * {@link LeafAdapter} controls the leaves too: this module walks the condition
 * object and hands the adapter one flat {@link LeafCondition} at a time, so a
 * dialect that spells equality `{ ownerId: { equals: 'u1' } }` never has to
 * reimplement the walk.
 *
 * The walk follows mongo's semantics, because that is what CASL conditions are:
 * a dotted key is a path, a *nested object* is an equality comparison against
 * that whole object, and an object whose keys all start with `$` is a set of
 * operators applied to one path.
 */

/**
 * A mongo-query comparison operator, as CASL conditions use them.
 *
 * @remarks
 * A bare value (`{ status: 'live' }`) is normalized to `$eq`, so every leaf
 * reaching a {@link LeafAdapter} carries an explicit operator.
 */
export type LeafOperator =
  | '$eq'
  | '$ne'
  | '$in'
  | '$nin'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$exists'
  | '$regex'
  | '$all'
  | '$size'
  | '$elemMatch';

/** Every {@link LeafOperator}, for the walker and for `validateGraphQLRules`. */
export const LEAF_OPERATORS: ReadonlySet<string> = new Set<LeafOperator>([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$exists',
  '$regex',
  '$all',
  '$size',
  '$elemMatch',
]);

/** One comparison, flattened out of a condition object. */
export interface LeafCondition {
  /**
   * The field being compared, already split on `.` — `'author.id'` arrives as
   * `['author', 'id']`. A single-element path is the common case.
   */
  readonly path: readonly string[];
  /** The comparison to apply. A bare value is reported as `$eq`. */
  readonly operator: LeafOperator;
  /**
   * The right-hand side, exactly as written on the rule. For `$elemMatch` this
   * is the nested condition object, un-walked — element matching has no
   * dialect-independent shape.
   */
  readonly value: unknown;
}

/** The combinators every dialect must supply. */
export interface AdapterCore<TFilter> {
  /** All of these must hold. */
  and(filters: TFilter[]): TFilter;
  /** Any of these may hold. */
  or(filters: TFilter[]): TFilter;
  /** The filter that matches every row — no restriction at all. */
  everything(): TFilter;
  /**
   * The filter that matches no row. Optional, and only used by argument
   * scoping's `onDenyAll: 'nothing'`.
   */
  nothing?(): TFilter;
}

/**
 * A dialect that controls the boolean skeleton and passes conditions through
 * verbatim.
 *
 * @remarks
 * The leaves are the rule's conditions as written, so a rule using `$in` still
 * yields `$in` inside a Prisma-shaped tree. Use a {@link LeafAdapter} when the
 * target dialect spells its comparisons differently.
 */
export interface SkeletonAdapter<TFilter> extends AdapterCore<TFilter> {
  /**
   * One rule's conditions as a filter. An `inverted` rule (`cannot`) must come
   * back **negated** — it is a restriction, not a permission.
   */
  rule(conditions: object, inverted: boolean): TFilter;
  leaf?: never;
}

/**
 * A dialect that controls the leaves as well as the skeleton.
 *
 * @remarks
 * Each comparison in a rule's conditions is delivered as one
 * {@link LeafCondition}; the walker handles dotted paths, multi-operator
 * objects, and the `$and`/`$or`/`$nor` groups that rehydrated database rules
 * can contain.
 */
export interface LeafAdapter<TFilter> extends AdapterCore<TFilter> {
  /** One comparison as a filter. */
  leaf(condition: LeafCondition): TFilter;
  /** Negation — used for `cannot` rules and for `$nor`. */
  not(filter: TFilter): TFilter;
  rule?: never;
}

/**
 * Builds the filter dialect `accessibleBy` and argument scoping produce: either
 * a {@link SkeletonAdapter} or a {@link LeafAdapter}.
 *
 * @typeParam TFilter - The filter type this dialect produces.
 */
export type FilterAdapter<TFilter> = SkeletonAdapter<TFilter> | LeafAdapter<TFilter>;

/**
 * Narrows the union. `leaf` is the discriminant.
 *
 * @param adapter - Either adapter kind.
 * @returns `true` for a leaf adapter.
 */
export function isLeafAdapter<TFilter>(adapter: FilterAdapter<TFilter>): adapter is LeafAdapter<TFilter> {
  return 'leaf' in adapter && typeof adapter.leaf === 'function';
}

/**
 * Normalizes either adapter kind into the single `(conditions, inverted)`
 * function the fold uses, walking the conditions when the adapter wants leaves.
 *
 * @param adapter - Either adapter kind.
 * @returns A function from one rule's conditions to a filter.
 */
export function ruleTranslator<TFilter>(
  adapter: FilterAdapter<TFilter>,
): (conditions: object, inverted: boolean) => TFilter {
  if (isLeafAdapter(adapter) === false) {
    return adapter.rule.bind(adapter);
  }
  const leafAdapter = adapter;
  return (conditions, inverted) => {
    const filter = walk(conditions, leafAdapter);
    return inverted ? leafAdapter.not(filter) : filter;
  };
}

/**
 * ANDs the filters of one condition object.
 *
 * @param parts - One filter per key.
 * @param adapter - Builds the filter.
 * @returns The only part, their `and`, or `everything()` for none.
 */
function combine<TFilter>(parts: TFilter[], adapter: LeafAdapter<TFilter>): TFilter {
  if (parts.length === 0) {
    return adapter.everything();
  }
  return parts.length === 1 ? parts[0] : adapter.and(parts);
}

/**
 * One condition object — an implicit AND over its keys.
 *
 * @param conditions - The condition object.
 * @param adapter - Builds the filter.
 * @returns The filter.
 */
function walk<TFilter>(conditions: object, adapter: LeafAdapter<TFilter>): TFilter {
  const parts: TFilter[] = [];

  for (const [key, value] of Object.entries(conditions)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      // Rules rehydrated from a database can carry these; the typed builder
      // cannot emit them, so they are rare but must not be dropped.
      const group = asGroup(key, value).map((member) => walk(member, adapter));
      if (key === '$and') {
        parts.push(adapter.and(group));
      } else if (key === '$or') {
        parts.push(adapter.or(group));
      } else {
        parts.push(adapter.not(adapter.or(group)));
      }
      continue;
    }
    if (key.startsWith('$')) {
      throw new Error(
        `graphql-casl: unsupported condition operator \`${key}\`. A leaf adapter cannot ` +
          'translate it, and dropping it would widen access. Use a skeleton adapter (one with ' +
          '`rule`) to pass conditions through untranslated.',
      );
    }
    parts.push(field(key.split('.'), value, adapter));
  }

  return combine(parts, adapter);
}

/**
 * Reads the operand list of `$and`, `$or` or `$nor`.
 *
 * @param key - The group operator, for the message.
 * @param value - Its right-hand side.
 * @returns The conditions. Throws when `value` is not an array.
 */
function asGroup(key: string, value: unknown): object[] {
  if (Array.isArray(value) === false) {
    throw new Error(`graphql-casl: \`${key}\` in a condition must be an array of conditions.`);
  }
  return value;
}

/**
 * One `field: <rhs>` entry — either a set of operators, or a bare equality.
 *
 * @param path - The field path, split on dots.
 * @param value - The right-hand side.
 * @param adapter - Builds the filter.
 * @returns The filter.
 */
function field<TFilter>(path: string[], value: unknown, adapter: LeafAdapter<TFilter>): TFilter {
  const operators = operatorEntries(value);
  if (!operators) {
    return adapter.leaf({ path, operator: '$eq', value });
  }

  const parts = operators.map(([operator, operand]) => {
    if (LEAF_OPERATORS.has(operator) === false) {
      throw new Error(
        `graphql-casl: unsupported condition operator \`${operator}\` on \`${path.join('.')}\`. ` +
          'A leaf adapter cannot translate it, and dropping it would widen access. Use a ' +
          'skeleton adapter (one with `rule`) to pass conditions through untranslated.',
      );
    }
    return adapter.leaf({ path, operator: operator as LeafOperator, value: operand });
  });
  return combine(parts, adapter);
}

/**
 * The operator entries of a right-hand side, or `undefined` when it is a plain
 * value to compare with `$eq`.
 *
 * @param value - The right-hand side.
 * @returns The entries. Throws when operators and plain keys are mixed.
 *
 * @remarks
 * A *nested* object is a value, not a path: mongo reads `{ author: { id: 5 } }`
 * as "author equals this exact document". Only an object whose keys all start
 * with `$` is a set of operators. A mixture is neither, and mongo rejects it —
 * so this does too, rather than guessing.
 */
function operatorEntries(value: unknown): [string, unknown][] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  // A `Date` or `RegExp` has no own enumerable keys, so it falls out here too.
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }
  const dollars = entries.filter(([key]) => key.startsWith('$'));
  if (dollars.length === 0) {
    return undefined;
  }
  if (dollars.length !== entries.length) {
    const plain = entries.find(([key]) => key.startsWith('$') === false);
    throw new Error(
      `graphql-casl: a condition cannot mix operators with plain keys (found \`${plain?.[0]}\` ` +
        `alongside \`${dollars[0]?.[0]}\`).`,
    );
  }
  return entries;
}
