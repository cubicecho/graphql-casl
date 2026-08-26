import type { GraphQLResolveInfo } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Action,
  Actions,
  accept,
  createCan,
  createGraphQLAbility,
  createSubjects,
  createTyped,
  deny,
  type GraphQLAbility,
  type PermissionsMap,
  type Rule,
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

// A stand-in resolve info object — rules never read it, so an empty cast is fine.
const info = {} as GraphQLResolveInfo;

describe('accept / deny', () => {
  it('accept invokes resolve and returns its value', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(accept(resolve, 'parent', 'args', {}, info)).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('parent', 'args', {}, info);
  });

  it('deny always throws Forbidden', () => {
    expect(() => deny(vi.fn(), null, null, {}, info)).toThrow('Forbidden');
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
});
