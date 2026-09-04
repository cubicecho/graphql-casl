import { makeExecutableSchema } from '@graphql-tools/schema';
import { type GraphQLResolveInfo, type GraphQLSchema, graphql } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  Actions,
  type ApplyPermissionsOptions,
  accept,
  and,
  applyPermissions,
  chain,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  granted,
  grants,
  isCheckableRule,
  not,
  or,
  type PermissionsMap,
  type Rule,
  race,
  reportDenials,
  resolvePermissions,
  rule,
  UNAUTHORIZED_FIELD_OR_TYPE,
  wrap,
} from '../src/index.js';

type User = { id: string; email: string };
type Post = { id: string; title: string; body: string; authorId: string };

const users: User[] = [
  { id: 'u1', email: 'one@example.com' },
  { id: 'u2', email: 'two@example.com' },
];
const posts: Post[] = [
  { id: 'p1', title: 'one', body: 'b1', authorId: 'u1' },
  { id: 'p2', title: 'two', body: 'b2', authorId: 'u2' },
];

const typeDefs = /* GraphQL */ `
  type User { id: ID! email: String }
  type Post { id: ID! title: String! body: String! author: User! }
  type Query {
    post: Post
    posts: [Post!]!
    ungranted: [Post!]!
    matrix: [[Post!]!]!
    nothing: Post
    greeting: String
  }
`;

const resolvers = {
  Query: {
    post: () => posts[0],
    posts: () => posts,
    ungranted: () => posts,
    matrix: () => [[posts[0]], [posts[1]]],
    nothing: () => null,
    greeting: () => 'hi',
  },
  Post: { author: (post: Post) => users.find((u) => u.id === post.authorId) },
};

type LooseMap = PermissionsMap<Record<string, Record<string, unknown>>>;

function schemaWith(permissions: LooseMap, options?: ApplyPermissionsOptions): GraphQLSchema {
  return applyPermissions<Record<string, Record<string, unknown>>>(
    makeExecutableSchema({ typeDefs, resolvers }),
    permissions,
    options,
  );
}

async function run(schema: GraphQLSchema, source: string, contextValue: unknown = {}) {
  return graphql({ schema, source, contextValue });
}

const info = {} as GraphQLResolveInfo;
/** A resolver that answers without a promise, as graphql-js resolvers may. */
const syncResolve = (value: unknown) => (() => value) as unknown as Parameters<Rule>[0];

describe('grants / granted — through a schema', () => {
  it('grants the object a field returned, so its fields pass on the grant alone', async () => {
    const schema = schemaWith({ Query: { post: grants(accept, 'post') }, Post: granted('post') });
    const result = await run(schema, '{ post { id title body } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ post: { id: 'p1', title: 'one', body: 'b1' } });
  });

  it('grants every element of a list', async () => {
    const schema = schemaWith({ Query: { posts: grants(accept, 'post') }, Post: granted('post') });
    const result = await run(schema, '{ posts { id title } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      posts: [
        { id: 'p1', title: 'one' },
        { id: 'p2', title: 'two' },
      ],
    });
  });

  it('grants through nested lists', async () => {
    const schema = schemaWith({ Query: { matrix: grants(accept, 'post') }, Post: granted('post') });
    const result = await run(schema, '{ matrix { id } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ matrix: [[{ id: 'p1' }], [{ id: 'p2' }]] });
  });

  it('denies a field whose parent was not granted', async () => {
    const schema = schemaWith({
      Query: { posts: grants(accept, 'post'), ungranted: accept },
      Post: granted('post'),
    });
    const result = await run(schema, '{ ungranted { id } }');
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.path).toEqual(['ungranted', 0, 'id']);
  });

  it('does not inherit transitively: a grant on Post says nothing about Post.author', async () => {
    const schema = schemaWith({
      Query: { post: grants(accept, 'post') },
      Post: granted('post'),
      User: granted('post'),
    });
    const result = await run(schema, '{ post { id author { id } } }');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.path).toEqual(['post', 'author', 'id']);
  });

  it('reaches a nested type when the field returning it grants too', async () => {
    const schema = schemaWith({
      Query: { post: grants(accept, 'post') },
      Post: { '*': granted('post'), author: grants(granted('post'), 'user') },
      User: granted('user'),
    });
    const result = await run(schema, '{ post { id author { id email } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      post: { id: 'p1', author: { id: 'u1', email: 'one@example.com' } },
    });
  });

  it('keeps grants per request: a second context sees none of them', async () => {
    const schema = schemaWith({
      Query: { posts: grants(accept, 'post'), ungranted: accept },
      Post: granted('post'),
    });
    const first = {};
    const second = {};
    expect((await run(schema, '{ posts { id } }', first)).errors).toBeUndefined();
    // The same row objects, tagged under `first` a moment ago, are untagged
    // under `second`.
    const result = await run(schema, '{ ungranted { id } }', second);
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    // And still tagged for `first`: the grant lives as long as the context does.
    expect((await run(schema, '{ ungranted { id } }', first)).errors).toBeUndefined();
  });

  it('grants nothing when the context is not an object', async () => {
    const schema = schemaWith({ Query: { posts: grants(accept, 'post') }, Post: granted('post') });
    const result = await run(schema, '{ posts { id } }', 'a string context');
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    // The list itself was allowed — the wrapped rule's verdict is unchanged.
    expect(result.errors?.[0]?.path).toEqual(['posts', 0, 'id']);
  });

  it('grants nothing when the wrapped rule denies', async () => {
    const ctx = {};
    const schema = schemaWith({
      Query: { posts: grants(deny, 'post'), ungranted: accept },
      Post: granted('post'),
    });
    const denied = await run(schema, '{ posts { id } }', ctx);
    expect(denied.errors?.[0]?.message).toBe('Forbidden');
    expect(denied.errors?.[0]?.path).toEqual(['posts']);
    expect(granted('post').check(posts[0], null, ctx, info)).toBe(false);
  });

  it('grants nothing when the resolver throws', async () => {
    const ctx = {};
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      makeExecutableSchema({
        typeDefs,
        resolvers: {
          ...resolvers,
          Query: {
            ...resolvers.Query,
            posts: () => {
              throw new Error('boom');
            },
          },
        },
      }),
      { Query: { posts: grants(accept, 'post') }, Post: granted('post') },
    );
    const result = await run(schema, '{ posts { id } }', ctx);
    expect(result.errors?.[0]?.message).toBe('boom');
    expect(granted('post').check(posts[0], null, ctx, info)).toBe(false);
  });

  it('passes null and scalars through untouched', async () => {
    const schema = schemaWith({
      Query: { nothing: grants(accept, 'post'), greeting: grants(accept, 'post') },
      Post: granted('post'),
    });
    const result = await run(schema, '{ nothing { id } greeting }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ nothing: null, greeting: 'hi' });
  });

  it('grants several scopes at once', async () => {
    const schema = schemaWith({
      Query: { post: grants(accept, ['post', 'row']) },
      Post: { id: granted('post'), title: granted('row'), body: granted('other') },
    });
    const result = await run(schema, '{ post { id title } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ post: { id: 'p1', title: 'one' } });
    const other = await run(schema, '{ post { body } }');
    expect(other.errors?.[0]?.message).toBe('Forbidden');
  });

  it('is a type-level entry like any other rule, and works under a wildcard', async () => {
    const schema = schemaWith({
      Query: { posts: grants(accept, 'post') },
      '*': { '*': granted('post') },
    });
    const result = await run(schema, '{ posts { id } }');
    expect(result.errors).toBeUndefined();
  });
});

describe('grants / granted — composition', () => {
  const granting = { Query: { posts: grants(accept, 'post'), ungranted: accept } };

  it('short-circuits a race, so the fallback never runs for granted rows', async () => {
    const fallback = vi.fn(() => true);
    const schema = schemaWith({
      ...granting,
      Post: race(granted('post'), rule(fallback, { name: 'fallback' })),
    });
    const result = await run(schema, '{ posts { id title } }');
    expect(result.errors).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();

    // Rows that arrived another way fall through to it.
    const other = await run(schema, '{ ungranted { id } }');
    expect(other.errors).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('composes with or, chain, and, not and wrap', async () => {
    const schema = schemaWith({
      Query: {
        posts: wrap(
          rule(() => true, { name: 'gate' }),
          grants(accept, 'post'),
        ),
        ungranted: accept,
      },
      Post: {
        id: or(granted('post'), deny),
        title: chain(granted('post'), accept),
        body: and(granted('post'), accept),
        author: not(granted('post')),
      },
    });
    const result = await run(schema, '{ posts { id title body } }');
    expect(result.errors).toBeUndefined();
    const inverted = await run(schema, '{ posts { author { id } } }');
    expect(inverted.errors?.[0]?.message).toBe('Forbidden');
    expect(inverted.errors?.[0]?.path).toEqual(['posts', 0, 'author']);
  });

  it('is never checkable, so it is rejected as a combinator operand by name', () => {
    const granting = grants(accept, 'post');
    expect(isCheckableRule(granting)).toBe(false);
    expect(() => or(granted('post'), granting)).toThrow(/operand 1 .* `grants\(\.\.\.\)`/s);
  });

  it('tags only what a post-execution rule let through', async () => {
    type SubjectMap = { Post: Post };
    const typed = createTyped<SubjectMap>();
    const canUser = createCan<{ userId?: string }, SubjectMap>(
      async (ctx) => {
        const { can, build } = createGraphQLAbility<SubjectMap>();
        can(Actions.read, 'Post', { authorId: ctx.userId });
        return build();
      },
      (ctx) => ctx.userId != null,
      typed,
    );
    const schema = schemaWith({
      Query: { post: grants(canUser.onResult(Actions.read, 'Post'), 'post') },
      Post: granted('post'),
    });
    const allowed = await run(schema, '{ post { id } }', { userId: 'u1' });
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ post: { id: 'p1' } });

    const ctx = { userId: 'u2' };
    const denied = await run(schema, '{ post { id } }', ctx);
    expect(denied.errors?.[0]?.message).toBe('Forbidden');
    expect(denied.errors?.[0]?.path).toEqual(['post']);
    expect(granted('post').check(posts[0], null, ctx, info)).toBe(false);
  });

  it('forwards a wrapped rule′s scoping marker', () => {
    const marker = Symbol.for('graphql-casl.scopeInfo');
    const scoping: Rule = async (resolve, parent, args, context, info) =>
      resolve(parent, args, context, info);
    Object.defineProperty(scoping, marker, { value: { into: ['where'] } });
    expect((grants(scoping, 'x') as unknown as Record<symbol, unknown>)[marker]).toEqual({
      into: ['where'],
    });
    expect((grants(accept, 'x') as unknown as Record<symbol, unknown>)[marker]).toBeUndefined();
  });
});

describe('grants / granted — under onDeny', () => {
  const map: LooseMap = {
    Query: { post: grants(accept, 'post') },
    Post: granted('post'),
    User: granted('user'),
  };

  it("filters the ungranted field and reports it, under onDeny: 'filter'", async () => {
    const schema = schemaWith(map, { onDeny: 'filter' });
    const ctx = {};
    const result = reportDenials(ctx, await run(schema, '{ post { id author { email } } }', ctx));
    expect(result.data).toEqual({ post: { id: 'p1', author: { email: null } } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.path).toEqual(['post', 'author', 'email']);
    expect(result.errors?.[0]?.extensions).toEqual({ code: UNAUTHORIZED_FIELD_OR_TYPE });
  });

  it("masks the ungranted field silently, under onDeny: 'mask'", async () => {
    const schema = schemaWith(map, { onDeny: 'mask' });
    const result = await run(schema, '{ post { id author { email } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ post: { id: 'p1', author: { email: null } } });
  });

  it('is reworded by fallbackError like any generic denial', async () => {
    const schema = schemaWith(map, { fallbackError: 'Not Authorised!' });
    const result = await run(schema, '{ post { author { id } } }');
    expect(result.errors?.[0]?.message).toBe('Not Authorised!');
  });
});

describe('grants / granted — the synchronous path', () => {
  it('answers the granted check without a promise', () => {
    const ctx = {};
    const row = {};
    expect(granted('x').check(row, null, ctx, info)).toBe(false);
    expect(grants(accept, 'x')(syncResolve(row), null, null, ctx, info)).toBe(row);
    expect(granted('x').check(row, null, ctx, info)).toBe(true);
    expect(granted('y').check(row, null, ctx, info)).toBe(false);
  });

  it('denies for a parent that is not an object', () => {
    expect(granted('x').check(null, null, {}, info)).toBe(false);
    expect(granted('x').check('p', null, {}, info)).toBe(false);
  });

  it('hands back a synchronous result synchronously, and an async one after tagging', async () => {
    const ctx = {};
    const rows = [{}, {}];
    const granting = grants(accept, 'x');
    expect(granting(syncResolve(rows), null, null, ctx, info)).toBe(rows);
    for (const row of rows) expect(granted('x').check(row, null, ctx, info)).toBe(true);

    const later = [{}];
    const out = granting(async () => later, null, null, ctx, info);
    expect(out).toBeInstanceOf(Promise);
    expect(granted('x').check(later[0], null, ctx, info)).toBe(false);
    await expect(out).resolves.toBe(later);
    expect(granted('x').check(later[0], null, ctx, info)).toBe(true);
  });

  it('keeps the granted field synchronous through resolvePermissions′ error control', async () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { posts: grants(accept, 'post') }, '*': race(granted('post'), deny) },
      { onDeny: 'filter', report: 'extensions' },
    );
    const ctx = {};
    const rows = [{}];
    // The granting field is plain middleware, so error control wraps it the
    // generic (async) way — once per request, on the parent. That is the cost
    // the feature moves off the rows.
    const list = permissionFor('Query', 'posts');
    expect(await list?.(syncResolve(rows), null, null, ctx, info)).toBe(rows);
    // The granted field is a `rule()`, so error control asks its check
    // directly and the row resolves without a promise.
    const field = permissionFor('Post', 'id');
    expect(field?.(syncResolve('p1'), rows[0], null, ctx, info)).toBe('p1');
    // An ungranted row of a nullable field is filtered to null, synchronously.
    const nullable = permissionFor('User', 'email');
    expect(nullable?.(syncResolve('x'), {}, null, ctx, info)).toBeNull();
  });

  it('rejects, rather than throws, when the wrapped rule rejects', async () => {
    await expect(grants(deny, 'x')(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
  });
});

describe('grants / granted — validation', () => {
  it('rejects a non-rule and an empty or malformed scope at construction', () => {
    expect(() => grants('nope' as never, 'x')).toThrow(/expects a rule, got string/);
    expect(() => grants(accept, '')).toThrow(/needs a scope name/);
    expect(() => grants(accept, [])).toThrow(/needs a scope name/);
    expect(() => grants(accept, ['x', 1 as never])).toThrow(/needs a scope name/);
    expect(() => granted('')).toThrow(/needs a scope name/);
    expect(() => granted(1 as never)).toThrow(/needs a scope name/);
  });

  it('names the granted rule for combinator messages', () => {
    expect(granted('post').ruleName).toBe('granted(post)');
  });
});
