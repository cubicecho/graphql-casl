import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError, type GraphQLSchema, graphql } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApplyPermissionsOptions,
  accept,
  and,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  PermissionsError,
  type PermissionsMap,
  type Rule,
  rule,
} from '../src/index.js';

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

  it('rejects an interface, explaining that the rule would never run', () => {
    const [problem] = problemsOf({ Node: { id: deny } });
    expect(problem).toContain('`Node` is an interface type, not an object type.');
    expect(problem).toContain('attach it to each implementing type instead');
  });

  it('rejects a union instead of crashing inside graphql-middleware', () => {
    // graphql-middleware itself throws `type.getFields is not a function` here.
    const [problem] = problemsOf({ Thing: deny });
    expect(problem).toContain('`Thing` is a union type, not an object type.');
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
