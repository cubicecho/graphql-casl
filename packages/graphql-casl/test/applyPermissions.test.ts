import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  type ExecutionResult,
  GraphQLError,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  graphql,
  parse,
  subscribe,
} from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnyResolvers,
  type ApplyPermissionsOptions,
  accept,
  and,
  applyPermissions,
  type CacheMode,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  PermissionsError,
  type PermissionsMap,
  type Rule,
  reportDenials,
  resolvePermissions,
  rule,
  UNAUTHORIZED_FIELD_OR_TYPE,
  validatePermissions,
  wrap,
} from '../src/index.js';
import { SCOPE_INFO } from '../src/internal.js';

const typeDefs = /* GraphQL */ `
  interface Node {
    id: ID!
  }
  type Note implements Node {
    id: ID!
    body: String!
  }
  union Thing = Note
  enum Colour {
    RED
  }
  type Query {
    note: Note!
    notes: [Note!]!
    thing: Thing!
  }
`;

const note = { id: '1', body: 'hello' };

function baseSchema(): GraphQLSchema {
  return makeExecutableSchema({
    typeDefs,
    resolvers: {
      Node: { __resolveType: () => 'Note' },
      Thing: { __resolveType: () => 'Note' },
      Query: { note: () => note, notes: () => [note], thing: () => note },
    },
  });
}

// The walk is schema-driven, so these tests deliberately use a loose map type
// rather than a generated `Resolvers` — that is exactly the case compile-time
// keys cannot cover.
type LooseMap = PermissionsMap<Record<string, Record<string, unknown>>>;

function apply(permissions: LooseMap): GraphQLSchema {
  return applyPermissions(baseSchema(), permissions);
}

describe('applyPermissions — enforcement', () => {
  it('applies a field rule and leaves unnamed fields alone', async () => {
    const schema = apply({ Query: { note: deny } });
    const denied = await graphql({ schema, source: '{ note { id } }' });
    expect(denied.errors?.[0]?.message).toBe('Forbidden');

    const allowed = await graphql({ schema, source: '{ notes { id } }' });
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ notes: [{ id: '1' }] });
  });

  it('expands a type-level rule across every field of the type', async () => {
    const seen: string[] = [];
    const spy: Rule = (resolve, parent, args, context, info) => {
      seen.push(info.fieldName);
      return resolve(parent, args, context, info);
    };
    const schema = apply({ Note: spy });
    const result = await graphql({ schema, source: '{ note { id body } }' });

    expect(result.errors).toBeUndefined();
    expect(seen.sort()).toEqual(['body', 'id']);
  });

  it('leaves introspection working', async () => {
    const schema = apply({ Query: accept });
    const result = await graphql({ schema, source: '{ __schema { types { name } } }' });
    expect(result.errors).toBeUndefined();
  });

  it('ignores an explicitly-undefined field entry', async () => {
    const schema = apply({ Query: { note: undefined, notes: deny } });
    const result = await graphql({ schema, source: '{ note { id } }' });
    expect(result.errors).toBeUndefined();
  });

  it('rules still receive the full resolver arguments', async () => {
    const spy = vi.fn<Rule>((resolve, parent, args, context, info) =>
      resolve(parent, args, context, info),
    );
    const schema = apply({ Query: { note: spy } });
    await graphql({ schema, source: '{ note { id } }', contextValue: { userId: 'u1' } });

    expect(spy).toHaveBeenCalledOnce();
    const [, , , context, info] = spy.mock.calls[0] ?? [];
    expect(context).toEqual({ userId: 'u1' });
    expect(info?.fieldName).toBe('note');
  });
});

describe('applyPermissions — schema validation', () => {
  function problemsOf(permissions: LooseMap): string[] {
    try {
      apply(permissions);
    } catch (error) {
      if (error instanceof PermissionsError) return [...error.problems];
      throw error;
    }
    throw new Error('expected applyPermissions to throw');
  }

  it('rejects a type that is not in the schema', () => {
    expect(problemsOf({ Ghost: { id: deny } })).toEqual([
      'Type `Ghost` is in the permissions map but not in the schema.',
    ]);
  });

  it('rejects a field that is not on the type', () => {
    expect(problemsOf({ Note: { nope: deny } })).toEqual([
      'Field `Note.nope` is in the permissions map but not in the schema.',
    ]);
  });

  it('rejects a field the interface does not declare', () => {
    // `body` exists on Note, but Node does not declare it; the entry is on Node.
    expect(problemsOf({ Node: { body: deny } })).toEqual([
      'Field `Node.body` is in the permissions map but interface `Node` does not declare it.',
    ]);
  });

  it('rejects a named field on a union instead of crashing inside graphql-middleware', () => {
    // graphql-middleware itself throws `type.getFields is not a function` here.
    expect(problemsOf({ Thing: { id: deny } })).toEqual([
      "Field `Thing.id` is in the permissions map but `Thing` is a union type, which declares no fields — only `'*'` can be attached to a union.",
    ]);
  });

  it('rejects a non-object type', () => {
    expect(problemsOf({ Colour: { RED: deny } })).toEqual([
      '`Colour` is an enum type, not an object type.',
    ]);
  });

  it('rejects an introspection type', () => {
    expect(problemsOf({ __Schema: { types: deny } })).toEqual([
      '`__Schema` is an introspection type and cannot be guarded.',
    ]);
  });

  it('rejects a rule that is not a function', () => {
    expect(problemsOf({ Query: { note: 'nope' as unknown as Rule } })).toEqual([
      'Rule for `Query.note` is string, not a function.',
    ]);
  });

  it('reports every problem at once rather than failing on the first', () => {
    const problems = problemsOf({
      Ghost: deny,
      Note: { nope: deny, alsoNope: deny },
      Query: { note: 42 as unknown as Rule },
    });
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/Ghost[\s\S]*nope[\s\S]*alsoNope[\s\S]*Query\.note/);
  });

  it("puts every problem in the error's message too", () => {
    let message = '';
    try {
      apply({ Ghost: deny });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('the permissions map does not match the schema');
    expect(message).toContain('- Type `Ghost` is in the permissions map but not in the schema.');
  });

  it('is a named Error subclass', () => {
    const error = new PermissionsError(['boom']);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PermissionsError');
    expect(error.problems).toEqual(['boom']);
  });
});

describe('applyPermissions — fallbackRule', () => {
  it('guards fields the map does not name', async () => {
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      baseSchema(),
      { Query: { note: accept } },
      { fallbackRule: deny },
    );
    await expect(
      graphql({ schema, source: '{ note { id } }' }).then((r) => r.errors?.[0]?.message),
    ).resolves.toBe('Forbidden');
    const denied = await graphql({ schema, source: '{ notes { id } }' });
    expect(denied.errors?.[0]?.message).toBe('Forbidden');
  });

  it('is overridden by every map entry, including a wildcard', async () => {
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      baseSchema(),
      { Query: accept, Note: { '*': accept } },
      { fallbackRule: deny },
    );
    const result = await graphql({ schema, source: '{ note { id body } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ note: { id: '1', body: 'hello' } });
  });

  it('leaves introspection working even when it denies everything', async () => {
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      baseSchema(),
      {},
      { fallbackRule: deny },
    );
    const introspection = await graphql({ schema, source: '{ __schema { types { name } } }' });
    expect(introspection.errors).toBeUndefined();

    const data = await graphql({ schema, source: '{ note { id } }' });
    expect(data.errors?.[0]?.message).toBe('Forbidden');
  });
});

describe('applyPermissions — wildcard precedence', () => {
  // Each case pins one row of the precedence table in `PermissionsMap`'s docs.
  // Rules record `Type.field` alongside their own name, because a query resolves
  // several fields and each is guarded independently.
  // A spec names each rule with a string, so the assertions can say which entry
  // won; `guards` turns it into a real map of recording rules.
  type SpecMap = Record<string, string | Record<string, string>>;

  async function guards(spec: SpecMap, source = '{ note { id } }'): Promise<string[]> {
    const marks: string[] = [];
    const mark =
      (name: string): Rule =>
      (resolve, parent, args, context, info) => {
        marks.push(`${info.parentType.name}.${info.fieldName}=${name}`);
        return resolve(parent, args, context, info);
      };
    const built: LooseMap = {};
    for (const [typeName, entry] of Object.entries(spec)) {
      built[typeName] =
        typeof entry === 'string'
          ? mark(entry)
          : Object.fromEntries(Object.entries(entry).map(([f, n]) => [f, mark(n)]));
    }
    await graphql({ schema: apply(built), source });
    return marks;
  }

  /** Which rule guarded `Note.id`, ignoring the other fields the query resolves. */
  async function guardOf(spec: SpecMap): Promise<string | undefined> {
    const marks = await guards(spec);
    return marks.find((m) => m.startsWith('Note.id='))?.split('=')[1];
  }

  it('a named field of a named type beats everything', async () => {
    expect(
      await guardOf({
        Note: { id: 'type.field', '*': 'type.*' },
        '*': { id: '*.field', '*': '*.*' },
      }),
    ).toBe('type.field');
  });

  it('any field of a named type beats the wildcard type', async () => {
    expect(await guardOf({ Note: { '*': 'type.*' }, '*': { id: '*.field', '*': '*.*' } })).toBe(
      'type.*',
    );
  });

  it('a type-level rule is shorthand for the type wildcard', async () => {
    expect(await guardOf({ Note: 'type.*', '*': { id: '*.field' } })).toBe('type.*');
  });

  it('a named field of any type beats the all-fields wildcard', async () => {
    expect(await guardOf({ '*': { id: '*.field', '*': '*.*' } })).toBe('*.field');
  });

  it('falls through to the all-fields wildcard', async () => {
    expect(await guardOf({ '*': { '*': '*.*' } })).toBe('*.*');
  });

  it('accepts a bare rule under the wildcard type as the all-fields default', async () => {
    expect(await guardOf({ '*': '*.*' })).toBe('*.*');
  });

  it('applies exactly one rule per field — wildcards never compose', async () => {
    const marks = await guards(
      { Note: { '*': 'type.*' }, '*': { '*': '*.*' } },
      '{ note { id body } }',
    );
    // Three fields resolve, each guarded exactly once, each by its most specific
    // entry: Query.note has no Note entry so it falls to the wildcard.
    expect(marks.sort()).toEqual(['Note.body=type.*', 'Note.id=type.*', 'Query.note=*.*']);
  });

  it('rejects a wildcard field name that matches nothing in the schema', () => {
    expect(() => apply({ '*': { nope: deny } })).toThrow(
      /no type in the schema has a field named `nope`/,
    );
  });

  it('accepts a wildcard field name that exists on some other type', () => {
    expect(() => apply({ '*': { body: deny } })).not.toThrow();
  });
});

describe('applyPermissions — rules on interfaces and unions', () => {
  // Node is implemented directly (Note) and through a chain of interfaces that
  // meet again (Post: Article implements Entity & Node, Entity implements
  // Node), so the transitive walk has a diamond to survive. Note also
  // implements Searchable, which is what makes ambiguity possible.
  const abstractSchema = (): GraphQLSchema =>
    makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        interface Node { id: ID! }
        interface Searchable { id: ID! title: String! }
        interface Entity implements Node { id: ID! }
        interface Article implements Entity & Node { id: ID! }
        type Note implements Node & Searchable { id: ID! title: String! body: String! }
        type Post implements Article & Entity & Node { id: ID! body: String! }
        union Thing = Note | Post
        type Query { note: Note! post: Post! thing: Thing! }
      `,
      resolvers: {
        Node: { __resolveType: (v: { title?: string }) => (v.title ? 'Note' : 'Post') },
        Searchable: { __resolveType: () => 'Note' },
        Entity: { __resolveType: () => 'Post' },
        Article: { __resolveType: () => 'Post' },
        Thing: { __resolveType: (v: { title?: string }) => (v.title ? 'Note' : 'Post') },
        Query: {
          note: () => ({ id: 'n1', title: 'hi', body: 'note' }),
          post: () => ({ id: 'p1', body: 'post' }),
          thing: () => ({ id: 'n1', title: 'hi', body: 'note' }),
        },
      },
    });

  type SpecMap = Record<string, string | Record<string, string>>;

  /** Applies a spec of named recording rules and returns `Type.field=name` per guarded field. */
  async function guards(spec: SpecMap, source: string): Promise<string[]> {
    const marks: string[] = [];
    const mark =
      (name: string): Rule =>
      (resolve, parent, args, context, info) => {
        marks.push(`${info.parentType.name}.${info.fieldName}=${name}`);
        return resolve(parent, args, context, info);
      };
    const built: LooseMap = {};
    for (const [typeName, entry] of Object.entries(spec)) {
      built[typeName] =
        typeof entry === 'string'
          ? mark(entry)
          : Object.fromEntries(Object.entries(entry).map(([f, n]) => [f, mark(n)]));
    }
    const result = await graphql({ schema: applyPermissions(abstractSchema(), built), source });
    expect(result.errors).toBeUndefined();
    return marks.sort();
  }

  function problemsOf(permissions: LooseMap): string[] {
    try {
      validatePermissions(abstractSchema(), permissions);
    } catch (error) {
      if (error instanceof PermissionsError) return [...error.problems];
      throw error;
    }
    return [];
  }

  it('guards a field on every type implementing the interface', async () => {
    expect(await guards({ Node: { id: 'iface.field' } }, '{ note { id } post { id } }')).toEqual([
      'Note.id=iface.field',
      'Post.id=iface.field',
    ]);
  });

  it('reaches an implementor through interfaces that implement the interface', () => {
    // Post implements Node only by way of Article and Entity in spirit; the
    // schema lists all three, as GraphQL requires, and the walk visits each once.
    const permissionFor = resolvePermissions(abstractSchema(), { Node: { id: deny } });
    expect(permissionFor('Post', 'id')).toBeDefined();
    expect(permissionFor('Post', 'body')).toBeUndefined();
    // An abstract type is never a field's parent at runtime, so it has no guard of its own.
    expect(permissionFor('Node', 'id')).toBeUndefined();
  });

  it('a bare interface rule covers every field of its implementors, declared on the interface or not', async () => {
    expect(await guards({ Node: 'iface.*' }, '{ note { id body } }')).toEqual([
      'Note.body=iface.*',
      'Note.id=iface.*',
    ]);
  });

  it("the implementor's own field entry beats the interface's", async () => {
    expect(
      await guards({ Note: { id: 'type.field' }, Node: { id: 'iface.field' } }, '{ note { id } }'),
    ).toEqual(['Note.id=type.field']);
  });

  it("an interface's field entry beats the implementor's wildcard", async () => {
    expect(
      await guards(
        { Note: { '*': 'type.*' }, Node: { id: 'iface.field' } },
        '{ note { id body } }',
      ),
    ).toEqual(['Note.body=type.*', 'Note.id=iface.field']);
  });

  it("the implementor's wildcard beats the interface's", async () => {
    expect(await guards({ Note: 'type.*', Node: 'iface.*' }, '{ note { id } }')).toEqual([
      'Note.id=type.*',
    ]);
  });

  it("the interface's wildcard beats the wildcard type", async () => {
    expect(
      await guards({ Node: 'iface.*', '*': { id: '*.field', '*': '*.*' } }, '{ note { id } }'),
    ).toEqual(['Note.id=iface.*', 'Query.note=*.*']);
  });

  it('sits above fallbackRule', async () => {
    const marks: string[] = [];
    const fallback: Rule = (resolve, parent, args, context, info) => {
      marks.push(`${info.parentType.name}.${info.fieldName}=fallback`);
      return resolve(parent, args, context, info);
    };
    const schema = applyPermissions(
      abstractSchema(),
      { Node: { id: accept } },
      {
        fallbackRule: fallback,
      },
    );
    await graphql({ schema, source: '{ note { id body } }' });
    expect(marks.sort()).toEqual(['Note.body=fallback', 'Query.note=fallback']);
  });

  it("a union's wildcard guards every member's fields, however the member is reached", async () => {
    expect(
      await guards({ Thing: 'union.*' }, '{ note { id } thing { ... on Note { body } } }'),
    ).toEqual(['Note.body=union.*', 'Note.id=union.*']);
  });

  it('a union entry sits at the interface-wildcard tier', async () => {
    expect(
      await guards(
        { Thing: { '*': 'union.*' }, Node: { id: 'iface.field' } },
        '{ note { id body } }',
      ),
    ).toEqual(['Note.body=union.*', 'Note.id=iface.field']);
    expect(await guards({ Thing: 'union.*', Note: 'type.*' }, '{ note { id } }')).toEqual([
      'Note.id=type.*',
    ]);
  });

  it('works under inPlace', async () => {
    const schema = applyPermissions(abstractSchema(), { Node: { id: deny } }, { inPlace: true });
    const result = await graphql({ schema, source: '{ post { id } }' });
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.path).toEqual(['post', 'id']);
  });

  it('accepts interface and union entries in validatePermissions', () => {
    expect(
      problemsOf({ Node: { id: deny, '*': accept }, Searchable: { title: deny }, Thing: accept }),
    ).toEqual([]);
  });

  it('rejects a field two interfaces both cover, until the implementor chooses', () => {
    expect(problemsOf({ Node: { id: deny }, Searchable: { id: accept } })).toEqual([
      'Field `Note.id` gets a rule from `Node` and `Searchable`, and `Note` does not say which applies — add `Note: { id: … }` to choose.',
    ]);
    expect(
      problemsOf({ Node: { id: deny }, Searchable: { id: accept }, Note: { id: accept } }),
    ).toEqual([]);
  });

  it('accepts the same rule reached through two interfaces', () => {
    expect(problemsOf({ Node: { id: deny }, Searchable: { id: deny } })).toEqual([]);
  });

  it('rejects a type-wide rule from two interfaces, naming the fields nothing settles', () => {
    // `id` is settled by Note's own entry; `title` and `body` are not.
    expect(problemsOf({ Node: deny, Searchable: accept, Note: { id: accept } })).toEqual([
      "`Note` gets a type-wide rule from `Node` and `Searchable`, and nothing says which applies to `title` and `body` — add `Note: { '*': … }`, or a rule per field, to choose.",
    ]);
  });

  it('names a single unsettled field on its own', () => {
    expect(
      problemsOf({ Node: deny, Searchable: accept, Note: { id: accept, title: accept } }),
    ).toEqual([
      "`Note` gets a type-wide rule from `Node` and `Searchable`, and nothing says which applies to `body` — add `Note: { '*': … }`, or a rule per field, to choose.",
    ]);
  });

  it('ignores an interface entry that is undefined, as it does any other', () => {
    expect(problemsOf({ Node: undefined, Searchable: undefined, Note: { id: accept } })).toEqual(
      [],
    );
  });

  it("an interface's field entry settles a field above the type-wide tier", () => {
    // Node['*'] and Searchable['*'] disagree, but every field of Note is
    // settled higher up: id and title by Searchable's field entries, body by Note's own.
    expect(
      problemsOf({
        Node: { '*': deny },
        Searchable: { '*': accept, id: accept, title: accept },
        Note: { body: accept },
      }),
    ).toEqual([]);
  });

  it("the implementor's wildcard settles the type-wide tier", () => {
    expect(problemsOf({ Node: deny, Searchable: accept, Note: { '*': accept } })).toEqual([]);
  });

  it('counts a union among the sources', () => {
    const third = rule(() => true);
    // Post is under Node and Thing too, and is reported on its own.
    expect(problemsOf({ Node: deny, Searchable: accept, Thing: third })).toEqual([
      "`Note` gets a type-wide rule from `Node`, `Searchable` and `Thing`, and nothing says which applies to `id`, `title` and `body` — add `Note: { '*': … }`, or a rule per field, to choose.",
      "`Post` gets a type-wide rule from `Node` and `Thing`, and nothing says which applies to `id` and `body` — add `Post: { '*': … }`, or a rule per field, to choose.",
    ]);
  });

  it("checks a scoping rule's argument on every implementor", () => {
    const scoped: Rule = Object.assign((resolve: Parameters<Rule>[0]) => resolve(), {
      [SCOPE_INFO]: { into: ['where'] },
    });
    expect(problemsOf({ Node: { id: scoped } })).toEqual([
      'Rule for `Node.id` injects a filter into an argument named `where`, but `id` has no such argument. An injected argument bypasses GraphQL validation, so this would silently leave the field unscoped.',
    ]);
    // A bare rule is `{ '*': rule }`, and is checked as such — across every member.
    expect(problemsOf({ Thing: scoped })).toHaveLength(1);
    expect(problemsOf({ Thing: scoped })[0]).toMatch(
      /Rule for `Thing\.\*` injects a filter into an argument named `where`, but `id`, `title`, `body` have no such argument/,
    );
  });

  it('types an interface entry by the fields the interface declares (compile-time)', () => {
    // The shape typescript-resolvers emits: an interface's resolver type lists
    // its fields alongside __resolveType; a union's has only __resolveType.
    type Resolvers = {
      Query: { note: unknown };
      Node: { __resolveType: unknown; id: unknown };
      Thing: { __resolveType: unknown };
      Note: { __isTypeOf: unknown; id: unknown; title: unknown; body: unknown };
    };
    const typed: PermissionsMap<Resolvers> = {
      Node: { id: deny },
      Thing: { '*': deny },
      Note: { body: accept },
    };
    const bare: PermissionsMap<Resolvers> = { Node: deny, Thing: deny };
    const wrong: PermissionsMap<Resolvers> = {
      // @ts-expect-error `body` is not declared on Node
      Node: { body: deny },
      // @ts-expect-error a union has no field keys of its own
      Thing: { id: deny },
    };
    const discriminator: PermissionsMap<Resolvers> = {
      // @ts-expect-error __resolveType is not a field
      Node: { __resolveType: deny },
    };
    for (const map of [typed, bare]) {
      expect(() => validatePermissions(abstractSchema(), map as LooseMap)).not.toThrow();
    }
    for (const map of [wrong, discriminator]) {
      expect(() => validatePermissions(abstractSchema(), map as LooseMap)).toThrow(
        PermissionsError,
      );
    }
  });
});

describe('applyPermissions — error control', () => {
  /** A schema whose one field can be made to fail in each distinct way. */
  function scenario(
    rule: Rule,
    options?: ApplyPermissionsOptions,
    resolver: () => unknown = () => 'ok',
  ) {
    const schema = makeExecutableSchema({
      typeDefs: `type Query { note: String }`,
      resolvers: { Query: { note: resolver } },
    });
    return applyPermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { note: rule } },
      options,
    );
  }

  async function run(schema: GraphQLSchema) {
    const result = await graphql({ schema, source: '{ note }' });
    return result.errors?.[0];
  }

  it('replaces a generic denial with fallbackError', async () => {
    const error = await run(scenario(deny, { fallbackError: 'Not Authorised!' }));
    expect(error?.message).toBe('Not Authorised!');
  });

  it('accepts an Error instance', async () => {
    const boom = new GraphQLError('nope', { extensions: { code: 'FORBIDDEN' } });
    const error = await run(scenario(deny, { fallbackError: boom }));
    expect(error?.message).toBe('nope');
    expect(error?.extensions.code).toBe('FORBIDDEN');
  });

  it('accepts a mapper, and gives it the resolver arguments', async () => {
    const error = await run(
      scenario(deny, {
        fallbackError: (_original, _parent, _args, _context, info) =>
          new GraphQLError(`Denied ${info.parentType.name}.${info.fieldName}`),
      }),
    );
    expect(error?.message).toBe('Denied Query.note');
  });

  it('classifies an off-contract check result as a denial, not a rule failure', async () => {
    // `ctx.auth?.root` is `any` and `undefined` at runtime. `debug` rethrows a
    // rule's own failure untouched, so it is what tells the two apart: a plain
    // `Forbidden` here proves this reached the error layer as a real denial.
    const isRoot = rule((_parent, _args, ctx) => ctx.auth?.root);
    const result = await graphql({
      schema: scenario(isRoot, { debug: true }),
      source: '{ note }',
      contextValue: {},
    });
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('masks an off-contract denial like any other', async () => {
    const isRoot = rule((_parent, _args, ctx) => ctx.auth?.root);
    const result = await graphql({
      schema: scenario(isRoot, { maskDenials: true }),
      source: '{ note }',
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ note: null });
  });

  it('leaves an explicitly-named denial alone', async () => {
    // The rule author said what they meant; a blanket fallback must not overrule it.
    const named = rule(() => 'Your trial has expired');
    const error = await run(scenario(named, { fallbackError: 'Not Authorised!' }));
    expect(error?.message).toBe('Your trial has expired');
  });

  it('leaves an explicit denial alone through a combinator too', async () => {
    const error = await run(
      scenario(
        and(
          accept,
          rule(() => 'Your trial has expired'),
        ),
        {
          fallbackError: 'Not Authorised!',
        },
      ),
    );
    expect(error?.message).toBe('Your trial has expired');
  });

  it('lets resolver errors through by default, even with a fallbackError set', async () => {
    const error = await run(
      scenario(accept, { fallbackError: 'Not Authorised!' }, () => {
        throw new Error('connection refused: 10.0.0.4:5432');
      }),
    );
    expect(error?.message).toBe('connection refused: 10.0.0.4:5432');
  });

  it('masks resolver errors when allowExternalErrors is false', async () => {
    const error = await run(
      scenario(accept, { fallbackError: 'Not Authorised!', allowExternalErrors: false }, () => {
        throw new Error('connection refused: 10.0.0.4:5432');
      }),
    );
    expect(error?.message).toBe('Not Authorised!');
  });

  it('masks an error raised inside a rule by default', async () => {
    const broken = rule(() => {
      throw new Error('getAbility exploded');
    });
    const error = await run(scenario(broken, { fallbackError: 'Not Authorised!' }));
    expect(error?.message).toBe('Not Authorised!');
  });

  it('surfaces an error raised inside a rule when debug is set', async () => {
    const broken = rule(() => {
      throw new Error('getAbility exploded');
    });
    const error = await run(scenario(broken, { fallbackError: 'Not Authorised!', debug: true }));
    expect(error?.message).toBe('getAbility exploded');
  });

  it('does not confuse a resolver error with a rule failure under debug', async () => {
    // debug is about the rule, not the resolver: a resolver error still follows
    // allowExternalErrors.
    const error = await run(
      scenario(
        accept,
        { fallbackError: 'Not Authorised!', allowExternalErrors: false, debug: true },
        () => {
          throw new Error('connection refused');
        },
      ),
    );
    expect(error?.message).toBe('Not Authorised!');
  });

  it('leaves rules untouched when no error-control option is set', async () => {
    const error = await run(scenario(deny));
    expect(error?.message).toBe('Forbidden');
  });
});

describe('applyPermissions — a fields() rule as a type-level entry', () => {
  type M = { Note: { id: string; body: string; secret: string; userId: string } };

  it('guards every field of the type from one map entry', async () => {
    const typed = createTyped<M>();
    const canUser = createCan<{ userId?: string }, M>(
      async (ctx) => {
        const { can, build } = createGraphQLAbility<M>();
        if (!ctx.userId) return build();
        can('read', 'Note', ['id', 'body']);
        can('read', 'Note', ['secret'], { userId: ctx.userId });
        return build();
      },
      (ctx) => ctx.userId != null,
      typed,
    );

    const note = { id: 'n1', body: 'hello', secret: 'shh', userId: 'u1' };
    const schema = makeExecutableSchema({
      typeDefs: `
        type Note { id: ID!, body: String!, secret: String, userId: String! }
        type Query { note: Note }
      `,
      resolvers: { Query: { note: () => note } },
    });

    // One entry for Note, plus a rule on the root field itself.
    const guarded = applyPermissions<Record<string, Record<string, unknown>>>(schema, {
      Query: { note: accept },
      Note: canUser.fields('read', 'Note'),
    });

    const own = await graphql({
      schema: guarded,
      source: '{ note { id body secret } }',
      contextValue: { userId: 'u1' },
    });
    expect(own.data?.note).toEqual({ id: 'n1', body: 'hello', secret: 'shh' });
    expect(own.errors).toBeUndefined();

    // userId is on the schema but in no ability rule, so it is denied.
    const unlisted = await graphql({
      schema: guarded,
      source: '{ note { userId } }',
      contextValue: { userId: 'u1' },
    });
    expect(unlisted.errors?.[0]?.message).toBe('Forbidden');

    // secret is conditioned on ownership; body is not.
    const other = await graphql({
      schema: guarded,
      source: '{ note { body secret } }',
      contextValue: { userId: 'u2' },
    });
    expect(other.data?.note).toEqual({ body: 'hello', secret: null });
    expect(other.errors?.[0]?.message).toBe('Forbidden');
    expect(other.errors?.[0]?.path).toEqual(['note', 'secret']);
  });
});

describe('applyPermissions — masking denials', () => {
  /** A schema covering every field shape masking has to decide between. */
  function maskedSchema(rule: Rule, options?: ApplyPermissionsOptions) {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Todo {
          id: ID!
        }
        type Query {
          nullable: String
          required: String!
          list: [Todo!]!
          nullableList: [Todo!]
        }
      `,
      resolvers: {
        Query: {
          nullable: () => 'ok',
          required: () => 'ok',
          list: () => [{ id: '1' }],
          nullableList: () => [{ id: '1' }],
        },
      },
    });
    return applyPermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { nullable: rule, required: rule, list: rule, nullableList: rule } },
      { maskDenials: true, ...options },
    );
  }

  it('resolves a denied nullable field to null, with no error', async () => {
    const result = await graphql({ schema: maskedSchema(deny), source: '{ nullable }' });
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors).toBeUndefined();
  });

  it('resolves a denied non-null list to an empty list', async () => {
    const result = await graphql({ schema: maskedSchema(deny), source: '{ list { id } }' });
    expect(result.data).toEqual({ list: [] });
    expect(result.errors).toBeUndefined();
  });

  it('gives each request its own masked list', async () => {
    const schema = maskedSchema(deny);
    const first = (await graphql({ schema, source: '{ list { id } }' })).data?.list as unknown[];
    const second = (await graphql({ schema, source: '{ list { id } }' })).data?.list as unknown[];
    expect(first).not.toBe(second);
  });

  it('still throws for a non-null field that is not a list', async () => {
    const result = await graphql({ schema: maskedSchema(deny), source: '{ required }' });
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('keeps the rest of the response when one field is denied', async () => {
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Todo {
            id: ID!
          }
          type Query {
            list: [Todo!]!
            nullable: String
          }
        `,
        resolvers: { Query: { list: () => [{ id: '1' }], nullable: () => 'ok' } },
      }),
      { Query: { list: deny, nullable: accept } },
      { maskDenials: true },
    );
    const result = await graphql({ schema, source: '{ list { id } nullable }' });
    expect(result.data).toEqual({ list: [], nullable: 'ok' });
    expect(result.errors).toBeUndefined();
  });

  it('masks a denial that named its own reason', async () => {
    const withReason = rule(() => 'Only the owner may read this');
    const result = await graphql({ schema: maskedSchema(withReason), source: '{ nullable }' });
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors).toBeUndefined();
  });

  it('masks a denial rather than replacing it with fallbackError', async () => {
    const schema = maskedSchema(deny, { fallbackError: 'Not Authorised!' });
    const result = await graphql({ schema, source: '{ nullable }' });
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors).toBeUndefined();
  });

  it('does not mask a rule that broke', async () => {
    const broken = rule(() => {
      throw new Error('getAbility exploded');
    });
    const result = await graphql({ schema: maskedSchema(broken), source: '{ nullable }' });
    expect(result.errors?.[0]?.message).toBe('getAbility exploded');
  });

  it('does not mask an error thrown by a permitted resolver', async () => {
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      makeExecutableSchema({
        typeDefs: `type Query { note: String }`,
        resolvers: {
          Query: {
            note: () => {
              throw new Error('database down');
            },
          },
        },
      }),
      { Query: { note: accept } },
      { maskDenials: true },
    );
    const result = await graphql({ schema, source: '{ note }' });
    expect(result.data).toEqual({ note: null });
    expect(result.errors?.[0]?.message).toBe('database down');
  });

  it('throws denials as before when masking is off', async () => {
    const schema = maskedSchema(deny, { maskDenials: false });
    const result = await graphql({ schema, source: '{ nullable }' });
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('masks a denial raised by an onResult rule', async () => {
    type T = { Todo: { id: string } };
    const { can, build } = createGraphQLAbility<T>();
    can('read', 'Todo', { id: '1' });
    const ability = build();
    const canUser = createCan<unknown, T>(
      async () => ability,
      () => true,
      createTyped<T>(),
    );
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Todo {
            id: ID!
          }
          type Query {
            todo: Todo
          }
        `,
        resolvers: { Query: { todo: () => ({ id: '2' }) } },
      }),
      { Query: { todo: canUser.onResult('read', 'Todo') } },
      { maskDenials: true },
    );
    const result = await graphql({ schema, source: '{ todo { id } }' });
    expect(result.data).toEqual({ todo: null });
    expect(result.errors).toBeUndefined();
  });

  it('masks a denied nullable list to null', async () => {
    const result = await graphql({ schema: maskedSchema(deny), source: '{ nullableList { id } }' });
    expect(result.data).toEqual({ nullableList: null });
    expect(result.errors).toBeUndefined();
  });
});

describe('applyPermissions — filtering denials', () => {
  const CODE = { code: UNAUTHORIZED_FIELD_OR_TYPE };

  /** Every field shape filtering has to decide between, under `onDeny: 'filter'`. */
  function filtering(permissions: LooseMap, options?: ApplyPermissionsOptions): GraphQLSchema {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Todo {
          id: ID!
          body: String
        }
        type Query {
          nullable: String
          required: String!
          list: [Todo!]!
          nullableList: [Todo!]
        }
      `,
      resolvers: {
        Query: {
          nullable: () => 'ok',
          required: () => 'ok',
          list: () => [{ id: '1', body: 'hi' }],
          nullableList: () => [{ id: '1', body: 'hi' }],
        },
      },
    });
    return applyPermissions<Record<string, Record<string, unknown>>>(schema, permissions, {
      onDeny: 'filter',
      ...options,
    });
  }

  /** Executes and reports, the way a server hook would. */
  async function query(schema: GraphQLSchema, source: string, contextValue: unknown = {}) {
    return reportDenials(contextValue, await graphql({ schema, source, contextValue }));
  }

  it('resolves a denied nullable field to null with the standard error, no hook needed', async () => {
    const result = await graphql({
      schema: filtering({ Query: { nullable: deny } }),
      source: '{ nullable }',
      contextValue: {},
    });
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.path).toEqual(['nullable']);
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
  });

  it('resolves a denied non-null list to [] and reports it through reportDenials', async () => {
    const schema = filtering({ Query: { list: deny } });
    const unreported = await graphql({ schema, source: '{ list { id } }', contextValue: {} });
    expect(unreported.data).toEqual({ list: [] });
    expect(unreported.errors).toBeUndefined();

    const result = await query(schema, '{ list { id } }');
    expect(result.data).toEqual({ list: [] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.path).toEqual(['list']);
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
    expect(result.errors?.[0]?.locations).toEqual([{ line: 1, column: 3 }]);
  });

  it('keeps the rest of the response when one field is filtered', async () => {
    const schema = filtering({ Query: { list: deny, nullable: accept } });
    const result = await query(schema, '{ list { id } nullable }');
    expect(result.data).toEqual({ list: [], nullable: 'ok' });
    expect(result.errors?.map((error) => error.path)).toEqual([['list']]);
  });

  it('reports the path of a denied field inside a list item', async () => {
    const schema = filtering({ Todo: { body: deny } });
    const result = await query(schema, '{ list { id body } }');
    expect(result.data).toEqual({ list: [{ id: '1', body: null }] });
    expect(result.errors?.[0]?.path).toEqual(['list', 0, 'body']);
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
  });

  it('still rejects a non-null field that is not a list, under the standard code', async () => {
    const result = await query(filtering({ Query: { required: deny } }), '{ required }');
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
  });

  it("keeps a denial's own message as the report", async () => {
    const schema = filtering({ Query: { list: rule(() => 'Trial expired') } });
    const result = await query(schema, '{ list { id } }');
    expect(result.data).toEqual({ list: [] });
    expect(result.errors?.[0]?.message).toBe('Trial expired');
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
  });

  it('keeps a code the denial named itself', async () => {
    const paywalled = rule(() => new GraphQLError('Upgrade', { extensions: { code: 'PAYWALL' } }));
    const result = await query(filtering({ Query: { nullable: paywalled } }), '{ nullable }');
    expect(result.data).toEqual({ nullable: null });
    expect(result.errors?.[0]?.extensions).toEqual({ code: 'PAYWALL' });
  });

  it('still rewords a generic denial with fallbackError, then adds the code', async () => {
    const schema = filtering({ Query: { list: deny, nullable: deny } }, { fallbackError: 'Nope' });
    const result = await query(schema, '{ list { id } nullable }');
    expect(result.data).toEqual({ list: [], nullable: null });
    expect(result.errors?.map((error) => error.message)).toEqual(['Nope', 'Nope']);
    expect(result.errors?.map((error) => error.extensions)).toEqual([CODE, CODE]);
  });

  it('keeps the code a fallbackError chose', async () => {
    const schema = filtering(
      { Query: { nullable: deny } },
      { fallbackError: new GraphQLError('No', { extensions: { code: 'FORBIDDEN' } }) },
    );
    const result = await query(schema, '{ nullable }');
    expect(result.errors?.[0]?.extensions).toEqual({ code: 'FORBIDDEN' });
  });

  it('does not reword an explicit denial with fallbackError', async () => {
    const schema = filtering(
      { Query: { list: rule(() => 'Trial expired') } },
      { fallbackError: 'Nope' },
    );
    const result = await query(schema, '{ list { id } }');
    expect(result.errors?.[0]?.message).toBe('Trial expired');
  });

  it('filters a denial from a rule that is not check-based', async () => {
    // `wrap` returns plain middleware, so the denial arrives thrown rather than
    // as a check result — the other half of the error-control wrapper.
    const schema = filtering(
      {
        Query: {
          list: wrap(deny),
          nullable: wrap(deny),
          nullableList: wrap(rule(() => 'Trial expired')),
        },
      },
      { fallbackError: 'Nope' },
    );
    const result = await query(schema, '{ list { id } nullable nullableList { id } }');
    expect(result.data).toEqual({ list: [], nullable: null, nullableList: null });
    const byPath = Object.fromEntries(
      (result.errors ?? []).map((error) => [String(error.path?.[0]), error.message]),
    );
    expect(byPath).toEqual({ list: 'Nope', nullable: 'Nope', nullableList: 'Trial expired' });
    expect(result.errors?.map((error) => error.extensions)).toEqual([CODE, CODE, CODE]);
  });

  it('masks a denial from a rule that is not check-based', async () => {
    const schema = filtering({ Query: { list: wrap(deny) } }, { onDeny: 'mask' });
    const result = await query(schema, '{ list { id } }');
    expect(result.data).toEqual({ list: [] });
    expect(result.errors).toBeUndefined();
  });

  it('filters only denials — a broken rule still surfaces as itself', async () => {
    const broken = rule(() => {
      throw new Error('boom');
    });
    const result = await query(filtering({ Query: { list: broken } }), '{ list { id } }');
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe('boom');
    expect(result.errors?.[0]?.extensions).toEqual({});
  });

  it('filters under inPlace: true as well', async () => {
    const schema = filtering({ Query: { list: deny, nullable: deny } }, { inPlace: true });
    const result = await query(schema, '{ list { id } nullable }');
    expect(result.data).toEqual({ list: [], nullable: null });
    expect(result.errors?.map((error) => error.path)).toEqual(
      expect.arrayContaining([['list'], ['nullable']]),
    );
    expect(result.errors?.map((error) => error.extensions)).toEqual([CODE, CODE]);
  });

  it('rejects instead of recording when the context is not an object', async () => {
    const result = await query(filtering({ Query: { list: deny } }), '{ list { id } }', 42);
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.extensions).toEqual(CODE);
  });

  describe("report: 'extensions'", () => {
    const options: ApplyPermissionsOptions = { report: 'extensions' };

    it('keeps errors clean and lists every filtered denial under authorizationErrors', async () => {
      const schema = filtering({ Query: { list: deny, nullable: deny } }, options);
      const result = await query(schema, '{ list { id } nullable }');
      expect(result.data).toEqual({ list: [], nullable: null });
      expect(result.errors).toBeUndefined();
      expect(result.extensions).toEqual({
        authorizationErrors: [
          expect.objectContaining({ message: 'Forbidden', path: ['list'], extensions: CODE }),
          expect.objectContaining({ message: 'Forbidden', path: ['nullable'], extensions: CODE }),
        ],
      });
    });

    it('appends to extensions already on the result', async () => {
      const schema = filtering({ Query: { nullable: deny } }, options);
      const contextValue = {};
      const executed = await graphql({ schema, source: '{ nullable }', contextValue });
      const result = reportDenials(contextValue, {
        ...executed,
        extensions: { trace: 't1', authorizationErrors: [{ message: 'earlier' }] },
      });
      expect(result.extensions?.trace).toBe('t1');
      expect(result.extensions?.authorizationErrors).toEqual([
        { message: 'earlier' },
        expect.objectContaining({ path: ['nullable'] }),
      ]);
    });
  });

  describe('reportDenials', () => {
    it('drains the record, so a context is reported once', async () => {
      const schema = filtering({ Query: { list: deny } });
      const contextValue = {};
      const executed = await graphql({ schema, source: '{ list { id } }', contextValue });
      expect(reportDenials(contextValue, executed).errors).toHaveLength(1);
      expect(reportDenials(contextValue, executed)).toBe(executed);
    });

    it('returns the result itself when nothing was recorded', () => {
      const result = { data: { ok: true } };
      expect(reportDenials({}, result)).toBe(result);
      expect(reportDenials(undefined, result)).toBe(result);
    });
  });

  describe('the option shape', () => {
    it("treats maskDenials as onDeny: 'mask'", async () => {
      const masked = filtering({ Query: { list: deny } }, { onDeny: 'mask' });
      const result = await query(masked, '{ list { id } }');
      expect(result.data).toEqual({ list: [] });
      expect(result.errors).toBeUndefined();
      expect(() =>
        filtering({ Query: { list: deny } }, { onDeny: 'mask', maskDenials: true }),
      ).not.toThrow();
    });

    it('rejects maskDenials alongside a different onDeny', () => {
      expect(() => filtering({}, { onDeny: 'filter', maskDenials: true })).toThrow(
        PermissionsError,
      );
      expect(() => filtering({}, { onDeny: 'reject', maskDenials: true })).toThrow(/contradicts/);
    });

    it("rejects report without onDeny: 'filter'", () => {
      expect(() => filtering({}, { onDeny: 'reject', report: 'extensions' })).toThrow(
        /only applies under/,
      );
      expect(() => filtering({}, { onDeny: 'mask', report: 'errors' })).toThrow(PermissionsError);
    });
  });
});

describe('resolvePermissions', () => {
  const schema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Note {
        id: ID!
        body: String
      }
      type Query {
        note: Note
      }
    `,
    resolvers: { Query: { note: () => ({ id: 'n1', body: 'hello' }) } },
  });

  it('returns the rule guarding a field', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(schema, {
      Query: { note: deny },
    });
    expect(permissionFor('Query', 'note')).toBeTypeOf('function');
  });

  it('returns undefined for an unguarded field', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(schema, {
      Query: { note: deny },
    });
    expect(permissionFor('Note', 'id')).toBeUndefined();
  });

  it('applies wildcard precedence and the fallback rule', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Note: { id: accept } },
      { fallbackRule: deny },
    );
    expect(permissionFor('Note', 'id')).toBe(accept);
    expect(permissionFor('Note', 'body')).toBe(deny);
    expect(permissionFor('Query', 'note')).toBe(deny);
  });

  it('never guards introspection, even under a fallback rule', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      {},
      { fallbackRule: deny },
    );
    expect(permissionFor('__Schema', 'types')).toBeUndefined();
  });

  it('returns undefined for a field the schema does not have', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      {},
      { fallbackRule: deny },
    );
    expect(permissionFor('Note', 'nope')).toBeUndefined();
    expect(permissionFor('Nope', 'id')).toBeUndefined();
  });

  it('memoizes each lookup', () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(schema, {
      Query: { note: deny },
    });
    expect(permissionFor('Query', 'note')).toBe(permissionFor('Query', 'note'));
  });

  it('validates the map up front', () => {
    expect(() =>
      resolvePermissions<Record<string, Record<string, unknown>>>(schema, {
        Nope: { id: deny },
      }),
    ).toThrow(PermissionsError);
  });

  it('wraps the rule with the error-control options', async () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { note: deny } },
      { fallbackError: 'Not Authorised!' },
    );
    const rule = permissionFor('Query', 'note');
    await expect(
      rule?.(async () => 'ok', undefined, {}, {}, {} as GraphQLResolveInfo),
    ).rejects.toThrow('Not Authorised!');
  });

  it('masks a denial when asked to', async () => {
    const permissionFor = resolvePermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { note: deny } },
      { maskDenials: true },
    );
    const rule = permissionFor('Query', 'note');
    // `await` rather than `.resolves`: a masked denial of a synchronous check
    // is handed back synchronously, as `Rule` documents an allowed value may be.
    expect(await rule?.(async () => 'ok', undefined, {}, {}, {} as GraphQLResolveInfo)).toBeNull();
  });
});

describe('applyPermissions — rule caching across a list', () => {
  /**
   * The shape the wildcard precedence table documents: one rule attached to a
   * type, guarding its fields. Without caching that is O(rows x fields).
   */
  async function invocations(cache?: CacheMode) {
    let calls = 0;
    const counted = rule(
      async () => {
        calls++;
        return true;
      },
      { name: 'counted', ...(cache ? { cache } : {}) },
    );
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      title: 't',
      body: 'b',
      author: 'a',
      year: 2020,
    }));
    const schema = applyPermissions<Record<string, Record<string, unknown>>>(
      makeExecutableSchema({
        typeDefs: `
          type Note { id: ID! title: String! body: String! author: String! year: Int! }
          type Query { notes: [Note!]! }
        `,
        resolvers: { Query: { notes: () => rows } },
      }),
      { Query: { notes: counted }, Note: counted },
    );
    const result = await graphql({
      schema,
      source: '{ notes { id title body author year } }',
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect((result.data?.notes as unknown[]).length).toBe(100);
    return calls;
  }

  // 100 rows x 5 fields + the list field itself. The three numbers match
  // graphql-shield's for the same query under its three cache settings.
  it('evaluates once per field per object by default', async () => {
    expect(await invocations()).toBe(501);
  });

  it('evaluates once per object under strict', async () => {
    expect(await invocations('strict')).toBe(101);
  });

  it('evaluates once for the whole request under contextual', async () => {
    expect(await invocations('contextual')).toBe(1);
  });
});

describe('applyPermissions — the untyped mode', () => {
  const looseSchema = makeExecutableSchema({
    typeDefs: `type Note { id: ID! body: String! } type Query { note: Note }`,
  });

  /** A hand-written stand-in for a generated `Resolvers` type. */
  type Resolvers = { Query: { note: unknown }; Note: { id: unknown; body: unknown } };

  it('accepts a map with no generic supplied (compile-time)', () => {
    // Omitting the generic used to infer TResolvers *from the map being
    // checked*, collapsing every type key to `unknown` and reporting every real
    // field name as unknown. It now falls back to AnyResolvers.
    applyPermissions(looseSchema, { Query: { note: accept }, Note: { id: deny } });
    expect(true).toBe(true);
  });

  it('accepts a map annotated with AnyResolvers (compile-time)', () => {
    const permissions: PermissionsMap<AnyResolvers> = {
      Query: { note: accept },
      Note: deny,
      '*': { '*': deny },
    };
    expect(() => applyPermissions(looseSchema, permissions)).not.toThrow();
  });

  it('still rejects a value that is not a rule (compile-time)', () => {
    // Loose on names, not on values.
    expect(() =>
      // @ts-expect-error a string is not a Rule
      applyPermissions(looseSchema, { Query: { note: 'not a rule' } }),
    ).toThrow();
  });

  it('still checks names when a generic is supplied (compile-time)', () => {
    expect(() =>
      // @ts-expect-error `nope` is not a field of Note
      applyPermissions<Resolvers>(looseSchema, { Note: { nope: deny } }),
    ).toThrow(PermissionsError);
    expect(() =>
      // @ts-expect-error `Nope` is not a type in Resolvers
      applyPermissions<Resolvers>(looseSchema, { Nope: { id: deny } }),
    ).toThrow(PermissionsError);
    // the same map with real names typechecks and applies cleanly
    expect(() =>
      applyPermissions<Resolvers>(looseSchema, { Query: { note: accept }, Note: { id: deny } }),
    ).not.toThrow();
  });

  it('leaves the runtime schema walk as the safety net for a stale key', () => {
    // This is what makes the untyped mode a reasonable place to start: names go
    // unchecked at build time, and still fail loudly at startup.
    expect(() => applyPermissions(looseSchema, { Note: { nope: deny } })).toThrow(PermissionsError);
    expect(() => applyPermissions(looseSchema, { Nope: { id: deny } })).toThrow(/Nope/);
  });
});

describe('validatePermissions', () => {
  const schema = makeExecutableSchema({
    typeDefs: `type Note { id: ID! body: String! } type Query { note: Note }`,
  });

  it('passes a map whose every key exists', () => {
    expect(() =>
      validatePermissions<Record<string, Record<string, unknown>>>(schema, {
        Query: { note: accept },
        Note: { id: deny, '*': accept },
      }),
    ).not.toThrow();
  });

  it('throws a PermissionsError naming a stale field', () => {
    expect(() =>
      validatePermissions<Record<string, Record<string, unknown>>>(schema, {
        Note: { nope: deny },
      }),
    ).toThrow(PermissionsError);
  });

  it('aggregates every problem, as applyPermissions does', () => {
    let message = '';
    try {
      validatePermissions<Record<string, Record<string, unknown>>>(schema, {
        Nope: { id: deny },
        Note: { alsoNope: deny },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Nope/);
    expect(message).toMatch(/alsoNope/);
  });

  it('agrees with applyPermissions on the same map', () => {
    // The whole point: a map that passes validation applies cleanly, and one
    // that fails validation fails identically when applied.
    const good = { Query: { note: accept } };
    const bad = { Query: { nope: accept } };
    expect(() => validatePermissions(schema, good)).not.toThrow();
    expect(() => applyPermissions(schema, good)).not.toThrow();

    const fromValidate = (() => {
      try {
        validatePermissions(schema, bad);
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const fromApply = (() => {
      try {
        applyPermissions(schema, bad);
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(fromValidate).toBe(fromApply);
    expect(fromValidate).toBeTruthy();
  });

  it('builds no middleware, leaving the schema untouched', () => {
    // applyPermissions returns a new, wrapped schema; validation must not.
    const before = schema.getQueryType()?.getFields().note?.resolve;
    validatePermissions(schema, { Query: { note: deny } });
    expect(schema.getQueryType()?.getFields().note?.resolve).toBe(before);
  });
});

describe('applyPermissions — error control on a check-then-resolve rule', () => {
  // `rule()` marks its middleware, and error control then talks to the check
  // directly instead of catching a thrown denial. Same contract as the generic
  // wrapper, different code path, so each branch is pinned here.
  function scenario(
    guard: Rule,
    options?: ApplyPermissionsOptions,
    resolver: () => unknown = () => 'ok',
  ) {
    const schema = makeExecutableSchema({
      typeDefs: `type Query { note: String  other: String }`,
      resolvers: { Query: { note: resolver, other: () => 'ok' } },
    });
    return applyPermissions<Record<string, Record<string, unknown>>>(
      schema,
      { Query: { note: guard, other: guard } },
      options,
    );
  }

  async function run(schema: GraphQLSchema, source = '{ note }') {
    const result = await graphql({ schema, source, contextValue: {} });
    return result.errors?.[0];
  }

  it('replaces a generic denial from a synchronous check', async () => {
    const error = await run(
      scenario(
        rule(() => false),
        { fallbackError: 'Not Authorised!' },
      ),
    );
    expect(error?.message).toBe('Not Authorised!');
  });

  it('replaces a generic denial from an asynchronous check', async () => {
    const error = await run(
      scenario(
        rule(async () => false),
        { fallbackError: 'Not Authorised!' },
      ),
    );
    expect(error?.message).toBe('Not Authorised!');
  });

  it('leaves an explicit denial alone, sync or async', async () => {
    const sync = await run(
      scenario(
        rule(() => 'Trial expired'),
        { fallbackError: 'Not Authorised!' },
      ),
    );
    expect(sync?.message).toBe('Trial expired');
    const async = await run(
      scenario(
        rule(async () => new Error('Trial expired')),
        { fallbackError: 'Not Authorised!' },
      ),
    );
    expect(async?.message).toBe('Trial expired');
  });

  it('masks an asynchronous rule failure by default and surfaces it under debug', async () => {
    const broken = rule(async () => {
      throw new Error('getAbility exploded');
    });
    const masked = await run(scenario(broken, { fallbackError: 'Not Authorised!' }));
    expect(masked?.message).toBe('Not Authorised!');
    const surfaced = await run(scenario(broken, { fallbackError: 'Not Authorised!', debug: true }));
    expect(surfaced?.message).toBe('getAbility exploded');
  });

  it('propagates a rule failure untouched when there is no fallbackError', async () => {
    const broken = rule(() => {
      throw new Error('getAbility exploded');
    });
    const error = await run(scenario(broken, { allowExternalErrors: false }));
    expect(error?.message).toBe('getAbility exploded');
  });

  it('masks an asynchronous resolver rejection when allowExternalErrors is false', async () => {
    const error = await run(
      scenario(
        rule(() => true),
        { fallbackError: 'Not Authorised!', allowExternalErrors: false },
        async () => {
          throw new Error('connection refused: 10.0.0.4:5432');
        },
      ),
    );
    expect(error?.message).toBe('Not Authorised!');
  });

  it('lets a resolver rejection through by default', async () => {
    const error = await run(
      scenario(
        rule(() => true),
        { fallbackError: 'Not Authorised!' },
        async () => {
          throw new Error('connection refused');
        },
      ),
    );
    expect(error?.message).toBe('connection refused');
  });

  it('surfaces resolver errors under allowExternalErrors: false when nothing can replace them', async () => {
    const error = await run(
      scenario(
        rule(() => true),
        { allowExternalErrors: false },
        () => {
          throw new Error('connection refused');
        },
      ),
    );
    expect(error?.message).toBe('connection refused');
  });

  it('masks an explicit denial when maskDenials is on, ignoring fallbackError', async () => {
    const schema = scenario(
      rule(() => 'Trial expired'),
      { maskDenials: true, fallbackError: 'Not Authorised!' },
    );
    const result = await graphql({ schema, source: '{ note }', contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ note: null });
  });

  it('still applies the check cache underneath error control', async () => {
    // The wrapper must consult the cached check, not the raw one, or the
    // cache silently stops working the moment fallbackError is set.
    let calls = 0;
    const counted = rule(
      async () => {
        calls++;
        return true;
      },
      { cache: 'contextual' },
    );
    const error = await run(
      scenario(counted, { fallbackError: 'Not Authorised!' }),
      '{ note other }',
    );
    expect(error).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('applyPermissions — inPlace', () => {
  /** A schema with a resolver-less field, a list, and a subscription. */
  function richSchema() {
    return makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Note { id: ID! body: String secret: String }
        type Query { note: Note! notes: [Note!]! }
        type Subscription { tick: Int }
      `,
      resolvers: {
        Query: { note: () => note, notes: () => [note] },
        Subscription: {
          tick: {
            subscribe: async function* () {
              yield { tick: 1 };
              yield { tick: 2 };
            },
          },
        },
      },
    });
  }

  type RichMap = PermissionsMap<Record<string, Record<string, unknown>>>;

  /** Runs one query against the map applied both ways, and returns both results. */
  async function bothWays(map: RichMap, source: string, options?: ApplyPermissionsOptions) {
    const copied = await graphql({
      schema: applyPermissions(richSchema(), map, options),
      source,
      contextValue: {},
    });
    const mutated = await graphql({
      schema: applyPermissions(richSchema(), map, { ...options, inPlace: true }),
      source,
      contextValue: {},
    });
    return { copied, mutated };
  }

  it('returns the very schema it was given, now guarded', async () => {
    const base = richSchema();
    const guarded = applyPermissions(base, { Query: { note: deny } } as RichMap, {
      inPlace: true,
    });
    expect(guarded).toBe(base);
    const result = await graphql({ schema: base, source: '{ note { id } }' });
    expect(result.errors?.[0]?.message).toBe('Forbidden');
  });

  it('enforces exactly what the middleware path enforces', async () => {
    const map: RichMap = { Note: { secret: deny, '*': accept }, '*': { notes: deny } };
    const source = '{ note { id body secret } notes { id } }';
    for (const options of [
      undefined,
      { fallbackRule: deny },
      { fallbackRule: deny, maskDenials: true },
      { fallbackError: 'Not Authorised!' },
    ] satisfies (ApplyPermissionsOptions | undefined)[]) {
      const { copied, mutated } = await bothWays(map, source, options);
      expect(mutated.data).toEqual(copied.data);
      expect(mutated.errors?.map((e) => e.message)).toEqual(copied.errors?.map((e) => e.message));
    }
  });

  it('guards a field that has no resolver of its own', async () => {
    const { copied, mutated } = await bothWays({ Note: { body: deny } }, '{ note { id body } }');
    expect(copied.errors?.[0]?.message).toBe('Forbidden');
    expect(mutated.errors?.[0]?.message).toBe('Forbidden');
    expect(mutated.data).toEqual({ note: { id: '1', body: null } });
  });

  it("guards a subscription field's subscribe, as graphql-middleware does", async () => {
    async function firstEvent(schema: GraphQLSchema) {
      const out = await subscribe({ schema, document: parse('subscription { tick }') });
      if (Symbol.asyncIterator in out) {
        const { value } = await out[Symbol.asyncIterator]().next();
        return (value as ExecutionResult).data;
      }
      return out.errors?.[0]?.message;
    }
    const denied = { Subscription: { tick: deny } } as RichMap;
    expect(await firstEvent(applyPermissions(richSchema(), denied))).toBe('Forbidden');
    expect(await firstEvent(applyPermissions(richSchema(), denied, { inPlace: true }))).toBe(
      'Forbidden',
    );
    const allowed = { Subscription: { tick: accept } } as RichMap;
    expect(await firstEvent(applyPermissions(richSchema(), allowed, { inPlace: true }))).toEqual({
      tick: 1,
    });
  });

  it('validates the map before touching the schema', async () => {
    const base = richSchema();
    expect(() =>
      applyPermissions(base, { Query: { note: deny }, Nope: deny } as RichMap, { inPlace: true }),
    ).toThrow(PermissionsError);
    const result = await graphql({ schema: base, source: '{ note { id } }' });
    expect(result.errors).toBeUndefined();
  });

  it('refuses to guard a schema twice', () => {
    const base = richSchema();
    applyPermissions(base, { Query: { note: accept } } as RichMap, { inPlace: true });
    expect(() =>
      applyPermissions(base, { Query: { note: deny } } as RichMap, { inPlace: true }),
    ).toThrow(/already guarded/);
  });

  it('leaves introspection working under fallbackRule: deny', async () => {
    const schema = applyPermissions(richSchema(), {} as RichMap, {
      fallbackRule: deny,
      inPlace: true,
    });
    const result = await graphql({ schema, source: '{ __schema { queryType { name } } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ __schema: { queryType: { name: 'Query' } } });
  });

  it('lets a scoping-style rule rewrite the arguments it forwards', async () => {
    const schema = makeExecutableSchema({
      typeDefs: `type Query { echo(word: String): String }`,
      resolvers: { Query: { echo: (_: unknown, args: { word: string }) => args.word } },
    });
    const rewrite: Rule = (resolve, parent, _args, context, info) =>
      resolve(parent, { word: 'rewritten' }, context, info);
    applyPermissions(schema, { Query: { echo: rewrite } } as RichMap, { inPlace: true });
    const result = await graphql({ schema, source: '{ echo(word: "original") }' });
    expect(result.data).toEqual({ echo: 'rewritten' });
  });
});
