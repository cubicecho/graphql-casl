import { GraphQLObjectType, type GraphQLResolveInfo, GraphQLSchema, GraphQLString } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Action,
  Actions,
  accept,
  and,
  createCan,
  createGraphQLAbility,
  createSubjects,
  createTyped,
  deny,
  type GraphQLAbility,
  isCheckableRule,
  or,
  type PermissionsMap,
  type RequireCan,
  type Rule,
  subjectsOf,
} from '../src/index.js';

// An example subject map — in a real app this comes from SubjectMap<Resolvers, ResolversTypes>.
type ExampleSubjectMap = {
  Note: { id: string; userId: string };
  Org: { id: string };
};

type TestAbility = GraphQLAbility<ExampleSubjectMap>;

interface TestContext {
  userId?: string;
}

const typed = createTyped<ExampleSubjectMap>();

function buildAbility(userId: string | undefined): TestAbility {
  const { can, build } = createGraphQLAbility<ExampleSubjectMap>();
  if (!userId) return build(); // no rules ⇒ everything denied
  can(Actions.read, 'Note');
  can(Actions.update, 'Note', { userId });
  return build();
}

// A stand-in resolve info object — most rules never read it, so an empty cast is fine.
const info = {} as GraphQLResolveInfo;

// onResult does read info (to refuse root mutation fields), so it needs a schema
// whose mutation type is absent.
const queryOnlySchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields: { note: { type: GraphQLString } } }),
});
const resultInfo = {
  schema: queryOnlySchema,
  parentType: queryOnlySchema.getQueryType(),
  fieldName: 'note',
} as unknown as GraphQLResolveInfo;

describe('accept / deny', () => {
  it('accept invokes resolve and returns its value', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(accept(resolve, 'parent', 'args', {}, info)).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('parent', 'args', {}, info);
  });

  it('deny always rejects with Forbidden without resolving', async () => {
    const resolve = vi.fn();
    await expect(deny(resolve, null, null, {}, info)).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('both are checkable, so they can be combinator operands', () => {
    expect(isCheckableRule(accept)).toBe(true);
    expect(isCheckableRule(deny)).toBe(true);
  });
});

describe('createCan', () => {
  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => buildAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  it('throws when the context is not authenticated', async () => {
    const rule = canUser(Actions.read, 'Note');
    await expect(rule(vi.fn(), null, {}, {}, info)).rejects.toThrow('Not authenticated');
  });

  it('allows when the ability grants the action on a bare subject', async () => {
    const resolve = vi.fn().mockResolvedValue('note');
    const rule = canUser(Actions.read, 'Note');
    await expect(rule(resolve, null, {}, { userId: 'u1' }, info)).resolves.toBe('note');
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('forbids when subject conditions do not match', async () => {
    const rule = canUser(Actions.update, 'Note', (args: { userId: string }) => ({
      userId: args.userId,
    }));
    const resolve = vi.fn();
    await expect(
      rule(resolve, null, { userId: 'someone-else' }, { userId: 'u1' }, info),
    ).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows when subject conditions match via a typed subject', async () => {
    const resolve = vi.fn().mockResolvedValue('updated');
    const rule = canUser(Actions.update, 'Note', (args: { userId: string }) => ({
      userId: args.userId,
    }));
    await expect(rule(resolve, null, { userId: 'u1' }, { userId: 'u1' }, info)).resolves.toBe(
      'updated',
    );
  });

  it('types getSubjectData against the subject fields (compile-time)', () => {
    // @ts-expect-error `nope` is not a field of Note
    canUser(Actions.update, 'Note', (args: { x: string }) => ({ nope: args.x }));
    // a real field typechecks
    canUser(Actions.update, 'Note', (args: { userId: string }) => ({ userId: args.userId }));
    expect(true).toBe(true);
  });

  it('throws if getSubjectData is used without configuring buildSubject', () => {
    // Omitting buildSubject yields the RequireCanBare overload, which forbids
    // getSubjectData at compile time; cast past it to exercise the runtime guard.
    const canBare = createCan<TestContext, ExampleSubjectMap>(
      async (ctx) => buildAbility(ctx.userId),
      (ctx) => ctx.userId != null,
    ) as unknown as (
      action: Action,
      subject: string,
      getSubjectData: (args: unknown) => Record<string, unknown>,
    ) => unknown;
    expect(() => canBare(Actions.update, 'Note', () => ({ userId: 'u1' }))).toThrow(
      /requires a `buildSubject` tagger/,
    );
  });
});

describe('createTyped', () => {
  it('tags attrs with __typename', () => {
    expect(typed('Note', { id: '1' })).toEqual({ __typename: 'Note', id: '1' });
  });

  it('the __typename tag wins over a conflicting attrs.__typename', () => {
    // A caller (via JS/cast) cannot mis-tag the subject through attrs.
    const tagged = typed('Note', { __typename: 'Org', id: '1' } as never);
    expect(tagged.__typename).toBe('Note');
  });
});

describe('createSubjects', () => {
  it('returns the provided subject map unchanged', () => {
    const Subject = createSubjects<ExampleSubjectMap>()({ Note: 'Note', Org: 'Org' } as const);
    expect(Subject.Note).toBe('Note');
    expect(Subject.Org).toBe('Org');
  });
});

describe('subjectsOf', () => {
  const Subject = subjectsOf<ExampleSubjectMap>();

  it('answers every subject name with itself, with nothing declared', () => {
    expect(Subject.Note).toBe('Note');
    expect(Subject.Org).toBe('Org');
  });

  it('produces names CASL accepts as bare subjects', () => {
    const ability = buildAbility('u1');
    expect(ability.can(Actions.read, Subject.Note)).toBe(true);
    expect(ability.can(Actions.update, typed(Subject.Note, { userId: 'u1' }))).toBe(true);
    expect(ability.can(Actions.update, typed(Subject.Note, { userId: 'u2' }))).toBe(false);
  });

  it('reads symbol properties as undefined so ordinary object handling is safe', () => {
    // A Proxy that answered symbols with a string would make the object look
    // thenable/iterable and break `await`, spreads and inspection.
    const asRecord = Subject as unknown as Record<symbol, unknown>;
    expect(asRecord[Symbol.toPrimitive]).toBeUndefined();
    expect(asRecord[Symbol.iterator]).toBeUndefined();
    expect(() => String(`${Subject.Note}`)).not.toThrow();
  });

  it('is not enumerable — property access is the only supported operation', () => {
    // Documented limitation: the names live only in the type, so there is
    // nothing to enumerate at runtime.
    expect(Object.keys(Subject)).toEqual([]);
    expect({ ...Subject }).toEqual({});
    expect(JSON.stringify(Subject)).toBe('{}');
  });
});

describe('createCan — unconditioned subject checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `can('update', 'Note')` asks CASL whether updating a Note is possible at all,
  // so a conditions-only grant makes it pass for everyone. Nothing in the type
  // system catches that, hence the runtime guard.
  it('the underlying CASL behaviour this guards against', async () => {
    const ability = buildAbility('u1');
    expect(ability.can(Actions.update, 'Note')).toBe(true);
    expect(ability.can(Actions.update, typed('Note', { userId: 'someone-else' }))).toBe(false);
  });

  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => buildAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  it('warns by default, and only once per rule', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rule = canUser(Actions.update, 'Note');
    const resolve = vi.fn().mockResolvedValue('note');

    await expect(rule(resolve, null, {}, { userId: 'u1' }, info)).resolves.toBe('note');
    await expect(rule(resolve, null, {}, { userId: 'u2' }, info)).resolves.toBe('note');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /every rule granting 'update' on 'Note' has conditions/,
    );
  });

  it("throws instead of allowing under onUnconditionedSubject: 'throw'", async () => {
    const canStrict = createCan<TestContext, ExampleSubjectMap>(
      async (ctx) => buildAbility(ctx.userId),
      (ctx) => ctx.userId != null,
      typed,
      { onUnconditionedSubject: 'throw' },
    );
    const resolve = vi.fn();
    await expect(
      canStrict(Actions.update, 'Note')(resolve, null, {}, { userId: 'u1' }, info),
    ).rejects.toThrow(/was checked without `getSubjectData`/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("stays silent under onUnconditionedSubject: 'allow'", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canLoose = createCan<TestContext, ExampleSubjectMap>(
      async (ctx) => buildAbility(ctx.userId),
      (ctx) => ctx.userId != null,
      typed,
      { onUnconditionedSubject: 'allow' },
    );
    const resolve = vi.fn().mockResolvedValue('note');
    await expect(
      canLoose(Actions.update, 'Note')(resolve, null, {}, { userId: 'u1' }, info),
    ).resolves.toBe('note');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts options in buildSubject position when no tagger is used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canBare = createCan<TestContext, ExampleSubjectMap>(
      async (ctx) => buildAbility(ctx.userId),
      (ctx) => ctx.userId != null,
      { onUnconditionedSubject: 'allow' },
    );
    await expect(
      canBare(Actions.update, 'Note')(
        vi.fn().mockResolvedValue('note'),
        null,
        {},
        { userId: 'u1' },
        info,
      ),
    ).resolves.toBe('note');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when an unconditioned rule grants the action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await canUser(Actions.read, 'Note')(
      vi.fn().mockResolvedValue('note'),
      null,
      {},
      { userId: 'u1' },
      info,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing grants the action, since the check denies anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      canUser(Actions.delete, 'Note')(vi.fn(), null, {}, { userId: 'u1' }, info),
    ).rejects.toThrow('Forbidden');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when getSubjectData is supplied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rule = canUser(Actions.update, 'Note', (args: { userId: string }) => ({
      userId: args.userId,
    }));
    await rule(
      vi.fn().mockResolvedValue('updated'),
      null,
      { userId: 'u1' },
      { userId: 'u1' },
      info,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the ability cannot be introspected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canOpaque = createCan<TestContext, ExampleSubjectMap>(
      async () => ({ can: () => true }),
      () => true,
      typed,
    );
    await canOpaque(Actions.update, 'Note')(
      vi.fn().mockResolvedValue('ok'),
      null,
      {},
      { userId: 'u1' },
      info,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createCan — ability memoization', () => {
  it('builds the ability once per context, across every rule of the factory', async () => {
    const getAbility = vi.fn(async (ctx: TestContext) => buildAbility(ctx.userId));
    const canUser = createCan<TestContext, ExampleSubjectMap>(
      getAbility,
      (ctx) => ctx.userId != null,
      typed,
    );
    const read = canUser(Actions.read, 'Note');
    const update = canUser(Actions.update, 'Note', (args: { userId: string }) => ({
      userId: args.userId,
    }));
    const ctx: TestContext = { userId: 'u1' };
    const resolve = vi.fn().mockResolvedValue('ok');

    await Promise.all([
      read(resolve, null, {}, ctx, info),
      read(resolve, null, {}, ctx, info),
      update(resolve, null, { userId: 'u1' }, ctx, info),
    ]);

    expect(getAbility).toHaveBeenCalledOnce();
  });

  it('builds a fresh ability for a different context object', async () => {
    const getAbility = vi.fn(async (ctx: TestContext) => buildAbility(ctx.userId));
    const canUser = createCan<TestContext, ExampleSubjectMap>(
      getAbility,
      (ctx) => ctx.userId != null,
      typed,
    );
    const rule = canUser(Actions.read, 'Note');
    const resolve = vi.fn().mockResolvedValue('ok');

    await rule(resolve, null, {}, { userId: 'u1' }, info);
    await rule(resolve, null, {}, { userId: 'u1' }, info);

    expect(getAbility).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected ability build', async () => {
    const getAbility = vi
      .fn<(ctx: TestContext) => Promise<TestAbility>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockImplementation(async (ctx) => buildAbility(ctx.userId));
    const canUser = createCan<TestContext, ExampleSubjectMap>(
      getAbility,
      (ctx) => ctx.userId != null,
      typed,
    );
    const rule = canUser(Actions.read, 'Note');
    const ctx: TestContext = { userId: 'u1' };

    await expect(rule(vi.fn(), null, {}, ctx, info)).rejects.toThrow('db down');
    await expect(rule(vi.fn().mockResolvedValue('ok'), null, {}, ctx, info)).resolves.toBe('ok');
    expect(getAbility).toHaveBeenCalledTimes(2);
  });

  it('still works when the context is not an object', async () => {
    const canUser = createCan<TestContext | undefined, ExampleSubjectMap>(
      async () => buildAbility('u1'),
      () => true,
      typed,
    );
    const rule = canUser(Actions.read, 'Note');
    await expect(rule(vi.fn().mockResolvedValue('ok'), null, {}, undefined, info)).resolves.toBe(
      'ok',
    );
  });
});

describe('PermissionsMap keys', () => {
  // `typescript-resolvers` emits these alongside the real fields; a rule attached
  // to one would never run, so they must not typecheck as rule targets.
  type FakeResolvers = {
    Query: { note?: unknown; notes?: unknown };
    Note: { id?: unknown; userId?: unknown; __isTypeOf?: unknown };
    Named: { id?: unknown; __resolveType?: unknown };
  };

  it('rejects __isTypeOf and __resolveType, and accepts real fields', () => {
    const rule: Rule = accept;
    const permissions: PermissionsMap<FakeResolvers> = {
      Query: { note: rule },
      Note: {
        id: rule,
        // @ts-expect-error `__isTypeOf` is not a schema field
        __isTypeOf: rule,
      },
      Named: {
        id: rule,
        // @ts-expect-error `__resolveType` is not a schema field
        __resolveType: rule,
      },
    };
    expect(permissions.Query).toBeDefined();
  });

  it('accepts the wildcard in either position, and still checks field names', () => {
    const rule: Rule = accept;
    const permissions: PermissionsMap<FakeResolvers> = {
      '*': {
        id: rule, // a field that exists somewhere in the schema
        '*': rule,
        // @ts-expect-error no type in the schema has an `emial` field
        emial: rule,
      },
      Note: { '*': rule, id: rule },
    };
    expect(permissions['*']).toBeDefined();
  });
});

describe('createCan.onResult — post-execution rules', () => {
  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => buildAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  // onResult reads info.schema/info.parentType to refuse root mutation fields,
  // so these tests need a real-ish info object rather than the empty cast above.
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { note: { type: GraphQLString } },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: { updateNote: { type: GraphQLString } },
    }),
  });

  function infoFor(typeName: 'Query' | 'Mutation', fieldName: string): GraphQLResolveInfo {
    const parentType = typeName === 'Query' ? schema.getQueryType() : schema.getMutationType();
    return { schema, parentType, fieldName } as unknown as GraphQLResolveInfo;
  }

  const queryInfo = infoFor('Query', 'note');

  it('throws when the context is not authenticated', async () => {
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(rule(vi.fn(), null, {}, {}, queryInfo)).rejects.toThrow('Not authenticated');
  });

  it('authorizes the resolved record, not the args', async () => {
    // The classic IDOR shape: the client asserts its own userId in args, but the
    // resolver loads someone else's note. The pre-execution form passes here.
    const args = { id: 'n1', userId: 'u1' };
    const preExec = canUser(Actions.update, 'Note', (a: typeof args) => ({ userId: a.userId }));
    await expect(
      preExec(vi.fn().mockResolvedValue('leaked'), null, args, { userId: 'u1' }, queryInfo),
    ).resolves.toBe('leaked');

    const resolve = vi.fn().mockResolvedValue({ id: 'n1', userId: 'someone-else' });
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(rule(resolve, null, args, { userId: 'u1' }, queryInfo)).rejects.toThrow(
      'Forbidden',
    );
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('allows when the resolved record matches the conditions', async () => {
    const note = { id: 'n1', userId: 'u1' };
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(vi.fn().mockResolvedValue(note), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toBe(note);
  });

  it('applies getSubjectData to each candidate', async () => {
    const rule = canUser.onResult(
      Actions.update,
      'Note',
      (row: { note: { id: string; userId: string } }) => row.note,
    );
    const wrapped = { note: { id: 'n1', userId: 'u1' } };
    await expect(
      rule(vi.fn().mockResolvedValue(wrapped), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toBe(wrapped);
  });

  it('denies the whole field when any list element fails', async () => {
    const list = [
      { id: 'n1', userId: 'u1' },
      { id: 'n2', userId: 'someone-else' },
    ];
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(vi.fn().mockResolvedValue(list), null, {}, { userId: 'u1' }, queryInfo),
    ).rejects.toThrow('Forbidden');
  });

  it('allows a list when every element passes', async () => {
    const list = [
      { id: 'n1', userId: 'u1' },
      { id: 'n2', userId: 'u1' },
    ];
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(vi.fn().mockResolvedValue(list), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toBe(list);
  });

  it('returns null and empty lists as-is — there is no subject to authorize', async () => {
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(vi.fn().mockResolvedValue(null), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toBeNull();
    await expect(
      rule(vi.fn().mockResolvedValue([]), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toEqual([]);
  });

  it('skips null elements inside a list', async () => {
    const list = [null, { id: 'n1', userId: 'u1' }];
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(vi.fn().mockResolvedValue(list), null, {}, { userId: 'u1' }, queryInfo),
    ).resolves.toBe(list);
  });

  it('refuses a root mutation field before the resolver runs', async () => {
    const resolve = vi.fn();
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(resolve, null, {}, { userId: 'u1' }, infoFor('Mutation', 'updateNote')),
    ).rejects.toThrow(/cannot guard the mutation field `Mutation.updateNote`/);
    // The point of checking up front: the side effect never happened.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('throws at construction without a buildSubject tagger', () => {
    const canBare = createCan<TestContext, ExampleSubjectMap>(
      async (ctx) => buildAbility(ctx.userId),
      (ctx) => ctx.userId != null,
    ) as unknown as RequireCan<ExampleSubjectMap>;
    expect(() => canBare.onResult(Actions.update, 'Note')).toThrow(
      /`onResult` requires a `buildSubject` tagger/,
    );
  });
});

describe('createCan — parent-aware getSubjectData', () => {
  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => buildAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  // The field-level shape: "read Note.userId only when the Note is yours" is a
  // condition on the parent, which the args of a field rule never carry.
  const fieldRule = canUser(
    Actions.update,
    'Note',
    (_args: Record<string, never>, parent: { userId: string }) => ({ userId: parent.userId }),
  );

  it('reads the condition off the parent, not the args', async () => {
    const resolve = vi.fn().mockResolvedValue('u1');
    await expect(fieldRule(resolve, { userId: 'u1' }, {}, { userId: 'u1' }, info)).resolves.toBe(
      'u1',
    );
  });

  it('forbids when the parent belongs to someone else', async () => {
    const resolve = vi.fn();
    await expect(
      fieldRule(resolve, { userId: 'someone-else' }, {}, { userId: 'u1' }, info),
    ).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still accepts a one-argument getSubjectData unchanged', async () => {
    // The parent parameter is additive: existing single-arg extractors keep
    // typechecking and keep behaving identically.
    const argsRule = canUser(Actions.update, 'Note', (args: { userId: string }) => ({
      userId: args.userId,
    }));
    await expect(
      argsRule(
        vi.fn().mockResolvedValue('ok'),
        { userId: 'irrelevant' },
        { userId: 'u1' },
        { userId: 'u1' },
        info,
      ),
    ).resolves.toBe('ok');
  });

  it('passes the parent to onResult extractors too', async () => {
    const seen: unknown[] = [];
    const rule = canUser.onResult(
      Actions.update,
      'Note',
      (result: { userId: string }, parent: { org: string }) => {
        seen.push(parent);
        return { userId: result.userId };
      },
    );
    const note = { userId: 'u1' };
    await expect(
      rule(vi.fn().mockResolvedValue(note), { org: 'o1' }, {}, { userId: 'u1' }, resultInfo),
    ).resolves.toBe(note);
    expect(seen).toEqual([{ org: 'o1' }]);
  });
});

describe('createCan — combinability', () => {
  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => buildAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  it('produces checkable rules that combine', async () => {
    const r = canUser(Actions.read, 'Note');
    expect(isCheckableRule(r)).toBe(true);
    // Org is denied for everyone by buildAbility, Note is readable — so `or`
    // passes and `and` does not.
    await expect(
      or(canUser(Actions.read, 'Org'), r)(
        vi.fn().mockResolvedValue('ok'),
        null,
        {},
        { userId: 'u1' },
        info,
      ),
    ).resolves.toBe('ok');
    await expect(
      and(canUser(Actions.read, 'Org'), r)(vi.fn(), null, {}, { userId: 'u1' }, info),
    ).rejects.toThrow('Forbidden');
  });

  it('surfaces Not authenticated through a combinator', async () => {
    await expect(and(canUser(Actions.read, 'Note'))(vi.fn(), null, {}, {}, info)).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('labels itself with the action and subject', () => {
    expect(canUser(Actions.read, 'Note').ruleName).toBe('can(read, Note)');
  });

  it('refuses an onResult rule as a combinator operand', () => {
    // Its verdict needs the resolved value, so it cannot be evaluated as one
    // branch of an `or` without running the resolver.
    expect(() => and(canUser.onResult(Actions.read, 'Note'), accept)).toThrow(
      /operand 0 is not a checkable rule/,
    );
  });
});

describe('createCan — CASL reason plumbing', () => {
  function abilityWithReason(userId: string | undefined): TestAbility {
    const { can, cannot, build } = createGraphQLAbility<ExampleSubjectMap>();
    if (!userId) return build();
    can(Actions.update, 'Note', { userId });
    cannot(Actions.update, 'Note', { id: 'locked' }).because('That note is locked');
    return build();
  }

  const canUser = createCan<TestContext, ExampleSubjectMap>(
    async (ctx) => abilityWithReason(ctx.userId),
    (ctx) => ctx.userId != null,
    typed,
  );

  const noteRule = canUser(Actions.update, 'Note', (args: { id: string; userId: string }) => ({
    id: args.id,
    userId: args.userId,
  }));

  it('uses a cannot(...).because reason as the denial message', async () => {
    await expect(
      noteRule(vi.fn(), null, { id: 'locked', userId: 'u1' }, { userId: 'u1' }, info),
    ).rejects.toThrow('That note is locked');
  });

  it('falls back to Forbidden when no rule supplied a reason', async () => {
    await expect(
      noteRule(vi.fn(), null, { id: 'n1', userId: 'someone-else' }, { userId: 'u1' }, info),
    ).rejects.toThrow('Forbidden');
  });

  it('does not leak the schema type name into the default denial', async () => {
    // CASL's own ForbiddenError would say `Cannot execute "update" on "Note"`,
    // which tells an unauthorized caller a type name. The reason is read off the
    // rule directly to avoid that.
    await expect(
      noteRule(vi.fn(), null, { id: 'n1', userId: 'someone-else' }, { userId: 'u1' }, info),
    ).rejects.toThrow(/^Forbidden$/);
  });

  it('reports the reason from onResult denials too', async () => {
    const rule = canUser.onResult(Actions.update, 'Note');
    await expect(
      rule(
        vi.fn().mockResolvedValue({ id: 'locked', userId: 'u1' }),
        null,
        {},
        { userId: 'u1' },
        resultInfo,
      ),
    ).rejects.toThrow('That note is locked');
  });
});

describe('createCan.fields — CASL field-level permissions', () => {
  type FieldSubjectMap = { User: { id: string; email: string; name: string } };
  const typedUser = createTyped<FieldSubjectMap>();

  function fieldAbility(userId: string | undefined) {
    const { can, build } = createGraphQLAbility<FieldSubjectMap>();
    if (!userId) return build();
    can(Actions.read, 'User', ['id', 'name']);
    can(Actions.read, 'User', ['email'], { id: userId }); // only your own
    return build();
  }

  const canUser = createCan<TestContext, FieldSubjectMap>(
    async (ctx) => fieldAbility(ctx.userId),
    (ctx) => ctx.userId != null,
    typedUser,
  );

  const rule = canUser.fields(Actions.read, 'User');

  function infoForField(fieldName: string): GraphQLResolveInfo {
    return { fieldName } as unknown as GraphQLResolveInfo;
  }

  it('allows a field the ability grants unconditionally', async () => {
    await expect(
      rule(
        vi.fn().mockResolvedValue('Ada'),
        { id: 'u2' },
        {},
        { userId: 'u1' },
        infoForField('name'),
      ),
    ).resolves.toBe('Ada');
  });

  it('decides a conditioned field from the parent object', async () => {
    // email is granted only when the User being read is your own.
    await expect(
      rule(
        vi.fn().mockResolvedValue('a@b.c'),
        { id: 'u1' },
        {},
        { userId: 'u1' },
        infoForField('email'),
      ),
    ).resolves.toBe('a@b.c');
    await expect(
      rule(vi.fn(), { id: 'u2' }, {}, { userId: 'u1' }, infoForField('email')),
    ).rejects.toThrow('Forbidden');
  });

  it('denies a field no ability rule mentions — deny by default across the type', async () => {
    const resolve = vi.fn();
    await expect(
      rule(resolve, { id: 'u1' }, {}, { userId: 'u1' }, infoForField('ssn')),
    ).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('throws Not authenticated before consulting the ability', async () => {
    await expect(rule(vi.fn(), { id: 'u1' }, {}, {}, infoForField('name'))).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('projects the subject with getSubjectData when supplied', async () => {
    const projected = canUser.fields(
      Actions.read,
      'User',
      (parent: { owner: { id: string } }) => parent.owner,
    );
    await expect(
      projected(
        vi.fn().mockResolvedValue('a@b.c'),
        { owner: { id: 'u1' } },
        {},
        { userId: 'u1' },
        infoForField('email'),
      ),
    ).resolves.toBe('a@b.c');
  });

  it('falls back to the bare subject name when there is no parent object', async () => {
    // A root field has no parent to be the subject, so the check degrades to
    // "is this field readable at all", which `email` is (for someone).
    await expect(
      rule(vi.fn().mockResolvedValue('a@b.c'), null, {}, { userId: 'u1' }, infoForField('email')),
    ).resolves.toBe('a@b.c');
    await expect(rule(vi.fn(), null, {}, { userId: 'u1' }, infoForField('ssn'))).rejects.toThrow(
      'Forbidden',
    );
  });

  it('is checkable, so it composes', () => {
    expect(isCheckableRule(rule)).toBe(true);
    expect(rule.ruleName).toBe('can(read, User, <field>)');
  });

  it('throws at construction without a buildSubject tagger', () => {
    const canBare = createCan<TestContext, FieldSubjectMap>(
      async (ctx) => fieldAbility(ctx.userId),
      (ctx) => ctx.userId != null,
    ) as unknown as RequireCan<FieldSubjectMap>;
    expect(() => canBare.fields(Actions.read, 'User')).toThrow(
      /`fields` requires a `buildSubject` tagger/,
    );
  });
});
