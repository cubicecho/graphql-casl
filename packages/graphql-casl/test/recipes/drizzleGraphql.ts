/**
 * A `FilterAdapter` for drizzle-graphql's generated `where` inputs.
 *
 * This is a **recipe**, not part of the published API: copy it into your own
 * project. It lives under `test/` so it is type-checked and covered by tests
 * against the shape drizzle-graphql actually generates.
 *
 * The dialect is unusually tight, and the tightness is the whole reason this
 * file is longer than the Prisma-shaped example in the README:
 *
 * - A `<Table>Filters` input has **no `AND` and no `NOT`**. Column entries are
 *   implicitly ANDed.
 * - It has exactly one `OR: [<Table>FiltersOr!]`, and `<Table>FiltersOr` has
 *   only column fields — so **`OR` does not nest**.
 * - `extractFilters` throws `Cannot specify both fields and 'OR' in table
 *   filters!` if a filter carries column entries *and* an `OR`.
 *
 * In other words the input type accepts disjunctive normal form and nothing
 * else, with no negation above the leaves. So this adapter keeps every filter
 * in DNF as it builds: `and` distributes over `OR`, `or` flattens, and `not`
 * pushes negation down to the leaves via De Morgan. Anything the dialect cannot
 * express throws rather than being dropped — a dropped clause widens access.
 *
 * Because `and` distributes, `scopeArgs` needs no custom `merge`: its default
 * `adapter.and([clientFilter, scope])` produces a legal filter even when the
 * client sent an `OR`.
 */

import type { LeafAdapter, LeafOperator } from '../../src/index.js';

/** One AND-set of column conditions, e.g. `{ userId: { eq: 'alice' } }`. */
type ColumnSet = Record<string, Record<string, unknown>>;

/** A `<Table>Filters` value: an AND-set, or a single non-nesting `OR` of them. */
export type DrizzleFilters = ColumnSet | { OR: ColumnSet[] };

const OPERATORS: Partial<Record<LeafOperator, string>> = {
  $eq: 'eq',
  $ne: 'ne',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $in: 'inArray',
  $nin: 'notInArray',
};

/** Every drizzle-graphql column operator that has an opposite. */
const NEGATED: Record<string, string> = {
  eq: 'ne',
  ne: 'eq',
  lt: 'gte',
  gte: 'lt',
  gt: 'lte',
  lte: 'gt',
  inArray: 'notInArray',
  notInArray: 'inArray',
  like: 'notLike',
  notLike: 'like',
  ilike: 'notIlike',
  notIlike: 'ilike',
  isNull: 'isNotNull',
  isNotNull: 'isNull',
};

const unsupported = (what: string) =>
  new Error(`drizzle-graphql filters cannot express ${what}; rewrite the ability rule`);

/** The OR-branches of a filter — one branch for a plain AND-set. */
const branchesOf = (filter: DrizzleFilters): ColumnSet[] =>
  'OR' in filter && Array.isArray(filter.OR) ? filter.OR : [filter as ColumnSet];

/** Rebuild a filter from its branches, keeping `OR` off a single branch. */
const collapse = (sets: ColumnSet[]): DrizzleFilters => {
  // An empty branch matches every row, so a disjunction containing one does too.
  if (sets.some((set) => Object.keys(set).length === 0)) return {};
  if (sets.length === 0) throw unsupported('a filter matching no row (use `nothing()`)');
  return sets.length === 1 ? (sets[0] as ColumnSet) : { OR: sets };
};

/** AND two branches by merging their column entries. */
const mergeSets = (left: ColumnSet, right: ColumnSet): ColumnSet => {
  const out: ColumnSet = { ...left };
  for (const [column, operators] of Object.entries(right)) {
    const existing = out[column];
    if (!existing) {
      out[column] = { ...operators };
      continue;
    }
    for (const operator of Object.keys(operators)) {
      if (operator in existing) {
        throw unsupported(`two \`${operator}\` conditions on \`${column}\` at once`);
      }
    }
    out[column] = { ...existing, ...operators };
  }
  return out;
};

export interface DrizzleAdapterOptions {
  /**
   * Any non-nullable column of the table. `nothing()` emits a contradiction on
   * it (`isNull` and `isNotNull` together), because the dialect has no literal
   * "match no row" — and an empty `OR` is *dropped*, which would match every
   * row instead. Only needed for `scopeArgs`' `onDenyAll: 'nothing'`.
   */
  nonNullColumn: string;
}

/** Build a drizzle-graphql filter adapter for one table. */
export function drizzleFilters(options: DrizzleAdapterOptions): LeafAdapter<DrizzleFilters> {
  const nothing = (): DrizzleFilters => ({
    [options.nonNullColumn]: { isNull: true, isNotNull: true },
  });

  const and = (filters: DrizzleFilters[]): DrizzleFilters => {
    if (filters.length === 0) return {};
    return filters.reduce((left, right) =>
      collapse(branchesOf(left).flatMap((a) => branchesOf(right).map((b) => mergeSets(a, b)))),
    );
  };

  /** De Morgan: the negation of one AND-set is a disjunction of flipped leaves. */
  const negateSet = (set: ColumnSet): DrizzleFilters => {
    const flipped = Object.entries(set).flatMap(([column, operators]) =>
      Object.entries(operators).map(([operator, value]) => {
        const opposite = NEGATED[operator];
        if (!opposite) throw unsupported(`the negation of \`${operator}\``);
        return { [column]: { [opposite]: value } } as ColumnSet;
      }),
    );
    return flipped.length === 0 ? nothing() : collapse(flipped);
  };

  return {
    leaf: ({ path, operator, value }) => {
      if (path.length !== 1) {
        throw unsupported(`a condition on a related table (\`${path.join('.')}\`)`);
      }
      const column = path[0] as string;
      if (operator === '$exists') {
        return { [column]: value === false ? { isNull: true } : { isNotNull: true } };
      }
      const mapped = OPERATORS[operator];
      if (!mapped) throw unsupported(`the \`${operator}\` operator`);
      return { [column]: { [mapped]: value } };
    },
    // NOT(b1 OR b2) === NOT(b1) AND NOT(b2).
    not: (filter) => and(branchesOf(filter).map(negateSet)),
    and,
    or: (filters) => collapse(filters.flatMap(branchesOf)),
    everything: () => ({}),
    nothing,
  };
}

/**
 * Throw unless `filter` is something drizzle-graphql's `extractFilters` would
 * accept. Useful as a test assertion: an adapter that emits an illegal filter
 * fails at the data layer, not at GraphQL validation.
 */
export function assertLegalDrizzleFilter(filter: unknown): void {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new Error(`not a filter object: ${JSON.stringify(filter)}`);
  }
  const keys = Object.keys(filter);
  const record = filter as Record<string, unknown>;
  for (const forbidden of ['AND', 'NOT']) {
    if (keys.includes(forbidden)) throw new Error(`drizzle-graphql has no \`${forbidden}\` key`);
  }
  if (!keys.includes('OR')) return;
  if (keys.length > 1) {
    throw new Error("cannot specify both fields and 'OR' in table filters");
  }
  const or = record.OR;
  if (!Array.isArray(or)) throw new Error('`OR` must be a list');
  if (or.length === 0) throw new Error('an empty `OR` is dropped, and would match every row');
  for (const branch of or) {
    if (typeof branch !== 'object' || branch === null)
      throw new Error('an `OR` branch must be an object');
    if (Object.keys(branch).some((key) => key === 'OR' || key === 'AND' || key === 'NOT')) {
      throw new Error('`OR` does not nest in drizzle-graphql');
    }
  }
}
