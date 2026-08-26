import { describe, expect, it } from 'vitest';
import { Actions, accessibleBy, createGraphQLAbility, type FilterAdapter } from '../src/index.js';

type M = {
  Note: { id: string; userId: string; status: string; archived: boolean };
  Tag: { id: string };
};

/** Builds an ability from a callback so each test states only its own rules. */
function abilityWith(define: (builder: ReturnType<typeof createGraphQLAbility<M>>) => void) {
  const builder = createGraphQLAbility<M>();
  define(builder);
  return builder.build();
}

describe('accessibleBy', () => {
  it('returns null when no rule permits the action', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.read, 'Tag');
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toBeNull();
  });

  it('returns null when the only rule is for another action', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.update, 'Note', { userId: 'u1' });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toBeNull();
  });

  it('returns the conditions of a single rule unwrapped', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.read, 'Note', { userId: 'u1' });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({ userId: 'u1' });
  });

  it('keeps CASL operators in the conditions', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.read, 'Note', { status: { $in: ['live', 'draft'] } });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({
      status: { $in: ['live', 'draft'] },
    });
  });

  it('ORs several conditioned rules together', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.read, 'Note', { userId: 'u1' });
      can(Actions.read, 'Note', { status: 'public' });
    });
    // Rules come back highest-priority first — the last one declared.
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({
      $or: [{ status: 'public' }, { userId: 'u1' }],
    });
  });

  it('returns an empty filter when a rule permits everything', () => {
    const ability = abilityWith(({ can }) => {
      can(Actions.read, 'Note');
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({});
  });

  it('bounds an unconditioned rule by the exclusions that outrank it', () => {
    const ability = abilityWith(({ can, cannot }) => {
      can(Actions.read, 'Note');
      cannot(Actions.read, 'Note', { archived: true });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({
      $nor: [{ archived: true }],
    });
  });

  it('bounds each conditioned branch by the exclusions that outrank it', () => {
    const ability = abilityWith(({ can, cannot }) => {
      can(Actions.read, 'Note', { userId: 'u1' });
      cannot(Actions.read, 'Note', { archived: true });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({
      $and: [{ userId: 'u1' }, { $nor: [{ archived: true }] }],
    });
  });

  it('ignores an exclusion a permission outranks', () => {
    // Declared first, so `cannot` is the LOWER priority rule and never applies.
    const ability = abilityWith(({ can, cannot }) => {
      cannot(Actions.read, 'Note', { archived: true });
      can(Actions.read, 'Note', { userId: 'u1' });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({ userId: 'u1' });
  });

  it('denies everything below an unconditioned exclusion', () => {
    const ability = abilityWith(({ can, cannot }) => {
      can(Actions.read, 'Note', { userId: 'u1' });
      cannot(Actions.read, 'Note');
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toBeNull();
  });

  it('keeps permissions that outrank an unconditioned exclusion', () => {
    const ability = abilityWith(({ can, cannot }) => {
      cannot(Actions.read, 'Note');
      can(Actions.read, 'Note', { userId: 'u1' });
    });
    expect(accessibleBy(ability, Actions.read, 'Note')).toEqual({ userId: 'u1' });
  });

  it('matches the ability itself, row by row', () => {
    const ability = abilityWith(({ can, cannot }) => {
      can(Actions.read, 'Note', { userId: 'u1' });
      can(Actions.read, 'Note', { status: 'public' });
      cannot(Actions.read, 'Note', { archived: true });
    });
    const rows = [
      { id: '1', userId: 'u1', status: 'draft', archived: false },
      { id: '2', userId: 'u2', status: 'public', archived: false },
      { id: '3', userId: 'u1', status: 'draft', archived: true },
      { id: '4', userId: 'u2', status: 'draft', archived: false },
    ];
    const allowed = rows.filter((row) => ability.can(Actions.read, { __typename: 'Note', ...row }));
    expect(allowed.map((row) => row.id)).toEqual(['1', '2']);

    // The same decision, expressed as a filter.
    const filter = accessibleBy(ability, Actions.read, 'Note');
    expect(filter).toEqual({
      $or: [
        { $and: [{ status: 'public' }, { $nor: [{ archived: true }] }] },
        { $and: [{ userId: 'u1' }, { $nor: [{ archived: true }] }] },
      ],
    });
  });

  describe('with a custom adapter', () => {
    const prisma: FilterAdapter<object> = {
      rule: (conditions, inverted) => (inverted ? { NOT: conditions } : conditions),
      and: (filters) => ({ AND: filters }),
      or: (filters) => ({ OR: filters }),
      everything: () => ({}),
    };

    it('builds the boolean skeleton in the adapter’s dialect', () => {
      const ability = abilityWith(({ can, cannot }) => {
        can(Actions.read, 'Note', { userId: 'u1' });
        can(Actions.read, 'Note', { status: 'public' });
        cannot(Actions.read, 'Note', { archived: true });
      });
      expect(accessibleBy(ability, Actions.read, 'Note', prisma)).toEqual({
        OR: [
          { AND: [{ status: 'public' }, { NOT: { archived: true } }] },
          { AND: [{ userId: 'u1' }, { NOT: { archived: true } }] },
        ],
      });
    });

    it('still signals deny-all with null', () => {
      const ability = abilityWith(({ can }) => {
        can(Actions.read, 'Tag');
      });
      expect(accessibleBy(ability, Actions.read, 'Note', prisma)).toBeNull();
    });

    it('uses the adapter’s everything() for an unrestricted rule', () => {
      const ability = abilityWith(({ can }) => {
        can(Actions.read, 'Note');
      });
      expect(accessibleBy(ability, Actions.read, 'Note', prisma)).toEqual({});
    });
  });
});
