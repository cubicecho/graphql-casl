/**
 * End to end: build a schema carrying `@can` / `@rule`, translate it, enforce
 * the result with the runtime, and run queries as different callers.
 */

import { createTestkit } from '@envelop/testing';
import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  type Action,
  Actions,
  accept,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  PermissionsError,
  rule,
  wrap,
} from '@vantreeseba/graphql-casl';
import { useGraphQLCasl } from '@vantreeseba/graphql-casl/envelop';
import {
  buildSchema,
  type ExecutionResult,
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLSchema,
  graphql,
} from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DirectivePermissions,
  type DirectivePermissionsOptions,
  directiveTypeDefs,
  permissionsFromDirectives,
} from '../src/index.js';

// --- Domain -----------------------------------------------------------------

interface User {
  id: string;
  email: string;
}

interface Note {
  id: string;
  userId: string;
  body: string;
  secret: string;
}

type M = {
  User: User;
  Note: Note;
  Secret: { id: string };
  Thing: { id: string; name: string };
  Other: { id: string };
};

const USERS: readonly User[] = [
  { id: 'alice', email: 'alice@example.com' },
  { id: 'bob', email: 'bob@example.com' },
  { id: 'carol', email: 'carol@example.com' },
  { id: 'root', email: 'root@example.com' },
];

const SEED: readonly Note[] = [
  { id: 'n1', userId: 'alice', body: 'alice note', secret: 'shh' },
  { id: 'n2', userId: 'bob', body: 'bob note', secret: 'psst' },
];

let NOTES: Note[];
beforeEach(() => {
  NOTES = SEED.map((note) => ({ ...note }));
});

// --- Context, ability, rules ------------------------------------------------

interface Context {
  userId?: string;
  roles?: string[];
  verified?: boolean;
}

/** What each caller's ability grants — bare subjects, so `@can` is a possibility check. */
const GRANTS: Record<string, ReadonlyArray<[Action, keyof M]>> = {
  alice: [
    [Actions.read, 'User'],
    [Actions.read, 'Note'],
    [Actions.update, 'Note'],
    [Actions.read, 'Thing'],
  ],
  bob: [[Actions.read, 'Note']],
  carol: [[Actions.read, 'User']],
  root: [
    [Actions.read, 'User'],
    [Actions.read, 'Note'],
    [Actions.read, 'Secret'],
    [Actions.update, 'Note'],
    [Actions.read, 'Thing'],
    [Actions.read, 'Other'],
  ],
};

const typed = createTyped<M>();

const canUser = createCan<Context, M>(
  async (ctx) => {
    const { can, build } = createGraphQLAbility<M>();
    for (const [action, subject] of GRANTS[ctx.userId ?? ''] ?? []) can(action, subject);
    return build();
  },
  (ctx) => ctx.userId != null,
  typed,
);

const isAuthenticated = rule((_p, _a, ctx: Context) => ctx.userId != null || 'Not authenticated', {
  name: 'isAuthenticated',
});
const isAdmin = rule((_p, _a, ctx: Context) => ctx.roles?.includes('admin') || 'Admins only', {
  name: 'isAdmin',
});
const isVerified = rule((_p, _a, ctx: Context) => ctx.verified === true || 'Verify your email', {
  name: 'isVerified',
});
const isOwner = rule(
  (parent, _a, ctx: Context) => (parent as Note).userId === ctx.userId || 'Not your note',
  { name: 'isOwner' },
);
const isSelf = rule((parent, _a, ctx: Context) => (parent as User).id === ctx.userId || 'Not you', {
  name: 'isSelf',
});

const rules = { isAuthenticated, isAdmin, isVerified, isOwner, isSelf };

// Callers.
const guest: Context = {};
const alice: Context = { userId: 'alice', verified: true };
const aliceUnverified: Context = { userId: 'alice' };
const bob: Context = { userId: 'bob', verified: true };
const carol: Context = { userId: 'carol' };
const carolAdmin: Context = { userId: 'carol', roles: ['admin'], verified: true };
const root: Context = { userId: 'root', roles: ['admin'], verified: true };

// --- Schema -----------------------------------------------------------------

const typeDefs = /* GraphQL */ `
  type Query {
    me: User @can(action: "read")
    user(id: ID!): User @can(action: "read")
    notes: [Note!]!
    note(id: ID!): Note @can(action: "read") @rule(names: [["isAdmin"]])
    version: String
    secret: String @can(action: "read", subject: "Secret")
  }

  type Mutation {
    updateNote(id: ID!, body: String!): Note @can(action: "update")
    purge: Boolean @rule(names: [["isAdmin"]])
  }

  type User {
    id: ID!
    email: String @rule(names: [["isSelf"], ["isAdmin"]])
  }

  type Note @can(action: "read") {
    id: ID!
    userId: ID!
    body: String
    secret: String @rule(names: [["isOwner", "isVerified"], ["isAdmin"]])
  }
`;

const resolvers = {
  Query: {
    me: (_p: unknown, _a: unknown, ctx: Context) => USERS.find((u) => u.id === ctx.userId) ?? null,
    user: (_p: unknown, args: { id: string }) => USERS.find((u) => u.id === args.id) ?? null,
    notes: () => NOTES,
    note: (_p: unknown, args: { id: string }) => NOTES.find((n) => n.id === args.id) ?? null,
    version: () => '1.0',
    secret: () => 'top secret',
  },
  Mutation: {
    updateNote: (_p: unknown, args: { id: string; body: string }) => {
      const note = NOTES.find((n) => n.id === args.id);
      if (!note) return null;
      note.body = args.body;
      return note;
    },
    purge: () => true,
  },
};

type Resolvers = Record<string, Record<string, unknown>>;

function build(sdl: string, withResolvers: Resolvers = {}): GraphQLSchema {
  return makeExecutableSchema({ typeDefs: [directiveTypeDefs, sdl], resolvers: withResolvers });
}

/** Translates, applies, and returns an executor for the guarded schema. */
function guard(sdl: string, withResolvers: Resolvers = {}) {
  const schema = build(sdl, withResolvers);
  const permissions = permissionsFromDirectives(schema, { can: canUser, rules });
  return runner(applyPermissions(schema, permissions));
}

function runner(schema: GraphQLSchema) {
  return (source: string, contextValue: Context = guest) =>
    graphql({ schema, source, contextValue }) as Promise<ExecutionResult>;
}

function messagesOf(result: ExecutionResult): string[] {
  return (result.errors ?? []).map((e) => e.message);
}

/** The aggregated problems a translation fails with. */
function problemsOf(
  sdl: string,
  options: DirectivePermissionsOptions = { can: canUser, rules },
): readonly string[] {
  try {
    permissionsFromDirectives(build(sdl, {}), options);
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionsError);
    return (error as PermissionsError).problems;
  }
  throw new Error('expected the translation to fail');
}

// --- Tests ------------------------------------------------------------------

describe('permissionsFromDirectives', () => {
  const schema = build(typeDefs, resolvers);
  const map = permissionsFromDirectives(schema, { can: canUser, rules });

  it('keys the map by the schema types and fields that carry directives', () => {
    expect(Object.keys(map).sort()).toEqual(['Mutation', 'Note', 'Query', 'User']);
    expect(Object.keys(map.Query as object).sort()).toEqual(['me', 'note', 'secret', 'user']);
    expect(Object.keys(map.Mutation as object).sort()).toEqual(['purge', 'updateNote']);
    expect(Object.keys(map.User as object)).toEqual(['email']);
    for (const entry of Object.values(map)) {
      for (const value of Object.values(entry as object)) expect(typeof value).toBe('function');
    }
  });

  it('turns a type-level directive into the wildcard entry, ANDed into fields with their own', () => {
    const note = map.Note as Record<string, unknown>;
    expect(Object.keys(note).sort()).toEqual(['*', 'secret']);
    expect(note.secret).not.toBe(note['*']);
  });

  it('skips introspection types', () => {
    expect(Object.keys(map).some((key) => key.startsWith('__'))).toBe(false);
  });

  it('is empty for a schema that uses neither directive', () => {
    expect(permissionsFromDirectives(build('type Query { ok: Boolean }'), {})).toEqual({});
  });

  it('is empty for a schema that does not even define the directives', () => {
    expect(permissionsFromDirectives(buildSchema('type Query { ok: Boolean }'), {})).toEqual({});
  });

  it('is empty for a schema without AST nodes', () => {
    // A schema assembled programmatically has nothing to read. Round-tripping
    // through `buildSchema(printSchema(...))` would restore the nodes.
    const bare = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: { ok: { type: GraphQLBoolean } } }),
    });
    expect(permissionsFromDirectives(bare, { can: canUser, rules })).toEqual({});
  });

  it('passes the runtime validation as-is', () => {
    expect(() => applyPermissions(schema, map)).not.toThrow();
  });

  it('accepts a typed createCan builder without a cast', () => {
    // Compile-time check: `canUser` is a `RequireCan<M>`, and the option is
    // typed against the bare form. Nothing to assert at runtime.
    const typedMap: DirectivePermissions = permissionsFromDirectives(schema, {
      can: canUser,
      rules,
    });
    expect(typedMap.Note).toBeDefined();
  });
});

describe('enforcement through applyPermissions', () => {
  const run = guard(typeDefs, resolvers);

  describe('@can on a root field infers the subject from the return type', () => {
    it('allows a caller whose ability grants it', async () => {
      const result = await run('{ me { id } }', alice);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ me: { id: 'alice' } });
    });

    it('denies a caller whose ability does not', async () => {
      const result = await run('{ me { id } }', bob);
      expect(messagesOf(result)).toEqual(['Forbidden']);
      expect(result.data).toEqual({ me: null });
    });

    it('denies an anonymous caller before the ability is built', async () => {
      const result = await run('{ me { id } }', guest);
      expect(messagesOf(result)).toEqual(['Not authenticated']);
    });

    it('unwraps lists and non-nulls (`[Note!]!` reads Note)', async () => {
      const result = await run('mutation { updateNote(id: "n1", body: "edited") { body } }', alice);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ updateNote: { body: 'edited' } });

      const denied = await run('mutation { updateNote(id: "n1", body: "x") { body } }', bob);
      expect(messagesOf(denied)).toEqual(['Forbidden']);
      expect(NOTES[0]?.body).toBe('edited');
    });
  });

  describe('@can with an explicit subject', () => {
    it('checks the named subject rather than the return type', async () => {
      expect(messagesOf(await run('{ secret }', alice))).toEqual(['Forbidden']);
      expect((await run('{ secret }', root)).data).toEqual({ secret: 'top secret' });
    });
  });

  describe('@can on an object type guards every field of it', () => {
    it('denies each selected field for a caller who cannot read the type', async () => {
      // Nullable fields, so every denial is reported rather than the first one
      // nulling the parent through a non-null chain.
      const result = await run('{ notes { body secret } }', carol);
      const paths = (result.errors ?? []).map((e) => (e.path ?? []).join('.')).sort();
      expect(paths).toEqual(['notes.0.body', 'notes.0.secret', 'notes.1.body', 'notes.1.secret']);
      expect(messagesOf(result)).toEqual(['Forbidden', 'Forbidden', 'Forbidden', 'Forbidden']);
      expect(result.data).toEqual({
        notes: [
          { body: null, secret: null },
          { body: null, secret: null },
        ],
      });
    });

    it('nulls the parent when a denied field is non-null', async () => {
      const result = await run('{ notes { id } }', carol);
      expect(result.errors?.map((e) => e.path)).toEqual([['notes', 0, 'id']]);
      expect(result.data).toBeNull();
    });

    it('allows the fields for a caller who can', async () => {
      const result = await run('{ notes { id body } }', bob);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        notes: [
          { id: 'n1', body: 'alice note' },
          { id: 'n2', body: 'bob note' },
        ],
      });
    });

    it('leaves a field without any directive unguarded', async () => {
      expect((await run('{ version }', guest)).data).toEqual({ version: '1.0' });
    });
  });

  describe('@rule nests AND inside OR', () => {
    const query = '{ notes { id secret } }';

    it('passes when every rule of one inner list passes', async () => {
      const result = await run(query, alice);
      expect(result.errors?.map((e) => e.path)).toEqual([['notes', 1, 'secret']]);
      expect(result.data).toEqual({
        notes: [
          { id: 'n1', secret: 'shh' },
          { id: 'n2', secret: null },
        ],
      });
    });

    it('fails an inner list when one of its rules fails', async () => {
      // Owner but not verified: (isOwner AND isVerified) is false, isAdmin is false.
      const result = await run(query, aliceUnverified);
      expect(result.errors?.map((e) => e.path)).toEqual([
        ['notes', 0, 'secret'],
        ['notes', 1, 'secret'],
      ]);
    });

    it('passes when any other inner list passes', async () => {
      // Not the owner of either note, but an admin.
      const result = await run(query, root);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        notes: [
          { id: 'n1', secret: 'shh' },
          { id: 'n2', secret: 'psst' },
        ],
      });
    });

    it('reports the last alternative’s denial, as `or` does', async () => {
      const result = await run('{ user(id: "bob") { email } }', alice);
      expect(messagesOf(result)).toEqual(['Admins only']);
      expect((await run('{ user(id: "bob") { email } }', root)).errors).toBeUndefined();
      expect((await run('{ me { email } }', alice)).data).toEqual({
        me: { email: 'alice@example.com' },
      });
    });

    it('works alone on a root field', async () => {
      expect(messagesOf(await run('mutation { purge }', alice))).toEqual(['Admins only']);
      expect((await run('mutation { purge }', root)).data).toEqual({ purge: true });
    });
  });

  describe('several directives compose with AND', () => {
    it('requires both directives on one field', async () => {
      // `note` carries @can(read) and @rule([["isAdmin"]]).
      expect(messagesOf(await run('{ note(id: "n1") { id } }', alice))).toEqual(['Admins only']);
      expect(messagesOf(await run('{ note(id: "n1") { id } }', carolAdmin))).toEqual(['Forbidden']);
      expect((await run('{ note(id: "n1") { id } }', root)).data).toEqual({ note: { id: 'n1' } });
    });

    it('requires the type-level directive on a field that has its own', async () => {
      // Note carries @can(read); Note.secret carries @rule. An admin who cannot
      // read Note is still denied `secret`, by the type's rule.
      const result = await run('{ notes { secret } }', carolAdmin);
      expect(messagesOf(result)).toEqual(['Forbidden', 'Forbidden']);
    });
  });
});

describe('interfaces', () => {
  const sdl = /* GraphQL */ `
    interface Node @rule(names: [["isAuthenticated"]]) {
      id: ID! @rule(names: [["isAdmin"]])
    }
    type Thing implements Node {
      id: ID!
      name: String @can(action: "read")
    }
    type Other implements Node {
      id: ID!
    }
    type Query {
      thing: Thing
      other: Other
    }
  `;
  const thingResolvers = {
    Query: {
      thing: () => ({ id: 't1', name: 'thing' }),
      other: () => ({ id: 'o1' }),
    },
  };
  const schema = build(sdl, thingResolvers);
  const map = permissionsFromDirectives(schema, { can: canUser, rules });

  it('projects interface directives onto every implementing type, never onto the interface', () => {
    expect(Object.keys(map).sort()).toEqual(['Other', 'Thing']);
    expect(Object.keys(map.Thing as object).sort()).toEqual(['*', 'id', 'name']);
    expect(Object.keys(map.Other as object).sort()).toEqual(['*', 'id']);
    expect(() => applyPermissions(schema, map)).not.toThrow();
  });

  it('enforces them on the concrete type, ANDed with its own', async () => {
    const run = runner(applyPermissions(schema, map));
    expect(messagesOf(await run('{ thing { name } }', guest))).toEqual(['Not authenticated']);
    expect(messagesOf(await run('{ thing { id } }', alice))).toEqual(['Admins only']);
    expect((await run('{ thing { name } }', alice)).data).toEqual({ thing: { name: 'thing' } });
    // `name` needs read Thing (its own @can) and the interface's isAuthenticated.
    expect(messagesOf(await run('{ thing { name } }', bob))).toEqual(['Forbidden']);
    expect((await run('{ other { id } }', root)).data).toEqual({ other: { id: 'o1' } });
  });

  it('infers the subject of an interface field from the interface', () => {
    const iface = build(
      /* GraphQL */ `
        interface Node { id: ID! @can(action: "read") }
        type Thing implements Node { id: ID! }
        type Query { thing: Thing }
      `,
      {},
    );
    const seen: string[] = [];
    const spyCan = ((action: string, subject: string) => {
      seen.push(`${action}:${subject}`);
      return accept;
    }) as never;
    permissionsFromDirectives(iface, { can: spyCan });
    expect(seen).toEqual(['read:Node']);
  });
});

describe('extend type', () => {
  it('reads directives from extension nodes and their fields', () => {
    const schema = build(
      /* GraphQL */ `
        type Query { version: String }
        type Note { id: ID! }
        extend type Note @rule(names: [["isAuthenticated"]])
        extend type Query { extra: String @rule(names: [["isAdmin"]]) }
      `,
      {},
    );
    const map = permissionsFromDirectives(schema, { rules });
    expect(Object.keys(map.Note as object)).toEqual(['*']);
    expect(Object.keys(map.Query as object)).toEqual(['extra']);
  });
});

describe('a root type with a type-level directive', () => {
  it('guards every root field with @rule', async () => {
    const run = guard('type Query @rule(names: [["isAuthenticated"]]) { version: String }', {
      Query: { version: () => '1.0' },
    });
    expect(messagesOf(await run('{ version }', guest))).toEqual(['Not authenticated']);
    expect((await run('{ version }', alice)).data).toEqual({ version: '1.0' });
  });

  it('accepts @can with an explicit subject', () => {
    const schema = build('type Query @can(action: "read", subject: "Secret") { version: String }');
    const map = permissionsFromDirectives(schema, { can: canUser });
    expect(Object.keys(map.Query as object)).toEqual(['*']);
  });

  it('rejects @can without one', () => {
    expect(problemsOf('type Query @can(action: "read") { version: String }')).toEqual([
      '`@can` on the root type `Query` needs an explicit `subject`: its fields return different types, so there is nothing to infer.',
    ]);
  });
});

describe('validation', () => {
  it('rejects a rule name the registry lacks', () => {
    expect(problemsOf('type Query { a: String @rule(names: [["nope"]]) }')).toEqual([
      '`@rule` on `Query.a` names `nope`, which is not in the rules registry.',
    ]);
  });

  it('rejects a registry entry that is not a checkable rule', () => {
    const problems = problemsOf('type Query { a: String @rule(names: [["audit"]]) }', {
      can: canUser,
      rules: { ...rules, audit: wrap(accept) as never },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      '`@rule` on `Query.a` names `audit`, which is not a checkable rule.',
    );
  });

  it('rejects @can on a root field whose subject cannot be inferred', () => {
    expect(
      problemsOf(/* GraphQL */ `
        enum Role { ADMIN }
        type Query { a: String @can(action: "read"), b: [Role!] @can(action: "read") }
      `),
    ).toEqual([
      '`@can` on root field `Query.a` has no `subject` and none can be inferred: the field returns the scalar `String`. Name it, e.g. `@can(action: "read", subject: "...")`.',
      '`@can` on root field `Query.b` has no `subject` and none can be inferred: the field returns the enum `Role`. Name it, e.g. `@can(action: "read", subject: "...")`.',
    ]);
  });

  it('rejects an empty `names`', () => {
    expect(problemsOf('type Query { a: String @rule(names: []) }')).toEqual([
      '`@rule` on `Query.a` has a malformed `names`: expected a non-empty list of non-empty lists of rule names, e.g. `[["isAuthenticated", "isOwner"], ["isAdmin"]]`.',
    ]);
  });

  it('rejects an empty inner list', () => {
    expect(problemsOf('type Query { a: String @rule(names: [["isAdmin"], []]) }')).toHaveLength(1);
  });

  it('rejects a `names` of the wrong shape under a consumer-defined directive', () => {
    // The consumer defined `@rule` themselves, with a flat list. The SDL is
    // valid, so the shape check is the only thing standing between that and a
    // rule that silently never applies.
    const schema = buildSchema(/* GraphQL */ `
      directive @rule(names: [String!]!) on FIELD_DEFINITION
      type Query { a: String @rule(names: ["isAdmin"]) }
    `);
    expect(() => permissionsFromDirectives(schema, { rules })).toThrow(/malformed `names`/);
  });

  it('rejects an action the runtime does not know, and an empty subject', () => {
    expect(
      problemsOf(
        'type Query { a: String @can(action: "publish", subject: "S"), b: String @can(action: "read", subject: "") }',
      ),
    ).toEqual([
      '`@can` on `Query.a` has an unknown `action` "publish"; expected one of "create", "read", "update", "delete", "manage".',
      '`@can` on `Query.b` has a `subject` that is not a non-empty string.',
    ]);
  });

  it('rejects @can when no builder was given', () => {
    expect(problemsOf('type Query { a: String @can(action: "read", subject: "S") }', {})).toEqual([
      '`@can` on `Query.a` has no `createCan` builder to call: pass `can` to `permissionsFromDirectives`.',
    ]);
  });

  it('rejects @rule when no registry was given', () => {
    expect(problemsOf('type Query { a: String @rule(names: [["isAdmin"]]) }', {})).toEqual([
      '`@rule` on `Query.a` has no registry to resolve against: pass `rules` to `permissionsFromDirectives`.',
    ]);
  });

  it('aggregates every problem into one PermissionsError', () => {
    let caught: unknown;
    try {
      permissionsFromDirectives(
        build('type Query { a: String @can(action: "read"), b: String @rule(names: [["x"]]) }', {}),
        { can: canUser, rules },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionsError);
    const error = caught as PermissionsError;
    expect(error.problems).toHaveLength(2);
    expect(error.message).toMatch(
      /^graphql-casl: the schema directives could not be translated\.\n {2}- /,
    );
  });

  it('reports an interface problem once, not once per implementor', () => {
    expect(
      problemsOf(/* GraphQL */ `
        interface Node @rule(names: [["nope"]]) { id: ID! }
        type A implements Node { id: ID! }
        type B implements Node { id: ID! }
        type Query { a: A, b: B }
      `),
    ).toEqual(['`@rule` on `Node` names `nope`, which is not in the rules registry.']);
  });

  it('leaves @can on a union to the SDL validator', () => {
    expect(() =>
      buildSchema(`${directiveTypeDefs}
        type A { id: ID! }
        type B { id: ID! }
        union AB @can(action: "read") = A | B
        type Query { ab: AB }
      `),
    ).toThrow('Directive "@can" may not be used on UNION.');
  });
});

describe('composing with a hand-written map', () => {
  const schema = build(typeDefs, resolvers);
  const fromDirectives = permissionsFromDirectives(schema, { can: canUser, rules });

  it('spreads per field when the type entries are spread too', async () => {
    const run = runner(
      applyPermissions(schema, {
        ...fromDirectives,
        Query: { ...fromDirectives.Query, version: deny },
      }),
    );
    expect(messagesOf(await run('{ version }', root))).toEqual(['Forbidden']);
    // Everything else the directives declared still applies.
    expect(messagesOf(await run('{ me { id } }', bob))).toEqual(['Forbidden']);
  });

  it('replaces a whole type entry when only the top level is spread', async () => {
    // Object spread is shallow: this `Note` entry drops the directive's `'*'`.
    const merged = { ...fromDirectives, Note: { body: accept } };
    expect((merged.Note as Record<string, unknown>)['*']).toBeUndefined();
    const run = runner(applyPermissions(schema, merged));
    expect((await run('{ notes { id } }', carol)).errors).toBeUndefined();
  });
});

describe('through envelop', () => {
  it('enforces the same map with useGraphQLCasl', async () => {
    const schema = build(typeDefs, resolvers);
    const permissions = permissionsFromDirectives(schema, { can: canUser, rules });
    const testkit = createTestkit([useGraphQLCasl({ permissions })], schema);

    const allowed = (await testkit.execute('{ me { id } }', {}, alice)) as ExecutionResult;
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ me: { id: 'alice' } });

    const denied = (await testkit.execute('{ me { id } }', {}, bob)) as ExecutionResult;
    expect(messagesOf(denied)).toEqual(['Forbidden']);
  });
});
