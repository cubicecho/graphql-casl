import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { describe, expect, it } from 'vitest';
import { reportDenialsPlugin } from '../src/apollo.js';
import {
  type ApplyPermissionsOptions,
  accept,
  applyPermissions,
  deny,
  type PermissionsMap,
  UNAUTHORIZED_FIELD_OR_TYPE,
} from '../src/index.js';

type LooseMap = PermissionsMap<Record<string, Record<string, unknown>>>;

interface Context {
  userId?: string;
}

const CODE = { code: UNAUTHORIZED_FIELD_OR_TYPE };

/** An Apollo Server over a guarded schema, filtering by default. */
function serverWith(permissions: LooseMap, options?: ApplyPermissionsOptions) {
  const schema = makeExecutableSchema({
    typeDefs: `type Query { list: [String!]! nullable: String }`,
    resolvers: { Query: { list: () => ['a'], nullable: () => 'ok' } },
  });
  return new ApolloServer<Context>({
    schema: applyPermissions(schema, permissions, { onDeny: 'filter', ...options }),
    plugins: [reportDenialsPlugin()],
    includeStacktraceInErrorResponses: false,
  });
}

/** Runs one query the way a test against Apollo does, and returns the body. */
async function query(server: ApolloServer<Context>, source: string) {
  const response = await server.executeOperation({ query: source }, { contextValue: {} });
  if (response.body.kind !== 'single') throw new Error('expected a single result');
  return response.body.singleResult;
}

describe('reportDenialsPlugin', () => {
  it('reports a filtered non-null list into errors, formatted like the rest', async () => {
    const result = await query(serverWith({ Query: { list: deny } }), '{ list }');
    expect(result.data).toEqual({ list: [] });
    expect(result.errors).toEqual([
      {
        message: 'Forbidden',
        locations: [{ line: 1, column: 3 }],
        path: ['list'],
        extensions: CODE,
      },
    ]);
  });

  it('appends to the errors Apollo already formatted', async () => {
    const server = serverWith({ Query: { list: deny, nullable: deny } });
    const result = await query(server, '{ nullable list }');
    expect(result.data).toEqual({ nullable: null, list: [] });
    expect(result.errors?.map((error) => error.path)).toEqual([['nullable'], ['list']]);
    expect(result.errors?.map((error) => error.extensions)).toEqual([CODE, CODE]);
  });

  it("reports into extensions.authorizationErrors under report: 'extensions'", async () => {
    const server = serverWith({ Query: { list: deny, nullable: deny } }, { report: 'extensions' });
    const result = await query(server, '{ nullable list }');
    expect(result.data).toEqual({ nullable: null, list: [] });
    expect(result.errors).toBeUndefined();
    expect(result.extensions).toEqual({
      authorizationErrors: [
        expect.objectContaining({ message: 'Forbidden', path: ['nullable'], extensions: CODE }),
        expect.objectContaining({ message: 'Forbidden', path: ['list'], extensions: CODE }),
      ],
    });
  });

  it('leaves a response with nothing recorded untouched', async () => {
    const allowed: LooseMap = { Query: { list: accept, nullable: accept } };
    const result = await query(serverWith(allowed, { report: 'extensions' }), '{ nullable list }');
    expect(result.data).toEqual({ nullable: 'ok', list: ['a'] });
    expect(result.errors).toBeUndefined();
    expect(result.extensions).toBeUndefined();

    // Nothing is ever recorded under 'reject', so the plugin is inert there:
    // the error carries the code Apollo gives an error that named none.
    const rejecting = serverWith({ Query: { list: deny } }, { onDeny: 'reject' });
    const rejected = await query(rejecting, '{ list }');
    expect(rejected.data).toBeNull();
    expect(rejected.errors?.[0]?.message).toBe('Forbidden');
    expect(rejected.errors?.[0]?.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('leaves an incremental response alone', async () => {
    const listener = await reportDenialsPlugin().requestDidStart({ contextValue: {} });
    await expect(
      listener.willSendResponse({ contextValue: {}, response: { body: { kind: 'incremental' } } }),
    ).resolves.toBeUndefined();
  });
});
