import { createTestkit } from '@envelop/testing';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { ExecutionResult } from 'graphql';
import { describe, expect, it } from 'vitest';
import { useGraphQLCasl } from '../src/envelop.js';
import {
  Actions,
  accept,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  PermissionsError,
  type PermissionsMap,
  rule,
  UNAUTHORIZED_FIELD_OR_TYPE,
} from '../src/index.js';

type M = { Note: { id: string; userId: string; body: string; secret: string } };

const NOTES = [
  { id: 'n1', userId: 'alice', body: 'alice note', secret: 'shh' },
  { id: 'n2', userId: 'bob', body: 'bob note', secret: 'psst' },
];

interface Context {
  userId?: string;
}

const typed = createTyped<M>();

const canUser = createCan<Context, M>(
  async (ctx) => {
    const { can, build } = createGraphQLAbility<M>();
    if (!ctx.userId) return build();
    can(Actions.read, 'Note', ['id', 'body', 'userId']);
    can(Actions.read, 'Note', ['secret'], { userId: ctx.userId });
    can(Actions.update, 'Note', { userId: ctx.userId });
    return build();
  },
  (ctx) => ctx.userId != null,
  typed,
);

function schemaWith(resolvers: Record<string, Record<string, unknown>> = {}) {
  return makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Note {
        id: ID!
        userId: ID!
        body: String!
        secret: String
      }
      type Query {
        note(id: ID!): Note
        notes: [Note!]!
      }
      type Mutation {
        updateNote(id: ID!, body: String!): Note
      }
    `,
    resolvers: {
      Query: {
        note: (_p: unknown, args: { id: string }) => NOTES.find((n) => n.id === args.id) ?? null,
        notes: () => NOTES,
      },
      Mutation: {
        updateNote: (_p: unknown, args: { id: string }) =>
          NOTES.find((n) => n.id === args.id) ?? null,
      },
      ...resolvers,
    },
  });
}

/** Runs one query through envelop with the plugin installed. */
function run(
  permissions: PermissionsMap<Record<string, Record<string, unknown>>>,
  options: Omit<Parameters<typeof useGraphQLCasl>[0], 'permissions'> = {},
) {
  const testkit = createTestkit([useGraphQLCasl({ permissions, ...options })], schemaWith());
  return async (query: string, context: Context = {}) =>
    (await testkit.execute(query, {}, context)) as ExecutionResult;
}

describe('useGraphQLCasl', () => {
  it('allows a field the map permits', async () => {
    const execute = run({ Query: { note: canUser(Actions.read, 'Note') } });
    const result = await execute('{ note(id: "n1") { id } }', { userId: 'alice' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.note).toEqual({ id: 'n1' });
  });

  it('denies a field the map forbids', async () => {
    const execute = run({ Query: { note: deny } });
    const result = await execute('{ note(id: "n1") { id } }', { userId: 'alice' });
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.data?.note).toBeNull();
  });

  it('leaves a field the map does not name unguarded', async () => {
    const execute = run({ Query: { note: deny } });
    const result = await execute('{ notes { id } }');
    expect(result.errors).toBeUndefined();
    expect(result.data?.notes).toHaveLength(2);
  });

  it('guards every field under a fallback rule', async () => {
    const execute = run({ Query: { notes: accept } }, { fallbackRule: deny });
    const result = await execute('{ notes { id } }');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('leaves introspection working under a fallback rule', async () => {
    const execute = run({}, { fallbackRule: deny });
    const result = await execute('{ __schema { queryType { name } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data?.__schema).toEqual({ queryType: { name: 'Query' } });
  });

  it('applies a rule only once, however many fields resolve', async () => {
    let checks = 0;
    const counting = rule(() => {
      checks += 1;
      return true;
    });
    const execute = run({ Note: { id: counting } });
    await execute('{ notes { id } }');
    expect(checks).toBe(NOTES.length);
  });

  it('guards a field that has no resolver of its own', async () => {
    const execute = run({ Note: { body: deny } });
    const result = await execute('{ note(id: "n1") { body } }');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('enforces CASL conditions against the context', async () => {
    const permissions = {
      Mutation: {
        updateNote: canUser(Actions.update, 'Note', (args: { id: string }) => ({
          userId: NOTES.find((n) => n.id === args.id)?.userId,
        })),
      },
    };
    const execute = run(permissions as PermissionsMap<Record<string, Record<string, unknown>>>);

    const mine = await execute('mutation { updateNote(id: "n1", body: "x") { id } }', {
      userId: 'alice',
    });
    expect(mine.errors).toBeUndefined();

    const theirs = await execute('mutation { updateNote(id: "n2", body: "x") { id } }', {
      userId: 'alice',
    });
    expect(theirs.errors?.[0]?.message).toBe('Forbidden');
  });

  it('drives field rules from the ability with a fields() rule', async () => {
    const execute = run({ Note: canUser.fields(Actions.read, 'Note') });
    const result = await execute('{ note(id: "n1") { body secret } }', { userId: 'alice' });
    expect(result.data?.note).toEqual({ body: 'alice note', secret: 'shh' });

    const other = await execute('{ note(id: "n2") { body secret } }', { userId: 'alice' });
    expect(other.data?.note).toEqual({ body: 'bob note', secret: null });
    expect(other.errors?.[0]?.path).toEqual(['note', 'secret']);
  });

  it('honours the error-control options', async () => {
    const execute = run({ Query: { note: deny } }, { fallbackError: 'Not Authorised!' });
    const result = await execute('{ note(id: "n1") { id } }');
    expect(result.errors?.[0]?.message).toBe('Not Authorised!');
  });

  it('honours maskDenials', async () => {
    const execute = run({ Query: { notes: deny } }, { maskDenials: true });
    const result = await execute('{ notes { id } }');
    expect(result.errors).toBeUndefined();
    expect(result.data?.notes).toEqual([]);
  });

  it('filters a denied non-null list and reports it, with no hook to wire', async () => {
    const execute = run({ Query: { notes: deny } }, { onDeny: 'filter' });
    const result = await execute('{ notes { id } }');
    expect(result.data?.notes).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.path).toEqual(['notes']);
    expect(result.errors?.[0]?.extensions).toEqual({ code: UNAUTHORIZED_FIELD_OR_TYPE });
  });

  it('reports filtered denials into extensions when asked', async () => {
    const execute = run({ Query: { note: deny } }, { onDeny: 'filter', report: 'extensions' });
    const result = await execute('{ note(id: "n1") { id } }');
    expect(result.data?.note).toBeNull();
    expect(result.errors).toBeUndefined();
    expect(result.extensions?.authorizationErrors).toEqual([
      expect.objectContaining({
        message: 'Forbidden',
        path: ['note'],
        extensions: { code: UNAUTHORIZED_FIELD_OR_TYPE },
      }),
    ]);
  });

  it('leaves a result with nothing filtered untouched', async () => {
    const execute = run({ Query: { notes: accept } }, { onDeny: 'filter', report: 'extensions' });
    const result = await execute('{ notes { id } }');
    expect(result.errors).toBeUndefined();
    expect(result.extensions).toBeUndefined();
    expect(result.data?.notes).toHaveLength(2);
  });

  it('rejects a map that does not match the schema', () => {
    expect(() =>
      createTestkit(
        [
          useGraphQLCasl<Record<string, Record<string, unknown>>>({
            permissions: { Nope: { id: deny } },
          }),
        ],
        schemaWith(),
      ),
    ).toThrow(PermissionsError);
  });

  it('validates against a schema swapped at runtime', async () => {
    // The map is fine for the schema above and wrong for this one.
    const execute = run({ Query: { note: deny } });
    const result = await execute('{ note(id: "n1") { id } }');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(() =>
      createTestkit(
        [
          useGraphQLCasl<Record<string, Record<string, unknown>>>({
            permissions: { Query: { note: deny } },
          }),
        ],
        makeExecutableSchema({ typeDefs: `type Query { other: String }` }),
      ),
    ).toThrow(PermissionsError);
  });
});
