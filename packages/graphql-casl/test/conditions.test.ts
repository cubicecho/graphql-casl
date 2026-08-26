import { describe, expect, it } from 'vitest';
import {
  Actions,
  accessibleBy,
  createGraphQLAbility,
  createTyped,
  type FilterAdapter,
  type LeafCondition,
} from '../src/index.js';

/**
 * A leaf adapter that records the leaves it is handed, in order, and rebuilds
 * the boolean skeleton as a readable string. Enough to assert both halves of the
 * walk without inventing a dialect.
 */
function recorder() {
  const leaves: LeafCondition[] = [];
  const adapter: FilterAdapter<string> = {
    leaf: (condition) => {
      leaves.push(condition);
      return `${condition.path.join('.')} ${condition.operator} ${JSON.stringify(condition.value)}`;
    },
    not: (filter) => `NOT(${filter})`,
    and: (filters) => `AND(${filters.join(', ')})`,
    or: (filters) => `OR(${filters.join(', ')})`,
    everything: () => 'ALL',
    nothing: () => 'NONE',
  };
  return { leaves, adapter };
}

type M = { Note: { id: string; n: number; status: string; author: { id: number } } };

function abilityFrom(conditions: object) {
  const builder = createGraphQLAbility<M>();
  // Cast: the typed builder cannot express `$and`/`$or` at the top level, but a
  // rule rehydrated from a database can, and the walk must handle it.
  builder.can(Actions.read, 'Note', conditions as never);
  return builder.build();
}

/** The filter a leaf adapter produces for one rule's conditions. */
function translate(conditions: object, adapter: FilterAdapter<string>): string | null {
  return accessibleBy(abilityFrom(conditions), Actions.read, 'Note', adapter);
}

describe('leaf adapters', () => {
  it('normalizes a bare value to $eq', () => {
    const { leaves, adapter } = recorder();
    expect(translate({ status: 'live' }, adapter)).toBe('status $eq "live"');
    expect(leaves).toEqual([{ path: ['status'], operator: '$eq', value: 'live' }]);
  });

  it('ANDs the keys of a condition object', () => {
    const { adapter } = recorder();
    expect(translate({ status: 'live', n: 1 }, adapter)).toBe('AND(status $eq "live", n $eq 1)');
  });

  it('ANDs several operators on one field', () => {
    const { adapter } = recorder();
    expect(translate({ n: { $gt: 2, $lt: 9 } }, adapter)).toBe('AND(n $gt 2, n $lt 9)');
  });

  it('splits a dotted key into a path', () => {
    const { leaves, adapter } = recorder();
    translate({ 'author.id': 5 }, adapter);
    expect(leaves[0]?.path).toEqual(['author', 'id']);
  });

  it('treats a nested object as an $eq value, not a path', () => {
    const { leaves, adapter } = recorder();
    translate({ author: { id: 5 } }, adapter);
    // Mongo semantics: this matches an `author` equal to exactly `{ id: 5 }`.
    expect(leaves).toEqual([{ path: ['author'], operator: '$eq', value: { id: 5 } }]);
  });

  it('treats a Date as a value to compare, not an operator object', () => {
    const { leaves, adapter } = recorder();
    const at = new Date('2020-01-01T00:00:00.000Z');
    translate({ createdAt: at }, adapter);
    expect(leaves).toEqual([{ path: ['createdAt'], operator: '$eq', value: at }]);
  });

  it('passes $elemMatch through un-walked', () => {
    const { leaves, adapter } = recorder();
    translate({ tags: { $elemMatch: { name: 'x' } } }, adapter);
    expect(leaves).toEqual([{ path: ['tags'], operator: '$elemMatch', value: { name: 'x' } }]);
  });

  it('recurses into $and, $or and $nor groups', () => {
    const { adapter } = recorder();
    expect(translate({ $or: [{ status: 'live' }, { n: 1 }] }, adapter)).toBe(
      'OR(status $eq "live", n $eq 1)',
    );
    // A group the caller wrote is kept as a group, even with one member.
    expect(translate({ $and: [{ status: 'live' }] }, adapter)).toBe('AND(status $eq "live")');
    expect(translate({ $nor: [{ status: 'live' }] }, adapter)).toBe('NOT(OR(status $eq "live"))');
  });

  it('negates an inverted rule', () => {
    const { adapter } = recorder();
    const builder = createGraphQLAbility<M>();
    builder.can(Actions.read, 'Note');
    builder.cannot(Actions.read, 'Note', { status: 'archived' });
    expect(accessibleBy(builder.build(), Actions.read, 'Note', adapter)).toBe(
      'NOT(status $eq "archived")',
    );
  });

  it('treats an empty condition object as no restriction', () => {
    const { adapter } = recorder();
    expect(translate({}, adapter)).toBe('ALL');
  });

  it('throws on an operator it cannot translate', () => {
    const { adapter } = recorder();
    expect(() => translate({ n: { $where: 'x' } }, adapter)).toThrow(
      /unsupported condition operator `\$where`/,
    );
  });

  it('throws on an unknown top-level operator', () => {
    const { adapter } = recorder();
    expect(() => translate({ $comment: 'x' }, adapter)).toThrow(
      /unsupported condition operator `\$comment`/,
    );
  });

  it('refuses to guess at operators mixed with plain keys', () => {
    const { adapter } = recorder();
    expect(() => translate({ n: { $gt: 2, oops: 1 } }, adapter)).toThrow(
      /cannot mix operators with plain keys/,
    );
  });

  it('requires a group operator to hold an array', () => {
    const { adapter } = recorder();
    expect(() => translate({ $or: { status: 'live' } }, adapter)).toThrow(
      /`\$or` in a condition must be an array/,
    );
  });

  it('still passes conditions through untranslated for a skeleton adapter', () => {
    const skeleton: FilterAdapter<object> = {
      rule: (conditions, inverted) => (inverted ? { NOT: conditions } : conditions),
      and: (filters) => ({ AND: filters }),
      or: (filters) => ({ OR: filters }),
      everything: () => ({}),
    };
    expect(translate({ n: { $gt: 2 } }, skeleton as never)).toEqual({ n: { $gt: 2 } });
  });
});

/**
 * The fold is only correct if the filter admits exactly the rows the ability
 * admits. This evaluates the filter as a predicate and compares it, row by row,
 * with `ability.can` — which runs CASL's own matcher.
 */
describe('a folded filter matches the same rows as the ability', () => {
  type Row = { id: string; n: number; status: string; owner: string };
  type RowMap = { Note: Row };
  const typed = createTyped<RowMap>();

  const predicates: FilterAdapter<(row: Row) => boolean> = {
    leaf: ({ path, operator, value }) => {
      return (row) => {
        const actual = path.reduce<unknown>(
          (node, key) => (node == null ? undefined : (node as Record<string, unknown>)[key]),
          row,
        );
        switch (operator) {
          case '$eq':
            return JSON.stringify(actual) === JSON.stringify(value);
          case '$ne':
            return JSON.stringify(actual) !== JSON.stringify(value);
          case '$in':
            return (value as unknown[]).includes(actual);
          case '$nin':
            return !(value as unknown[]).includes(actual);
          case '$gt':
            return (actual as number) > (value as number);
          case '$gte':
            return (actual as number) >= (value as number);
          case '$lt':
            return (actual as number) < (value as number);
          case '$lte':
            return (actual as number) <= (value as number);
          case '$exists':
            return (actual !== undefined) === value;
          default:
            throw new Error(`unhandled in this test: ${operator}`);
        }
      };
    },
    not: (filter) => (row) => !filter(row),
    and: (filters) => (row) => filters.every((filter) => filter(row)),
    or: (filters) => (row) => filters.some((filter) => filter(row)),
    everything: () => () => true,
    nothing: () => () => false,
  };

  const rows: Row[] = [
    { id: 'a', n: 1, status: 'live', owner: 'u1' },
    { id: 'b', n: 5, status: 'live', owner: 'u2' },
    { id: 'c', n: 9, status: 'draft', owner: 'u1' },
    { id: 'd', n: 12, status: 'archived', owner: 'u1' },
    { id: 'e', n: 3, status: 'draft', owner: 'u3' },
  ];

  const cases: [string, (b: ReturnType<typeof createGraphQLAbility<RowMap>>) => void][] = [
    ['a single condition', ({ can }) => can(Actions.read, 'Note', { owner: 'u1' })],
    [
      'two conditions on one rule',
      ({ can }) => can(Actions.read, 'Note', { owner: 'u1', status: 'live' }),
    ],
    [
      'two rules, ORed',
      ({ can }) => {
        can(Actions.read, 'Note', { owner: 'u1' });
        can(Actions.read, 'Note', { status: 'live' });
      },
    ],
    [
      'a cannot bounding a can',
      ({ can, cannot }) => {
        cannot(Actions.read, 'Note', { status: 'archived' });
        can(Actions.read, 'Note', { owner: 'u1' });
      },
    ],
    [
      'a cannot bounding an unconditioned can',
      ({ can, cannot }) => {
        cannot(Actions.read, 'Note', { owner: 'u3' });
        can(Actions.read, 'Note');
      },
    ],
    ['a range', ({ can }) => can(Actions.read, 'Note', { n: { $gt: 2, $lte: 9 } })],
    ['an $in', ({ can }) => can(Actions.read, 'Note', { status: { $in: ['live', 'draft'] } })],
    ['a $ne', ({ can }) => can(Actions.read, 'Note', { status: { $ne: 'archived' } })],
  ];

  for (const [name, define] of cases) {
    it(name, () => {
      const builder = createGraphQLAbility<RowMap>();
      define(builder);
      const ability = builder.build();
      const filter = accessibleBy(ability, Actions.read, 'Note', predicates);
      for (const row of rows) {
        const allowed = ability.can(Actions.read, typed('Note', row));
        expect({ id: row.id, allowed: filter?.(row) ?? false }).toEqual({ id: row.id, allowed });
      }
    });
  }
});
