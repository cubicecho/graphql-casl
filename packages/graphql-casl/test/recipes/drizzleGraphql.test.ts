import { describe, expect, it } from 'vitest';
import { Actions, accessibleBy, createGraphQLAbility } from '../../src/index.js';
import { assertLegalDrizzleFilter, drizzleFilters } from './drizzleGraphql.js';

type M = { Note: { id: number; userId: string; status: string; views: number } };

const adapter = drizzleFilters({ nonNullColumn: 'id' });

function abilityWith(define: (builder: ReturnType<typeof createGraphQLAbility<M>>) => void) {
  const builder = createGraphQLAbility<M>();
  define(builder);
  return builder.build();
}

const scopeFor = (define: (builder: ReturnType<typeof createGraphQLAbility<M>>) => void) =>
  accessibleBy(abilityWith(define), Actions.read, 'Note', adapter);

describe('the drizzle-graphql recipe adapter', () => {
  it('maps a comparison onto the generated column operator', () => {
    expect(adapter.leaf({ path: ['views'], operator: '$gte', value: 10 })).toEqual({
      views: { gte: 10 },
    });
    expect(adapter.leaf({ path: ['status'], operator: '$in', value: ['live'] })).toEqual({
      status: { inArray: ['live'] },
    });
  });

  it('maps `$exists` onto isNull / isNotNull', () => {
    expect(adapter.leaf({ path: ['userId'], operator: '$exists', value: true })).toEqual({
      userId: { isNotNull: true },
    });
    expect(adapter.leaf({ path: ['userId'], operator: '$exists', value: false })).toEqual({
      userId: { isNull: true },
    });
  });

  it('refuses an operator the dialect has no column field for', () => {
    expect(() => adapter.leaf({ path: ['status'], operator: '$regex', value: /x/ })).toThrow(
      /cannot express the `\$regex` operator/,
    );
  });

  it('refuses a condition on a related table', () => {
    expect(() => adapter.leaf({ path: ['author', 'id'], operator: '$eq', value: 1 })).toThrow(
      /related table \(`author.id`\)/,
    );
  });

  it('ANDs by merging column entries, since there is no `AND` key', () => {
    expect(adapter.and([{ userId: { eq: 'u1' } }, { status: { eq: 'live' } }])).toEqual({
      userId: { eq: 'u1' },
      status: { eq: 'live' },
    });
  });

  it('merges two operators on the same column', () => {
    expect(adapter.and([{ views: { gte: 1 } }, { views: { lt: 10 } }])).toEqual({
      views: { gte: 1, lt: 10 },
    });
  });

  it('refuses to AND two of the same operator on one column', () => {
    expect(() => adapter.and([{ views: { gte: 1 } }, { views: { gte: 5 } }])).toThrow(
      /two `gte` conditions on `views`/,
    );
  });

  it('distributes an AND over an OR, because OR cannot nest', () => {
    const filter = adapter.and([
      { OR: [{ status: { eq: 'live' } }, { status: { eq: 'draft' } }] },
      { userId: { eq: 'u1' } },
    ]);
    expect(filter).toEqual({
      OR: [
        { status: { eq: 'live' }, userId: { eq: 'u1' } },
        { status: { eq: 'draft' }, userId: { eq: 'u1' } },
      ],
    });
    assertLegalDrizzleFilter(filter);
  });

  it('multiplies out two ORs', () => {
    expect(
      adapter.and([
        { OR: [{ status: { eq: 'a' } }, { status: { eq: 'b' } }] },
        { OR: [{ userId: { eq: 'u1' } }, { userId: { eq: 'u2' } }] },
      ]),
    ).toEqual({
      OR: [
        { status: { eq: 'a' }, userId: { eq: 'u1' } },
        { status: { eq: 'a' }, userId: { eq: 'u2' } },
        { status: { eq: 'b' }, userId: { eq: 'u1' } },
        { status: { eq: 'b' }, userId: { eq: 'u2' } },
      ],
    });
  });

  it('flattens a nested OR into the single permitted level', () => {
    expect(adapter.or([{ OR: [{ a: { eq: 1 } }, { b: { eq: 2 } }] }, { c: { eq: 3 } }])).toEqual({
      OR: [{ a: { eq: 1 } }, { b: { eq: 2 } }, { c: { eq: 3 } }],
    });
  });

  it('collapses a disjunction containing an unrestricted branch', () => {
    expect(adapter.or([{}, { a: { eq: 1 } }])).toEqual({});
  });

  it('keeps a single branch out of an `OR` wrapper', () => {
    expect(adapter.or([{ a: { eq: 1 } }])).toEqual({ a: { eq: 1 } });
  });

  it('pushes NOT down to the leaves', () => {
    expect(adapter.not({ userId: { eq: 'u1' } })).toEqual({ userId: { ne: 'u1' } });
    expect(adapter.not({ views: { gte: 10 } })).toEqual({ views: { lt: 10 } });
    expect(adapter.not({ userId: { isNotNull: true } })).toEqual({ userId: { isNull: true } });
  });

  it('negates an AND-set into a disjunction', () => {
    expect(adapter.not({ userId: { eq: 'u1' }, status: { eq: 'live' } })).toEqual({
      OR: [{ userId: { ne: 'u1' } }, { status: { ne: 'live' } }],
    });
  });

  it('negates an OR into a conjunction', () => {
    expect(adapter.not({ OR: [{ a: { eq: 1 } }, { b: { eq: 2 } }] })).toEqual({
      a: { ne: 1 },
      b: { ne: 2 },
    });
  });

  it('negates "everything" into a contradiction, not an empty OR', () => {
    // An empty `OR` is *dropped* by extractFilters, which would match every row.
    expect(adapter.not({})).toEqual({ id: { isNull: true, isNotNull: true } });
    expect(adapter.nothing?.()).toEqual({ id: { isNull: true, isNotNull: true } });
  });
});

describe('folding an ability into a drizzle-graphql filter', () => {
  it('emits a bare column set for a single `can`', () => {
    const filter = scopeFor((b) => b.can(Actions.read, 'Note', { userId: 'u1' }));
    expect(filter).toEqual({ userId: { eq: 'u1' } });
    assertLegalDrizzleFilter(filter);
  });

  it('emits one OR branch per `can`', () => {
    const filter = scopeFor((b) => {
      b.can(Actions.read, 'Note', { userId: 'u1' });
      b.can(Actions.read, 'Note', { status: 'public' });
    });
    expect(filter).toEqual({ OR: [{ status: { eq: 'public' } }, { userId: { eq: 'u1' } }] });
    assertLegalDrizzleFilter(filter);
  });

  it('distributes a `cannot` across every branch, keeping OR flat', () => {
    const filter = scopeFor((b) => {
      b.can(Actions.read, 'Note', { userId: 'u1' });
      b.can(Actions.read, 'Note', { status: 'public' });
      b.cannot(Actions.read, 'Note', { status: 'archived' });
    });
    expect(filter).toEqual({
      OR: [
        { status: { eq: 'public', ne: 'archived' } },
        { userId: { eq: 'u1' }, status: { ne: 'archived' } },
      ],
    });
    assertLegalDrizzleFilter(filter);
  });

  it('reports an unrestricted ability as `{}` and a deny-all as null', () => {
    expect(scopeFor((b) => b.can(Actions.read, 'Note'))).toEqual({});
    expect(scopeFor(() => {})).toBeNull();
  });

  it('throws rather than dropping a clause the dialect cannot express', () => {
    expect(() =>
      scopeFor((b) => b.can(Actions.read, 'Note', { status: { $regex: 'x' } as never })),
    ).toThrow(/cannot express/);
  });
});
