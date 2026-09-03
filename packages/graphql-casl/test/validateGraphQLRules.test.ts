/**
 * Tests for `validateGraphQLRules`: stored ability rules checked against the
 * runtime schema. The rules are deliberately built as raw objects — that is the
 * case the check exists for, rows that never passed through the typed builder.
 */

import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  buildGraphQLAbility,
  createGraphQLAbility,
  createTyped,
  type GraphQLRule,
  PermissionsError,
  type ValidateGraphQLRulesOptions,
  validateGraphQLRules,
} from '../src/index.js';

const schema = buildSchema(/* GraphQL */ `
  scalar JSON
  interface Node {
    id: ID!
  }
  type User implements Node {
    id: ID!
    email: String!
  }
  type Tag {
    name: String!
  }
  type Note implements Node {
    id: ID!
    ownerId: ID!
    title: String!
    author: User!
    tags: [Tag!]!
    meta: JSON
  }
  union Thing = Note | User
  enum Colour {
    RED
  }
  type Query {
    notes: [Note!]!
  }
  type Mutation {
    addNote: Note
  }
`);

type User = { id: string; email: string };
type Tag = { name: string };
type Note = {
  id: string;
  ownerId: string;
  title: string;
  author: User;
  tags: Tag[];
  meta: unknown;
};
type AppSubjectMap = { Note: Partial<Note>; User: Partial<User>; Tag: Partial<Tag> };

const typed = createTyped<AppSubjectMap>();

function problemsOf(rules: readonly unknown[], options?: ValidateGraphQLRulesOptions): string[] {
  try {
    validateGraphQLRules(schema, rules, options);
  } catch (error) {
    if (error instanceof PermissionsError) return [...error.problems];
    throw error;
  }
  throw new Error('expected validateGraphQLRules to throw');
}

const read = (rest: object) => ({ action: 'read', subject: 'Note', ...rest });

describe('validateGraphQLRules — what passes', () => {
  it('accepts rules from the typed builder, round-tripped through JSON', () => {
    const { can, cannot, build } = createGraphQLAbility<AppSubjectMap>();
    can('read', 'Note');
    can('update', 'Note', { ownerId: 'u1' });
    cannot('delete', 'Note', { title: { $regex: '^secret' } }).because('nope');
    can('read', 'User', ['email']);
    can('manage', 'all');
    const stored: GraphQLRule<AppSubjectMap>[] = JSON.parse(JSON.stringify(build().rules));

    expect(() => validateGraphQLRules(schema, stored)).not.toThrow();
  });

  it('accepts arrays of actions and subjects', () => {
    expect(() =>
      validateGraphQLRules(schema, [{ action: ['read', 'update'], subject: ['Note', 'User'] }]),
    ).not.toThrow();
  });

  it('accepts an empty rule set', () => {
    expect(() => validateGraphQLRules(schema, [])).not.toThrow();
  });

  it('accepts every operator CASL supports, and the group operators', () => {
    expect(() =>
      validateGraphQLRules(schema, [
        read({
          conditions: {
            $or: [{ ownerId: { $in: ['u1'] } }, { ownerId: { $exists: false } }],
            $and: [{ title: { $regex: 'x', $options: 'i' } }],
            $nor: [{ title: { $not: { $eq: 'y' } } }],
            tags: { $size: 2, $elemMatch: { name: { $ne: 'z' } } },
          },
        }),
      ]),
    ).not.toThrow();
  });

  it('follows dotted paths through object-typed fields and lists', () => {
    expect(() =>
      validateGraphQLRules(schema, [
        read({ conditions: { 'author.id': 'u1', 'tags.name': { $in: ['a'] } } }),
      ]),
    ).not.toThrow();
  });

  it('accepts any path below a scalar, an enum or a union', () => {
    // A `JSON` column has whatever keys it has; there is nothing to check.
    expect(() =>
      validateGraphQLRules(schema, [read({ conditions: { 'meta.anything.deeper': 1 } })]),
    ).not.toThrow();
  });

  it('accepts field patterns and dotted fields', () => {
    expect(() =>
      validateGraphQLRules(schema, [
        read({ fields: ['title', '*', 'author.*', 'author.id'] }),
        { action: 'read', subject: 'all', fields: ['whatever'] },
      ]),
    ).not.toThrow();
  });

  it('checks only shape for a rule on `all`, which has no fields to check', () => {
    expect(() =>
      validateGraphQLRules(schema, [{ action: 'read', subject: 'all', conditions: { x: 1 } }]),
    ).not.toThrow();
    expect(
      problemsOf([{ action: 'read', subject: 'all', conditions: { x: { $foo: 1 } } }]),
    ).toEqual([
      'Rule 0 (`read` on `all`): `$foo` on `x` is not a condition operator CASL supports.',
    ]);
  });
});

describe('validateGraphQLRules — the rule itself', () => {
  it('rejects a rule that is not an object', () => {
    expect(problemsOf(['read', null, [1]])).toEqual([
      'Rule 0 is the string "read", not an object.',
      'Rule 1 is null, not an object.',
      'Rule 2 is an array, not an object.',
    ]);
  });

  it('rejects a missing action or subject', () => {
    expect(problemsOf([{ subject: 'Note' }, { action: 'read' }])).toEqual([
      'Rule 0 has no `action`.',
      'Rule 1 has no `subject`.',
    ]);
  });

  it('rejects an action that is not a string, and an empty list', () => {
    expect(
      problemsOf([
        { action: 5, subject: 'Note' },
        { action: [], subject: 'Note' },
      ]),
    ).toEqual([
      'Rule 0: `action` is a number, not a string or array of strings.',
      'Rule 1: `action` is an empty array.',
    ]);
  });

  it('rejects an action this library does not know', () => {
    expect(problemsOf([{ action: 'view', subject: 'Note' }])).toEqual([
      'Rule 0 (`view` on `Note`): action `view` is not one of `create`, `read`, `update`, `delete`, `manage`.',
    ]);
  });

  it('rejects a non-boolean `inverted`, which CASL would read as a denial', () => {
    expect(problemsOf([read({ inverted: 'false' })])).toEqual([
      'Rule 0 (`read` on `Note`): `inverted` is the string "false", not a boolean. CASL reads any truthy value as a denial.',
    ]);
  });

  it('rejects a non-string `reason`', () => {
    expect(problemsOf([read({ reason: 5 })])).toEqual([
      'Rule 0 (`read` on `Note`): `reason` is a number, not a string.',
    ]);
  });
});

describe('validateGraphQLRules — subjects', () => {
  it('rejects a subject the schema does not have', () => {
    expect(problemsOf([{ action: 'read', subject: 'Ghost' }])).toEqual([
      'Rule 0 (`read` on `Ghost`): subject `Ghost` is not a type in the schema.',
    ]);
  });

  it('rejects a root operation type', () => {
    expect(problemsOf([{ action: 'read', subject: ['Query', 'Mutation'] }])).toEqual([
      'Rule 0 (`read` on `Query`, `Mutation`): subject `Query` is a root operation type, not a subject.',
      'Rule 0 (`read` on `Query`, `Mutation`): subject `Mutation` is a root operation type, not a subject.',
    ]);
  });

  it('rejects an interface or union, explaining why the rule would never match', () => {
    const problems = problemsOf([
      { action: 'read', subject: 'Node' },
      { action: 'read', subject: 'Thing' },
    ]);
    expect(problems[0]).toMatch(
      /^Rule 0 .*subject `Node` is an interface type, not an object type\./,
    );
    expect(problems[0]).toContain('Subjects are detected by `__typename`');
    expect(problems[1]).toMatch(/subject `Thing` is a union type, not an object type\./);
  });

  it('rejects a scalar or enum, without the interface hint', () => {
    const problems = problemsOf([
      { action: 'read', subject: 'Colour' },
      { action: 'read', subject: 'JSON' },
    ]);
    expect(problems).toEqual([
      'Rule 0 (`read` on `Colour`): subject `Colour` is an enum type, not an object type.',
      'Rule 1 (`read` on `JSON`): subject `JSON` is a scalar type, not an object type.',
    ]);
  });

  it('rejects an introspection type', () => {
    expect(problemsOf([{ action: 'read', subject: '__Type' }])).toEqual([
      'Rule 0 (`read` on `__Type`): subject `__Type` is an introspection type and cannot be a subject.',
    ]);
  });
});

describe('validateGraphQLRules — fields', () => {
  it('rejects a field the subject does not have', () => {
    expect(problemsOf([read({ fields: ['title', 'nope'] })])).toEqual([
      'Rule 0 (`read` on `Note`): field `nope` is not a field of `Note`.',
    ]);
  });

  it('checks fields against every subject of a multi-subject rule', () => {
    expect(problemsOf([{ action: 'read', subject: ['Note', 'User'], fields: 'title' }])).toEqual([
      'Rule 0 (`read` on `Note`, `User`): field `title` is not a field of `User`.',
    ]);
  });

  it('rejects fields that are not strings', () => {
    expect(problemsOf([read({ fields: [1] })])).toEqual([
      'Rule 0 (`read` on `Note`): `fields` is an array with a non-string item, not a string or array of strings.',
    ]);
  });
});

describe('validateGraphQLRules — conditions', () => {
  it('rejects conditions that are not an object', () => {
    expect(problemsOf([read({ conditions: [] })])).toEqual([
      'Rule 0 (`read` on `Note`): `conditions` is an array, not an object.',
    ]);
  });

  it('rejects a condition on a field the subject does not have', () => {
    expect(problemsOf([read({ conditions: { ownr: 'u1' } })])).toEqual([
      'Rule 0 (`read` on `Note`): condition field `ownr` is not a field of `Note`.',
    ]);
  });

  it('names the type at fault in a dotted path', () => {
    expect(problemsOf([read({ conditions: { 'author.nope': 'x' } })])).toEqual([
      'Rule 0 (`read` on `Note`): condition path `author.nope`: `User` has no field `nope`.',
    ]);
  });

  it('rejects an operator CASL does not support', () => {
    expect(problemsOf([read({ conditions: { ownerId: { $foo: 1 } } })])).toEqual([
      'Rule 0 (`read` on `Note`): `$foo` on `ownerId` is not a condition operator CASL supports.',
    ]);
  });

  it('rejects an unknown top-level operator, including the unserializable $where', () => {
    expect(problemsOf([read({ conditions: { $where: 'this.x' } })])).toEqual([
      'Rule 0 (`read` on `Note`): `$where` is not an operator CASL supports at the top level of a condition (only `$and`, `$or` and `$nor` are).',
    ]);
  });

  it('rejects a mix of operators and plain keys, as mongo does', () => {
    expect(problemsOf([read({ conditions: { author: { id: 'u1', $ne: null } } })])).toEqual([
      'Rule 0 (`read` on `Note`): condition `author` mixes operators with plain keys (`id` alongside `$ne`).',
    ]);
  });

  it('checks inside $and / $or / $nor groups', () => {
    expect(
      problemsOf([read({ conditions: { $and: [{ ownerId: 'u1' }, { titel: 'x' }] } })]),
    ).toEqual(['Rule 0 (`read` on `Note`): condition field `titel` is not a field of `Note`.']);
  });

  it('rejects a malformed group', () => {
    expect(
      problemsOf([read({ conditions: { $and: 'x' } }), read({ conditions: { $or: [1] } })]),
    ).toEqual([
      'Rule 0 (`read` on `Note`): `$and` must be an array of conditions, not the string "x".',
      'Rule 1 (`read` on `Note`): `$or[0]` is a number, not a condition object.',
    ]);
  });

  it('checks the operators nested under $not', () => {
    expect(problemsOf([read({ conditions: { ownerId: { $not: { $foo: 1 } } } })])).toEqual([
      'Rule 0 (`read` on `Note`): `$foo` on `ownerId` is not a condition operator CASL supports.',
    ]);
  });

  it('checks an $elemMatch condition against the list item type', () => {
    expect(
      problemsOf([
        read({ conditions: { tags: { $elemMatch: { nmae: 'x' } } } }),
        read({ conditions: { tags: { $elemMatch: 5 } } }),
      ]),
    ).toEqual([
      'Rule 0 (`read` on `Note`): condition field `nmae` is not a field of `Tag`.',
      'Rule 1 (`read` on `Note`): `$elemMatch` on `tags` must be a condition object, not a number.',
    ]);
  });

  it("conditionFields: 'none' skips the field check but still checks operators", () => {
    const stale = read({ conditions: { ownr: 'u1' } });
    expect(() => validateGraphQLRules(schema, [stale], { conditionFields: 'none' })).not.toThrow();
    expect(
      problemsOf([read({ conditions: { ownr: { $foo: 1 } } })], { conditionFields: 'none' }),
    ).toEqual([
      'Rule 0 (`read` on `Note`): `$foo` on `ownr` is not a condition operator CASL supports.',
    ]);
  });
});

describe('validateGraphQLRules — reporting', () => {
  it('reports every problem across every rule at once', () => {
    expect(
      problemsOf([
        { action: 'view', subject: 'Ghost' },
        read({ fields: ['nope'], conditions: { ownr: 'u1' }, inverted: 1 }),
      ]),
    ).toEqual([
      'Rule 0 (`view` on `Ghost`): action `view` is not one of `create`, `read`, `update`, `delete`, `manage`.',
      'Rule 0 (`view` on `Ghost`): subject `Ghost` is not a type in the schema.',
      'Rule 1 (`read` on `Note`): field `nope` is not a field of `Note`.',
      'Rule 1 (`read` on `Note`): condition field `ownr` is not a field of `Note`.',
      'Rule 1 (`read` on `Note`): `inverted` is a number, not a boolean. CASL reads any truthy value as a denial.',
    ]);
  });

  it('throws a PermissionsError whose message lists the problems', () => {
    let caught: unknown;
    try {
      validateGraphQLRules(schema, [{ action: 'read', subject: 'Ghost' }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionsError);
    const error = caught as PermissionsError;
    expect(error.name).toBe('PermissionsError');
    expect(error.message).toContain('graphql-casl: the ability rules do not match the schema.');
    expect(error.message).toContain(
      '  - Rule 0 (`read` on `Ghost`): subject `Ghost` is not a type in the schema.',
    );
  });

  it('catches what buildGraphQLAbility lets through silently', () => {
    // Both rules rehydrate without complaint and then quietly deny: the first
    // conditions on a field no row has, the second is inverted by a truthy string.
    const stale = [
      { action: 'update', subject: 'Note', conditions: { ownr: 'u1' } },
      { action: 'read', subject: 'Note', inverted: 'false' },
    ];
    const ability = buildGraphQLAbility<AppSubjectMap>(stale as GraphQLRule<AppSubjectMap>[]);
    expect(ability.can('update', typed('Note', { ownerId: 'u1' }))).toBe(false);
    expect(ability.can('read', typed('Note', { ownerId: 'u1' }))).toBe(false);

    expect(problemsOf(stale)).toHaveLength(2);
  });
});
