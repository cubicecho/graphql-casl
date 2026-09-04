import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError, type GraphQLResolveInfo, type GraphQLSchema, graphql } from 'graphql';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Actions,
  type ApplyPermissionsOptions,
  accept,
  and,
  applyPermissions,
  BAD_USER_INPUT,
  chain,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  isCheckableRule,
  not,
  or,
  type PermissionsMap,
  type Rule,
  race,
  reportDenials,
  rule,
  type StandardSchemaV1,
  UNAUTHORIZED_FIELD_OR_TYPE,
  type ValidatedArgs,
  validateArgs,
  wrap,
} from '../src/index.js';

const info = {} as GraphQLResolveInfo;

/** A hand-rolled Standard Schema — the spec needs nothing but `~standard`. */
function standard<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>,
): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'test', validate } };
}

type Input = { title: string; tags?: string[] };
type Parsed = { title: string; tags: string[] };

/** Requires a non-blank title, trims it, and defaults `tags`. */
function parseNote(value: unknown): StandardSchemaV1.Result<Parsed> {
  const input = (value ?? {}) as Partial<Input>;
  const title = input.title?.trim() ?? '';
  if (title === '') {
    return { issues: [{ message: 'A note needs a title', path: ['title'] }] };
  }
  return { value: { title, tags: input.tags ?? [] } };
}

const NoteArgs = standard<Parsed>(parseNote);
const AsyncNoteArgs = standard<Parsed>(async (value) => parseNote(value));

/** Rejects everything, with a mixed-form path, to exercise the flattening. */
const symbolKey = Symbol('sym');
const Everything = standard<never>(() => ({
  issues: [
    { message: 'Too short', path: ['input', { key: 'tags' }, 0, { key: symbolKey }] },
    { message: 'Not as a whole' },
  ],
}));

describe('validateArgs — a hand-rolled Standard Schema', () => {
  it('calls the resolver with the parsed output as its args', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(
      validateArgs(NoteArgs)(resolve, 'p', { title: '  hello ' }, { userId: 'u1' }, info),
    ).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('p', { title: 'hello', tags: [] }, { userId: 'u1' }, info);
  });

  it('awaits an asynchronous validator', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(
      validateArgs(AsyncNoteArgs)(resolve, 'p', { title: 'hi', tags: ['a'] }, {}, info),
    ).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('p', { title: 'hi', tags: ['a'] }, {}, info);
  });

  it('rejects a failure with BAD_USER_INPUT and the issues, and never resolves', async () => {
    const resolve = vi.fn();
    const failure = validateArgs(NoteArgs)(resolve, 'p', { title: ' ' }, {}, info);
    await expect(failure).rejects.toBeInstanceOf(GraphQLError);
    await expect(failure).rejects.toMatchObject({
      message: 'title: A note needs a title',
      extensions: {
        code: BAD_USER_INPUT,
        issues: [{ message: 'A note needs a title', path: ['title'] }],
      },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects an asynchronous failure the same way', async () => {
    await expect(validateArgs(AsyncNoteArgs)(vi.fn(), 'p', {}, {}, info)).rejects.toMatchObject({
      extensions: { code: BAD_USER_INPUT },
    });
  });

  it('flattens every path form to keys and joins the messages', async () => {
    const failure = validateArgs(Everything)(vi.fn(), 'p', {}, {}, info);
    await expect(failure).rejects.toMatchObject({
      message: 'input.tags.0.Symbol(sym): Too short; Not as a whole',
      extensions: {
        code: BAD_USER_INPUT,
        issues: [
          { message: 'Too short', path: ['input', 'tags', 0, 'Symbol(sym)'] },
          { message: 'Not as a whole', path: [] },
        ],
      },
    });
    // The extension has to survive serialization to reach a client.
    const error = (await failure.catch((e) => e)) as GraphQLError;
    expect(JSON.parse(JSON.stringify(error.toJSON())).extensions.issues[0].path).toEqual([
      'input',
      'tags',
      0,
      'Symbol(sym)',
    ]);
  });

  it('leaves the args untouched under replace: false', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    const args = { title: '  hello ' };
    await validateArgs(NoteArgs, { replace: false })(resolve, 'p', args, {}, info);
    expect(resolve).toHaveBeenCalledWith('p', args, {}, info);
    expect(resolve.mock.calls[0]?.[1]).toBe(args);
  });

  it('still rejects a failure under replace: false', async () => {
    await expect(
      validateArgs(NoteArgs, { replace: false })(vi.fn(), 'p', {}, {}, info),
    ).rejects.toMatchObject({ extensions: { code: BAD_USER_INPUT } });
  });

  it('lets an error thrown by the validator propagate as itself, not as a denial', async () => {
    const boom = new Error('validator exploded');
    const throwing = standard<never>(() => {
      throw boom;
    });
    await expect(validateArgs(throwing)(vi.fn(), 'p', {}, {}, info)).rejects.toBe(boom);

    const rejecting = standard<never>(() => Promise.reject(boom));
    await expect(validateArgs(rejecting)(vi.fn(), 'p', {}, {}, info)).rejects.toBe(boom);
  });

  it('stays synchronous when the validator and the resolver both are', () => {
    const result = validateArgs(NoteArgs)(
      (() => 'sync') as unknown as Parameters<Rule>[0],
      'p',
      { title: 'hi' },
      {},
      info,
    );
    expect(result).toBe('sync');
  });

  it('refuses anything that is not a Standard Schema, at construction', () => {
    const message = /expects a Standard Schema/;
    expect(() => validateArgs(undefined as never)).toThrow(message);
    expect(() => validateArgs({} as never)).toThrow(message);
    expect(() => validateArgs({ '~standard': { version: 1 } } as never)).toThrow(message);
  });

  it('is not a combinator operand, and the message says what to do instead', () => {
    const validating = validateArgs(NoteArgs);
    expect(isCheckableRule(validating)).toBe(false);
    expect(() => and(accept, validating)).toThrow(/`and\(\)` operand 1 is not a checkable rule/);
    expect(() => and(accept, validating)).toThrow(/`validateArgs\(\.\.\.\)`.*`wrap\(\)`/s);
    expect(() => or(validating)).toThrow(/operand 0 is not a checkable rule/);
    expect(() => chain(validating)).toThrow(/operand 0 is not a checkable rule/);
    expect(() => race(validating)).toThrow(/operand 0 is not a checkable rule/);
    expect(() => not(validating)).toThrow(/operand 0 is not a checkable rule/);
  });

  it('composes through wrap: the gate runs first and sees the raw args', async () => {
    const seen: unknown[] = [];
    const gate = rule((_parent, args) => {
      seen.push(args);
      return true;
    });
    const resolve = vi.fn().mockResolvedValue('ok');
    await wrap(gate, validateArgs(NoteArgs))(resolve, 'p', { title: ' x ' }, {}, info);
    expect(seen).toEqual([{ title: ' x ' }]);
    expect(resolve).toHaveBeenCalledWith('p', { title: 'x', tags: [] }, {}, info);
  });

  it('composes through wrap the other way: a rule beneath it sees the parsed args', async () => {
    const seen: unknown[] = [];
    const observe = rule((_parent, args) => {
      seen.push(args);
      return true;
    });
    const resolve = vi.fn().mockResolvedValue('ok');
    await wrap(validateArgs(NoteArgs), observe)(resolve, 'p', { title: ' x ' }, {}, info);
    expect(seen).toEqual([{ title: 'x', tags: [] }]);
  });

  it('never validates when the gate in front of it denies', async () => {
    const validate = vi.fn(parseNote);
    const resolve = vi.fn();
    await expect(
      wrap(deny, validateArgs(standard(validate)))(resolve, 'p', {}, {}, info),
    ).rejects.toThrow('Forbidden');
    expect(validate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('validateArgs — zod', () => {
  const CreateNoteArgs = z.object({
    input: z.object({
      title: z.string().trim().min(1, 'A note needs a title'),
      tags: z.array(z.string()).max(2, 'At most two tags').default([]),
      priority: z.coerce.number().int().min(1).default(1),
    }),
  });

  it('applies defaults, trims and coerces on the way to the resolver', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await validateArgs(CreateNoteArgs)(
      resolve,
      'p',
      { input: { title: '  hello ', priority: '3' } },
      {},
      info,
    );
    expect(resolve).toHaveBeenCalledWith(
      'p',
      { input: { title: 'hello', tags: [], priority: 3 } },
      {},
      info,
    );
  });

  it('reports a nested path', async () => {
    await expect(
      validateArgs(CreateNoteArgs)(
        vi.fn(),
        'p',
        { input: { title: '', tags: ['a', 'b', 'c'] } },
        {},
        info,
      ),
    ).rejects.toMatchObject({
      message: 'input.title: A note needs a title; input.tags: At most two tags',
      extensions: {
        code: BAD_USER_INPUT,
        issues: [
          { message: 'A note needs a title', path: ['input', 'title'] },
          { message: 'At most two tags', path: ['input', 'tags'] },
        ],
      },
    });
  });

  it('names the parsed args type', () => {
    expectTypeOf<ValidatedArgs<typeof CreateNoteArgs>>().toEqualTypeOf<{
      input: { title: string; tags: string[]; priority: number };
    }>();
    expectTypeOf<ValidatedArgs<typeof NoteArgs>>().toEqualTypeOf<Parsed>();
  });
});

describe('validateArgs — through applyPermissions', () => {
  const typeDefs = /* GraphQL */ `
    input CreateNoteInput {
      title: String!
      tags: [String!]
    }
    type Note {
      id: ID!
      title: String!
      tags: [String!]!
    }
    type Query {
      notes(limit: Int): [Note!]!
    }
    type Mutation {
      createNote(input: CreateNoteInput!): Note
    }
  `;

  const CreateNoteArgs = standard<{ input: Parsed }>((value) => {
    const result = parseNote((value as { input?: Input }).input);
    if (result.issues) {
      return {
        issues: result.issues.map((issue) => ({
          ...issue,
          path: ['input', ...(issue.path ?? [])],
        })),
      };
    }
    return { value: { input: result.value } };
  });

  const Limit = standard<{ limit: number }>((value) => {
    const limit = (value as { limit?: number | null }).limit ?? 10;
    return limit > 100
      ? { issues: [{ message: 'At most 100', path: ['limit'] }] }
      : { value: { limit } };
  });

  type LooseMap = PermissionsMap<Record<string, Record<string, unknown>>>;

  function guarded(permissions: LooseMap, options?: ApplyPermissionsOptions) {
    const received: unknown[] = [];
    const schema = applyPermissions(
      makeExecutableSchema({
        typeDefs,
        resolvers: {
          Query: {
            notes: (_parent: unknown, args: unknown) => {
              received.push(args);
              return [{ id: '1', title: 'one', tags: [] }];
            },
          },
          Mutation: {
            createNote: (_parent: unknown, args: { input: Parsed }) => {
              received.push(args);
              return { id: '1', ...args.input };
            },
          },
        },
      }),
      permissions,
      options,
    );
    return { schema, received };
  }

  const CREATE = 'mutation { createNote(input: { title: "  hello " }) { id title tags } }';
  const CREATE_BLANK = 'mutation { createNote(input: { title: " " }) { id } }';

  async function run(schema: GraphQLSchema, source: string, contextValue: unknown = {}) {
    return reportDenials(contextValue, await graphql({ schema, source, contextValue }));
  }

  it('hands the resolver the parsed args', async () => {
    const { schema, received } = guarded({
      Mutation: { createNote: validateArgs(CreateNoteArgs) },
    });
    const result = await run(schema, CREATE);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createNote: { id: '1', title: 'hello', tags: [] } });
    expect(received).toEqual([{ input: { title: 'hello', tags: [] } }]);
  });

  it('reports a failure with its own code and issues, at the field', async () => {
    const { schema, received } = guarded({
      Mutation: { createNote: validateArgs(CreateNoteArgs) },
    });
    const result = await run(schema, CREATE_BLANK);
    expect(result.data).toEqual({ createNote: null });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe('input.title: A note needs a title');
    expect(result.errors?.[0]?.path).toEqual(['createNote']);
    expect(result.errors?.[0]?.extensions).toEqual({
      code: BAD_USER_INPUT,
      issues: [{ message: 'A note needs a title', path: ['input', 'title'] }],
    });
    expect(received).toEqual([]);
  });

  it('is not reworded by fallbackError — it named its own error', async () => {
    const { schema } = guarded(
      { Mutation: { createNote: validateArgs(CreateNoteArgs) } },
      {
        fallbackError: () =>
          new GraphQLError('Not Authorised!', { extensions: { code: 'FORBIDDEN' } }),
      },
    );
    const result = await run(schema, CREATE_BLANK);
    expect(result.errors?.[0]?.message).toBe('input.title: A note needs a title');
    expect(result.errors?.[0]?.extensions.code).toBe(BAD_USER_INPUT);
  });

  it('is unchanged by debug', async () => {
    const { schema } = guarded(
      { Mutation: { createNote: validateArgs(CreateNoteArgs) } },
      { debug: true, fallbackError: 'Not Authorised!' },
    );
    const result = await run(schema, CREATE_BLANK);
    expect(result.errors?.[0]?.message).toBe('input.title: A note needs a title');
    expect(result.errors?.[0]?.extensions.code).toBe(BAD_USER_INPUT);
  });

  it("keeps its own code under onDeny: 'filter', on a field that carries the error itself", async () => {
    const { schema } = guarded(
      { Mutation: { createNote: validateArgs(CreateNoteArgs) } },
      { onDeny: 'filter', fallbackError: 'Not Authorised!' },
    );
    const result = await run(schema, CREATE_BLANK);
    expect(result.data).toEqual({ createNote: null });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.extensions.code).toBe(BAD_USER_INPUT);
    expect(result.errors?.[0]?.message).toBe('input.title: A note needs a title');
  });

  it("keeps its own code under onDeny: 'filter' through reportDenials too", async () => {
    const { schema, received } = guarded(
      { Query: { notes: validateArgs(Limit) } },
      { onDeny: 'filter' },
    );
    const result = await run(schema, '{ notes(limit: 1000) { id } }');
    expect(result.data).toEqual({ notes: [] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.path).toEqual(['notes']);
    expect(result.errors?.[0]?.extensions).toEqual({
      code: BAD_USER_INPUT,
      issues: [{ message: 'At most 100', path: ['limit'] }],
    });
    expect(received).toEqual([]);

    // A real denial on the same field still takes the standard code.
    const denied = guarded({ Query: { notes: deny } }, { onDeny: 'filter' });
    const other = await run(denied.schema, '{ notes { id } }');
    expect(other.errors?.[0]?.extensions).toEqual({ code: UNAUTHORIZED_FIELD_OR_TYPE });
  });

  it("is masked under onDeny: 'mask', like any other refusal", async () => {
    const { schema } = guarded(
      { Mutation: { createNote: validateArgs(CreateNoteArgs) } },
      { onDeny: 'mask' },
    );
    const result = await run(schema, CREATE_BLANK);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createNote: null });
  });

  it('treats a validator that throws as a rule failure: fallbackError replaces it, debug reveals it', async () => {
    const throwing = standard<never>(() => {
      throw new Error('validator exploded');
    });
    const replaced = guarded(
      { Mutation: { createNote: validateArgs(throwing) } },
      { fallbackError: 'Not Authorised!' },
    );
    expect((await run(replaced.schema, CREATE)).errors?.[0]?.message).toBe('Not Authorised!');

    const revealed = guarded(
      { Mutation: { createNote: validateArgs(throwing) } },
      { fallbackError: 'Not Authorised!', debug: true },
    );
    expect((await run(revealed.schema, CREATE)).errors?.[0]?.message).toBe('validator exploded');
  });

  it('composes with a createCan gate through wrap', async () => {
    type SubjectMap = { Note: { id: string; title: string } };
    type Context = { userId?: string };
    const canUser = createCan<Context, SubjectMap>(
      async () => {
        const { can, build } = createGraphQLAbility<SubjectMap>();
        can(Actions.create, 'Note');
        return build();
      },
      (ctx) => ctx.userId != null,
      createTyped<SubjectMap>(),
    );
    const validate = vi.fn(CreateNoteArgs['~standard'].validate);
    const validating = validateArgs(standard(validate));
    const { schema, received } = guarded({
      Mutation: { createNote: wrap(canUser(Actions.create, 'Note'), validating) },
    });

    // The gate decides first: an anonymous caller learns that, not what is
    // wrong with their input.
    const anonymous = await run(schema, CREATE_BLANK, {});
    expect(anonymous.errors?.[0]?.message).toBe('Not authenticated');
    expect(validate).not.toHaveBeenCalled();

    const invalid = await run(schema, CREATE_BLANK, { userId: 'u1' });
    expect(invalid.errors?.[0]?.extensions.code).toBe(BAD_USER_INPUT);
    expect(received).toEqual([]);

    const valid = await run(schema, CREATE, { userId: 'u1' });
    expect(valid.errors).toBeUndefined();
    expect(received).toEqual([{ input: { title: 'hello', tags: [] } }]);
  });
});
