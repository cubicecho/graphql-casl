import { makeExecutableSchema } from '@graphql-tools/schema';
import { type GraphQLSchema, graphql } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  accept,
  applyPermissions,
  deny,
  PermissionsError,
  type PermissionsMap,
  type Rule,
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
