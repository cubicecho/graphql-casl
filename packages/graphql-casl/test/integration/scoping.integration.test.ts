/**
 * End-to-end test for argument scoping: a generated-CRUD-shaped schema whose
 * `notes(where:)` resolver knows nothing about permissions, narrowed from the
 * outside by a rule that rewrites its arguments.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { type GraphQLSchema, graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  Actions,
  accept,
  and,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  type FilterAdapter,
  type GraphQLAbility,
  granted,
  grants,
  PermissionsError,
  type PermissionsMap,
  rule,
  wrap,
} from '../../src/index.js';
import { scopeArgs } from '../../src/scoping.js';

// --- Domain -----------------------------------------------------------------

interface Note {
  id: string;
  userId: string;
  status: string;
  body: string;
}

const NOTES: readonly Note[] = [
  { id: 'n1', userId: 'alice', status: 'live', body: 'a1' },
  { id: 'n2', userId: 'alice', status: 'archived', body: 'a2' },
  { id: 'n3', userId: 'bob', status: 'live', body: 'b1' },
];

type AppSubjectMap = { Note: Note };
type AppAbility = GraphQLAbility<AppSubjectMap>;

function abilityFor(userId: string | undefined): AppAbility {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (userId === 'admin') can(Actions.read, 'Note');
  else if (userId === 'alice') can(Actions.read, 'Note', { userId: 'alice' });
  // Anyone else gets no rules at all: deny-all.
  return build();
}

interface Context {
  userId?: string;
}

const canUser = createCan<Context, AppSubjectMap>(
  async (context) => abilityFor(context.userId),
  (context) => Boolean(context.userId),
);

// --- The dialect the generated schema actually speaks ------------------------

/** A drizzle-graphql-shaped filter: `{ userId: { eq: 'alice' } }`. */
type Filter = Record<string, unknown>;

const OPERATORS: Record<string, string> = { $eq: 'eq', $ne: 'ne', $in: 'in' };

const dialect: FilterAdapter<Filter> = {
  leaf: ({ path, operator, value }) => {
    const op = OPERATORS[operator];
    if (!op) throw new Error(`this schema has no operator for ${operator}`);
    // Nested paths would need a relation filter; this schema is flat.
    return { [path.join('.')]: { [op]: value } };
  },
  not: (filter) => ({ NOT: filter }),
  and: (filters) => ({ AND: filters }),
  or: (filters) => ({ OR: filters }),
  everything: () => ({}),
  nothing: () => ({ id: { in: [] } }),
};

/** The data layer: evaluates a `Filter` against a row. */
function matches(note: Note, filter: Filter | null | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'AND') return (value as Filter[]).every((member) => matches(note, member));
    if (key === 'OR') return (value as Filter[]).some((member) => matches(note, member));
    if (key === 'NOT') return !matches(note, value as Filter);
    const actual = note[key as keyof Note];
    const comparison = value as { eq?: string; ne?: string; in?: string[] };
    if (comparison.eq !== undefined) return actual === comparison.eq;
    if (comparison.ne !== undefined) return actual !== comparison.ne;
    if (comparison.in !== undefined) return comparison.in.includes(actual);
    return true;
  });
}

const typeDefs = /* GraphQL */ `
  input StringFilter {
    eq: String
    ne: String
    in: [String!]
  }
  input NoteFilter {
    id: StringFilter
    userId: StringFilter
    status: StringFilter
    AND: [NoteFilter!]
    OR: [NoteFilter!]
    NOT: NoteFilter
  }
  type Note {
    id: ID!
    userId: String!
    status: String!
    body: String!
  }
  type Query {
    notes(where: NoteFilter): [Note!]!
    noteCount: Int!
  }
  type Mutation {
    archiveNotes(where: NoteFilter): [ID!]!
  }
`;

/** Records what the resolver was actually handed, so injection is observable. */
let seenArgs: unknown;

const resolvers = {
  Query: {
    notes: (_p: unknown, args: { where?: Filter }) => {
      seenArgs = args;
      return NOTES.filter((note) => matches(note, args.where));
    },
    noteCount: () => NOTES.length,
  },
  Mutation: {
    archiveNotes: (_p: unknown, args: { where?: Filter }) =>
      NOTES.filter((note) => matches(note, args.where)).map((note) => note.id),
  },
};

type AnyPermissions = PermissionsMap<Record<string, Record<string, unknown>>>;

function schemaWith(permissions: AnyPermissions, options?: Parameters<typeof applyPermissions>[2]) {
  const base = makeExecutableSchema({ typeDefs, resolvers });
  return applyPermissions(base, permissions, options) as GraphQLSchema;
}

async function run(schema: GraphQLSchema, source: string, userId?: string) {
  return graphql({ schema, source, contextValue: { userId } satisfies Context });
}

const scopedNotes = scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect });

describe('scopeArgs', () => {
  const schema = schemaWith({ Query: { notes: scopedNotes } });

  it('returns only the rows the caller may read', async () => {
    const result = await run(schema, '{ notes { id } }', 'alice');
    expect(result.errors).toBeUndefined();
    expect(result.data?.notes).toEqual([{ id: 'n1' }, { id: 'n2' }]);
  });

  it('injects the filter into the argument the resolver reads', async () => {
    await run(schema, '{ notes { id } }', 'alice');
    expect(seenArgs).toEqual({ where: { userId: { eq: 'alice' } } });
  });

  it('leaves the arguments untouched when the ability restricts nothing', async () => {
    seenArgs = undefined;
    const result = await run(schema, '{ notes { id } }', 'admin');
    expect(result.data?.notes).toHaveLength(3);
    // Not `{ where: {} }` — an unrestricted ability must not rewrite anything.
    expect(seenArgs).toEqual({});
  });

  it("ANDs the scope onto the client's own filter", async () => {
    const result = await run(
      schema,
      '{ notes(where: { status: { eq: "live" } }) { id } }',
      'alice',
    );
    expect(result.data?.notes).toEqual([{ id: 'n1' }]);
    expect(seenArgs).toEqual({
      where: { AND: [{ status: { eq: 'live' } }, { userId: { eq: 'alice' } }] },
    });
  });

  it('cannot be escaped by a top-level OR in the client filter', async () => {
    // A key-spread "merge" would put the scope beside `OR` and be ignored.
    const result = await run(
      schema,
      '{ notes(where: { OR: [{ userId: { eq: "bob" } }, { userId: { eq: "alice" } }] }) { id } }',
      'alice',
    );
    expect(result.data?.notes).toEqual([{ id: 'n1' }, { id: 'n2' }]);
  });

  it('denies the field outright when the ability permits no row', async () => {
    const result = await run(schema, '{ notes { id } }', 'nobody');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('denies an unauthenticated caller before consulting the ability', async () => {
    const result = await run(schema, '{ notes { id } }');
    expect(result.errors?.[0]?.message).toBe('Not authenticated');
  });

  it('says nothing about the fields around it', async () => {
    // Scoping is not a gate: pair it with `fallbackRule`.
    const guarded = schemaWith(
      { Query: { notes: scopedNotes } },
      { fallbackRule: deny, fallbackError: 'Nope' },
    );
    const result = await run(guarded, '{ noteCount }', 'admin');
    expect(result.errors?.[0]?.message).toBe('Nope');
  });
});

describe("scopeArgs with onDenyAll: 'nothing'", () => {
  const schema = schemaWith({
    Query: {
      notes: scopeArgs(canUser, Actions.read, 'Note', {
        adapter: dialect,
        onDenyAll: 'nothing',
      }),
    },
  });

  it('resolves to an empty result instead of an error', async () => {
    const result = await run(schema, '{ notes { id } }', 'nobody');
    expect(result.errors).toBeUndefined();
    expect(result.data?.notes).toEqual([]);
  });

  it('needs an adapter that can express "no row"', () => {
    const { nothing, ...withoutNothing } = dialect as FilterAdapter<Filter> & {
      nothing: () => Filter;
    };
    expect(() =>
      scopeArgs(canUser, Actions.read, 'Note', {
        adapter: withoutNothing as FilterAdapter<Filter>,
        onDenyAll: 'nothing',
      }),
    ).toThrow(/needs an adapter that supplies `nothing\(\)`/);
    expect(nothing()).toEqual({ id: { in: [] } });
  });
});

describe('scopeArgs on a mutation', () => {
  it('narrows the rows the mutation touches', async () => {
    const schema = schemaWith({
      Mutation: {
        archiveNotes: scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect }),
      },
    });
    const result = await run(schema, 'mutation { archiveNotes }', 'alice');
    expect(result.data?.archiveNotes).toEqual(['n1', 'n2']);
  });

  it('fails a deny-all caller rather than silently touching nothing', async () => {
    const schema = schemaWith({
      Mutation: {
        archiveNotes: scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect }),
      },
    });
    const result = await run(schema, 'mutation { archiveNotes }', 'nobody');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });
});

describe('scopeArgs options', () => {
  it('honours a custom `into`', async () => {
    const schema = schemaWith({
      Query: {
        notes: scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect, into: 'where' }),
      },
    });
    await run(schema, '{ notes { id } }', 'alice');
    expect(seenArgs).toEqual({ where: { userId: { eq: 'alice' } } });
  });

  it('honours a custom `merge`', async () => {
    const schema = schemaWith({
      Query: {
        notes: scopeArgs(canUser, Actions.read, 'Note', {
          adapter: dialect,
          merge: (clientFilter, scope) => ({ AND: [scope, clientFilter] }),
        }),
      },
    });
    await run(schema, '{ notes(where: { status: { eq: "live" } }) { id } }', 'alice');
    expect(seenArgs).toEqual({
      where: { AND: [{ userId: { eq: 'alice' } }, { status: { eq: 'live' } }] },
    });
  });

  it('rejects a `requireCan` that did not come from createCan', () => {
    expect(() =>
      scopeArgs((() => {}) as never, Actions.read, 'Note', { adapter: dialect }),
    ).toThrow(/expects the `requireCan` returned by `createCan`/);
  });

  it('is not combinable', () => {
    expect(() => and(scopedNotes, scopedNotes)).toThrow(/not a checkable rule/);
  });
});

describe('validation of the injected argument', () => {
  it('refuses a scope rule aimed at an argument the field does not have', () => {
    expect(() => schemaWith({ Query: { noteCount: scopedNotes } })).toThrow(PermissionsError);
    expect(() => schemaWith({ Query: { noteCount: scopedNotes } })).toThrow(
      /injects a filter into an argument named `where`, but `noteCount` has no such argument/,
    );
  });

  it('refuses a scope rule under a type wildcard that does not fit every field', () => {
    expect(() => schemaWith({ Query: { '*': scopedNotes } })).toThrow(
      /`noteCount` has no such argument/,
    );
  });

  it('refuses a scope rule under `*.*`', () => {
    expect(() => schemaWith({ '*': { '*': scopedNotes } })).toThrow(
      /cannot be right for every field of every type/,
    );
  });

  it('accepts a scope rule under a field wildcard when every match fits', () => {
    expect(() => schemaWith({ '*': { notes: scopedNotes } })).not.toThrow();
  });
});

describe('wrap, composing a scoping rule with rules that cannot be combined', () => {
  const typed = createTyped<AppSubjectMap>();
  const canTagged = createCan<Context, AppSubjectMap>(
    async (context) => abilityFor(context.userId),
    (context) => Boolean(context.userId),
    typed,
  );
  const isNotBanned = rule(
    (_parent, _args, context: Context) => context.userId !== 'mallory' || 'Account suspended',
    { name: 'isNotBanned' },
  );

  it('gates the field first, then scopes it', async () => {
    const schema = schemaWith({ Query: { notes: wrap(isNotBanned, scopedNotes) } });

    const allowed = await run(schema, '{ notes { id } }', 'alice');
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data?.notes).toEqual([{ id: 'n1' }, { id: 'n2' }]);

    const banned = await run(schema, '{ notes { id } }', 'mallory');
    expect(banned.errors?.[0]?.message).toBe('Account suspended');
  });

  it('does not run the scoping rule when the gate denies', async () => {
    const schema = schemaWith({ Query: { notes: wrap(deny, scopedNotes) } });
    seenArgs = undefined;
    const result = await run(schema, '{ notes { id } }', 'alice');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(seenArgs).toBeUndefined();
  });

  it('re-checks the scoped result, which no combinator could express', async () => {
    // Both operands decide by running the resolver, so neither is a legal
    // operand of `and`/`chain`. `wrap` nests them: the query is narrowed to
    // alice′s rows, then each returned row is authorized for `update`.
    const schema = schemaWith({
      Query: { notes: wrap(scopedNotes, canTagged.onResult(Actions.update, 'Note')) },
    });

    const readable = await run(schema, '{ notes { id } }', 'admin');
    expect(readable.errors?.[0]?.message).toBe('Forbidden');

    const scopedThenChecked = await run(schema, '{ notes { id } }', 'alice');
    expect(scopedThenChecked.errors?.[0]?.message).toBe('Forbidden');
    // The inner rule saw the *scoped* rows, not all three.
    expect(seenArgs).toEqual({ where: { userId: { eq: 'alice' } } });
  });

  it('still validates the injected argument through the wrapper', () => {
    const nested = wrap(
      accept,
      scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect, into: 'filter' }),
    );
    expect(() => schemaWith({ Query: { notes: nested } })).toThrow(PermissionsError);
    expect(() => schemaWith({ Query: { notes: nested } })).toThrow(/argument named `filter`/);
  });

  it('still validates the injected argument through a granting rule', () => {
    const granting = grants(
      scopeArgs(canUser, Actions.read, 'Note', { adapter: dialect, into: 'filter' }),
      'note',
    );
    expect(() => schemaWith({ Query: { notes: granting } })).toThrow(/argument named `filter`/);
  });

  it('grants the rows a scoped list returned', async () => {
    const schema = schemaWith({
      Query: { notes: grants(scopedNotes, 'note') },
      Note: granted('note'),
    });
    const result = await graphql({
      schema,
      source: '{ notes { id body } }',
      contextValue: { userId: 'alice' },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.notes).toEqual([
      { id: 'n1', body: 'a1' },
      { id: 'n2', body: 'a2' },
    ]);
  });

  it('still refuses a wrapped scoping rule under the `*.*` wildcard', () => {
    expect(() => schemaWith({ '*': { '*': wrap(accept, scopedNotes) } })).toThrow(
      /rewrites a field argument/,
    );
  });
});
