import type { GraphQLResolveInfo } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  accept,
  and,
  chain,
  deny,
  isCheckableRule,
  not,
  or,
  type Rule,
  race,
  rule,
  wrap,
} from '../src/index.js';

const info = {} as GraphQLResolveInfo;

/** A rule that passes or fails on demand and records that it was evaluated. */
function probe(result: boolean | string | Error, name = 'probe') {
  const calls: number[] = [];
  const r = rule(
    () => {
      calls.push(1);
      return result;
    },
    { name },
  );
  return {
    rule: r,
    get evaluated() {
      return calls.length;
    },
  };
}

/** A hand-written middleware rule — deliberately not checkable. */
const handWritten: Rule = async (resolve, parent, args, context, info) =>
  resolve(parent, args, context, info);

describe('rule', () => {
  it('resolves when the check returns true', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(rule(() => true)(resolve, 'p', 'a', {}, info)).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('p', 'a', {}, info);
  });

  it('denies with Forbidden when the check returns false', async () => {
    const resolve = vi.fn();
    await expect(rule(() => false)(resolve, null, null, {}, info)).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('denies with the message when the check returns a string', async () => {
    await expect(rule(() => 'Nope')(vi.fn(), null, null, {}, info)).rejects.toThrow('Nope');
  });

  it('throws the check′s Error as-is, preserving its type and properties', async () => {
    class AuthError extends Error {
      readonly code = 'FORBIDDEN';
    }
    const err = new AuthError('custom');
    await expect(rule(() => err)(vi.fn(), null, null, {}, info)).rejects.toBe(err);
  });

  it('lets an error raised inside the check propagate rather than becoming a denial', async () => {
    // A broken check must not be mistaken for a legitimate Forbidden.
    const boom = new Error('getAbility exploded');
    await expect(
      rule(() => {
        throw boom;
      })(vi.fn(), null, null, {}, info),
    ).rejects.toBe(boom);
  });

  it('passes the resolver arguments to the check, minus resolve', async () => {
    const check = vi.fn().mockReturnValue(true);
    await rule(check)(vi.fn(), 'parent', 'args', { userId: 'u1' }, info);
    expect(check).toHaveBeenCalledWith('parent', 'args', { userId: 'u1' }, info);
  });

  it('awaits an async check', async () => {
    await expect(rule(async () => 'async denial')(vi.fn(), null, null, {}, info)).rejects.toThrow(
      'async denial',
    );
  });

  it('is checkable and carries its name', () => {
    const r = rule(() => true, { name: 'isSelf' });
    expect(isCheckableRule(r)).toBe(true);
    expect(r.ruleName).toBe('isSelf');
  });

  it('does not treat a plain middleware rule as checkable', () => {
    expect(isCheckableRule(handWritten)).toBe(false);
  });
});

describe('rule — off-contract check results', () => {
  // `Check`'s context is `any`, so every property read off it is `any` and
  // assignable to RuleResult. This is the single most natural way to write a
  // check, it compiles clean, and `ctx.auth?.root` is `undefined` at runtime.
  const isRoot = rule((_parent, _args, ctx) => ctx.auth?.root, { name: 'isRoot' });

  it('denies rather than crashing when the check returns undefined', async () => {
    const resolve = vi.fn();
    await expect(isRoot(resolve, null, null, {}, info)).rejects.toThrow('Forbidden');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('denies when the check returns null', async () => {
    await expect(isRoot(vi.fn(), null, null, { auth: { root: null } }, info)).rejects.toThrow(
      'Forbidden',
    );
  });

  it('denies on any other falsy value', async () => {
    await expect(isRoot(vi.fn(), null, null, { auth: { root: 0 } }, info)).rejects.toThrow(
      'Forbidden',
    );
  });

  it('allows on a truthy non-boolean', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(isRoot(resolve, null, null, { auth: { root: 1 } }, info)).resolves.toBe('ok');
  });

  it('still reads a string as a denial message, not as truthiness', async () => {
    // Strings are on contract and must keep denying, truthy though they are.
    await expect(isRoot(vi.fn(), null, null, { auth: { root: 'Nope' } }, info)).rejects.toThrow(
      'Nope',
    );
  });

  it('propagates through the combinators', async () => {
    await expect(and(accept, isRoot)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
    await expect(or(isRoot, isRoot)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
    await expect(chain(accept, isRoot)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
    await expect(race(isRoot, isRoot)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(not(isRoot)(resolve, null, null, {}, info)).resolves.toBe('ok');
  });
});

describe('rule caching', () => {
  /** A check that counts its calls. */
  function counted(result: boolean | string = true) {
    let calls = 0;
    return {
      check: async () => {
        calls++;
        return result;
      },
      get calls() {
        return calls;
      },
    };
  }

  it('evaluates every time by default', async () => {
    const c = counted();
    const r = rule(c.check);
    const ctx = {};
    for (let i = 0; i < 3; i++) await r(vi.fn(), { id: i }, {}, ctx, info);
    expect(c.calls).toBe(3);
  });

  it('evaluates once per request under contextual', async () => {
    const c = counted();
    const r = rule(c.check, { cache: 'contextual' });
    const ctx = {};
    // Different parents and args, one context: the answer cannot depend on them.
    for (let i = 0; i < 3; i++) await r(vi.fn(), { id: i }, { n: i }, ctx, info);
    expect(c.calls).toBe(1);
  });

  it('does not reuse an answer across requests', async () => {
    const c = counted();
    const r = rule(c.check, { cache: 'contextual' });
    await r(vi.fn(), null, null, {}, info);
    await r(vi.fn(), null, null, {}, info);
    expect(c.calls).toBe(2);
  });

  it('keys on parent and args under strict', async () => {
    const c = counted();
    const r = rule(c.check, { cache: 'strict' });
    const ctx = {};
    const row = { id: 'n1' };
    // Same row, five fields: one evaluation.
    for (let i = 0; i < 5; i++) await r(vi.fn(), row, {}, ctx, info);
    expect(c.calls).toBe(1);
    // A different row is a different subject, so it must be re-evaluated.
    await r(vi.fn(), { id: 'n2' }, {}, ctx, info);
    expect(c.calls).toBe(2);
    // Same row, different args.
    await r(vi.fn(), row, { detailed: true }, ctx, info);
    expect(c.calls).toBe(3);
  });

  it('treats reordered arguments as the same key', async () => {
    const c = counted();
    const r = rule(c.check, { cache: 'strict' });
    const ctx = {};
    await r(vi.fn(), null, { a: 1, b: 2 }, ctx, info);
    await r(vi.fn(), null, { b: 2, a: 1 }, ctx, info);
    expect(c.calls).toBe(1);
  });

  it('shares one in-flight call between concurrent resolutions', async () => {
    // The point of caching the pending promise: a list must not stampede a
    // policy engine with 100 identical calls before the first one returns.
    let calls = 0;
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const r = rule(
      () => {
        calls++;
        return gate;
      },
      { cache: 'contextual' },
    );
    const ctx = {};
    const inFlight = [
      r(vi.fn().mockResolvedValue('ok'), null, null, ctx, info),
      r(vi.fn().mockResolvedValue('ok'), null, null, ctx, info),
    ];
    expect(calls).toBe(1);
    release(true);
    await expect(Promise.all(inFlight)).resolves.toEqual(['ok', 'ok']);
    expect(calls).toBe(1);
  });

  it('caches a rejection for the request, then retries on the next one', async () => {
    // A broken check should fail the request once, not once per field.
    const boom = new Error('policy engine unreachable');
    let calls = 0;
    const r = rule(
      () => {
        calls++;
        return Promise.reject(boom);
      },
      { cache: 'contextual' },
    );
    const ctx = {};
    await expect(r(vi.fn(), null, null, ctx, info)).rejects.toBe(boom);
    await expect(r(vi.fn(), null, null, ctx, info)).rejects.toBe(boom);
    expect(calls).toBe(1);
    await expect(r(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
    expect(calls).toBe(2);
  });

  it('falls back to evaluating every time when the context is not an object', async () => {
    // Nothing to hang a request-scoped cache off; must not throw, and must not
    // leak entries into a map that outlives the request.
    const c = counted();
    const r = rule(c.check, { cache: 'contextual' });
    await r(vi.fn(), null, null, undefined, info);
    await r(vi.fn(), null, null, undefined, info);
    expect(c.calls).toBe(2);
  });

  it('caches the check itself, so combinators reuse the answer too', async () => {
    const c = counted();
    const cachedRule = rule(c.check, { cache: 'contextual' });
    const ctx = {};
    await and(cachedRule, accept)(vi.fn().mockResolvedValue('ok'), null, null, ctx, info);
    await or(cachedRule, deny)(vi.fn().mockResolvedValue('ok'), null, null, ctx, info);
    expect(c.calls).toBe(1);
  });

  it('caches a denial as faithfully as a pass', async () => {
    const c = counted('Not a member');
    const r = rule(c.check, { cache: 'contextual' });
    const ctx = {};
    await expect(r(vi.fn(), null, null, ctx, info)).rejects.toThrow('Not a member');
    await expect(r(vi.fn(), null, null, ctx, info)).rejects.toThrow('Not a member');
    expect(c.calls).toBe(1);
  });

  it('gives each rule its own cache', async () => {
    const a = counted();
    const b = counted();
    const ctx = {};
    await rule(a.check, { cache: 'contextual' })(vi.fn(), null, null, ctx, info);
    await rule(b.check, { cache: 'contextual' })(vi.fn(), null, null, ctx, info);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

describe('and', () => {
  it('passes only when every operand passes', async () => {
    await expect(
      and(accept, accept)(vi.fn().mockResolvedValue('ok'), null, null, {}, info),
    ).resolves.toBe('ok');
    await expect(and(accept, deny)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
  });

  it('throws the first failing operand′s error, in operand order', async () => {
    const combined = and(
      rule(() => 'first'),
      rule(() => 'second'),
    );
    await expect(combined(vi.fn(), null, null, {}, info)).rejects.toThrow('first');
  });

  it('evaluates every operand even after one fails', async () => {
    const a = probe('no');
    const b = probe(true);
    await expect(and(a.rule, b.rule)(vi.fn(), null, null, {}, info)).rejects.toThrow('no');
    expect(b.evaluated).toBe(1);
  });
});

describe('or', () => {
  it('passes when any operand passes', async () => {
    await expect(
      or(deny, accept)(vi.fn().mockResolvedValue('ok'), null, null, {}, info),
    ).resolves.toBe('ok');
  });

  it('throws the last operand′s error when all fail', async () => {
    const combined = or(
      rule(() => 'first'),
      rule(() => 'last'),
    );
    await expect(combined(vi.fn(), null, null, {}, info)).rejects.toThrow('last');
  });

  it('evaluates every operand even after one passes', async () => {
    const a = probe(true);
    const b = probe(true);
    await or(a.rule, b.rule)(vi.fn().mockResolvedValue('ok'), null, null, {}, info);
    expect(b.evaluated).toBe(1);
  });
});

describe('chain', () => {
  it('stops at the first failure and does not evaluate the rest', async () => {
    const first = probe('denied');
    const second = probe(true);
    await expect(chain(first.rule, second.rule)(vi.fn(), null, null, {}, info)).rejects.toThrow(
      'denied',
    );
    expect(first.evaluated).toBe(1);
    expect(second.evaluated).toBe(0);
  });

  it('passes when every operand passes', async () => {
    await expect(
      chain(accept, accept)(vi.fn().mockResolvedValue('ok'), null, null, {}, info),
    ).resolves.toBe('ok');
  });
});

describe('race', () => {
  it('stops at the first pass and does not evaluate the rest', async () => {
    const first = probe(true);
    const second = probe(true);
    await expect(
      race(first.rule, second.rule)(vi.fn().mockResolvedValue('ok'), null, null, {}, info),
    ).resolves.toBe('ok');
    expect(second.evaluated).toBe(0);
  });

  it('throws the last operand′s error when all fail', async () => {
    await expect(
      race(
        rule(() => 'first'),
        rule(() => 'last'),
      )(vi.fn(), null, null, {}, info),
    ).rejects.toThrow('last');
  });
});

describe('a throwing operand', () => {
  // The shape a ported shield map is full of: a cheap guard combined with a
  // check that depends on it. `ctx.user` is absent, so `hasRole` throws rather
  // than denying — under shield that is a denial and the other branch carries
  // the field.
  const passes = rule(() => true, { name: 'passes' });
  const denies = rule(() => 'denied', { name: 'denies' });
  const boom = new Error('Cannot read properties of undefined');
  const throws = rule(
    () => {
      throw boom;
    },
    { name: 'throws' },
  );

  it('loses rather than poisons, in or(), whichever side it is on', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(or(passes, throws)(resolve, null, null, {}, info)).resolves.toBe('ok');
    await expect(or(throws, passes)(resolve, null, null, {}, info)).resolves.toBe('ok');
  });

  it('loses rather than poisons, in race()', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(race(throws, passes)(resolve, null, null, {}, info)).resolves.toBe('ok');
  });

  it('does not stop race() from reaching the operand after it', async () => {
    const after = probe(true, 'after');
    await race(throws, after.rule)(vi.fn().mockResolvedValue('ok'), null, null, {}, info);
    expect(after.evaluated).toBe(1);
  });

  it('rethrows unchanged when no operand passes, so it is not a denial', async () => {
    // A rule that broke is an outage to report, not an access decision — and it
    // must stay distinguishable from one for `debug` and `fallbackError`.
    await expect(or(denies, throws)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
    await expect(race(denies, throws)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
  });

  it('wins over a denial regardless of operand order', async () => {
    await expect(or(throws, denies)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
    await expect(race(throws, denies)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
  });

  it('still throws the last denial when nothing threw', async () => {
    // The existing contract, unchanged.
    await expect(
      or(
        rule(() => 'first'),
        rule(() => 'last'),
      )(vi.fn(), null, null, {}, info),
    ).rejects.toThrow('last');
  });

  it('keeps and() / chain() / not() strict', async () => {
    // A throw there decides nothing on its own, so it fails the rule outright.
    await expect(and(passes, throws)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
    await expect(chain(passes, throws)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
    // not() especially: a broken operand must never flip to allow.
    await expect(not(throws)(vi.fn(), null, null, {}, info)).rejects.toBe(boom);
  });

  it('is tolerated through nesting, since combinators compose', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(or(passes, and(passes, throws))(resolve, null, null, {}, info)).resolves.toBe(
      'ok',
    );
  });

  it('propagates a thrown non-Error unchanged', async () => {
    const thrower = rule(() => {
      throw 'a string';
    });
    await expect(or(denies, thrower)(vi.fn(), null, null, {}, info)).rejects.toBe('a string');
  });
});

describe('not', () => {
  it('inverts the operand', async () => {
    await expect(not(deny)(vi.fn().mockResolvedValue('ok'), null, null, {}, info)).resolves.toBe(
      'ok',
    );
    await expect(not(accept)(vi.fn(), null, null, {}, info)).rejects.toThrow('Forbidden');
  });

  it('uses the supplied error when the operand passes', async () => {
    await expect(
      not(accept, 'Not while impersonating')(vi.fn(), null, null, {}, info),
    ).rejects.toThrow('Not while impersonating');
  });

  it('discards the operand′s error — it explains why not() passed', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(not(rule(() => 'inner reason'))(resolve, null, null, {}, info)).resolves.toBe(
      'ok',
    );
  });
});

describe('combinator operand validation', () => {
  it('rejects a non-checkable operand at construction time, naming its position', () => {
    expect(() => and(accept, handWritten)).toThrow(/`and\(\)` operand 1 is not a checkable rule/);
  });

  it('rejects it before any request is served', () => {
    // The point of construction-time validation: the map cannot be built at all,
    // so a mis-combined rule can never silently guard a field in production.
    expect(() => or(handWritten)).toThrow();
    expect(() => chain(handWritten)).toThrow();
    expect(() => race(handWritten)).toThrow();
    expect(() => not(handWritten)).toThrow();
  });

  it('rejects an empty operand list', () => {
    expect(() => and()).toThrow(/`and\(\)` needs at least one rule/);
  });

  it('returns checkable rules, so combinators nest', async () => {
    const nested = and(or(deny, accept), not(deny));
    expect(isCheckableRule(nested)).toBe(true);
    await expect(nested(vi.fn().mockResolvedValue('ok'), null, null, {}, info)).resolves.toBe('ok');
  });

  it('names nested combinators for error messages', () => {
    expect(and(accept, deny).ruleName).toBe('and(accept, deny)');
    expect(or(accept, and(accept, deny)).ruleName).toBe('or(accept, and(accept, deny))');
  });
});

describe('wrap', () => {
  /** A middleware that rewrites one argument on its way through. */
  const rewriting =
    (name: string, value: unknown): Rule =>
    async (resolve, parent, args, context, info) =>
      resolve(parent, { ...(args as object), [name]: value }, context, info);

  it('nests rules so each receives the next as its resolver', async () => {
    const order: string[] = [];
    const step =
      (name: string): Rule =>
      async (resolve, parent, args, context, info) => {
        order.push(`${name}:in`);
        const result = await resolve(parent, args, context, info);
        order.push(`${name}:out`);
        return result;
      };
    const resolve = vi.fn().mockResolvedValue('ok');

    await expect(wrap(step('a'), step('b'))(resolve, 'p', 'a', {}, info)).resolves.toBe('ok');
    expect(order).toEqual(['a:in', 'b:in', 'b:out', 'a:out']);
  });

  it('applies operands left to right, outermost first', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await wrap(rewriting('x', 1), rewriting('y', 2))(resolve, 'p', {}, {}, info);
    expect(resolve).toHaveBeenCalledWith('p', { x: 1, y: 2 }, {}, info);
  });

  it('lets a later rule see an earlier rule′s rewritten arguments', async () => {
    const seen: unknown[] = [];
    const observe: Rule = async (resolve, parent, args, context, i) => {
      seen.push(args);
      return resolve(parent, args, context, i);
    };
    await wrap(rewriting('scope', 'mine'), observe)(vi.fn(), 'p', { own: true }, {}, info);
    expect(seen).toEqual([{ own: true, scope: 'mine' }]);
  });

  it('stops at a rule that denies, leaving the rest unrun', async () => {
    const resolve = vi.fn();
    const later = vi.fn();
    const spy: Rule = async (r, p, a, c, i) => {
      later();
      return r(p, a, c, i);
    };
    await expect(wrap(deny, spy)(resolve, null, null, {}, info)).rejects.toThrow('Forbidden');
    expect(later).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts rules the combinators reject', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    expect(() => and(accept, handWritten)).toThrow();
    await expect(wrap(accept, handWritten)(resolve, 'p', 'a', {}, info)).resolves.toBe('ok');
  });

  it('points at itself when a combinator is handed a wrapping rule', () => {
    expect(() => and(accept, handWritten)).toThrow(/Compose those with `wrap\(\)` instead/);
  });

  it('is never checkable, so it cannot be a combinator operand', () => {
    expect(isCheckableRule(wrap(accept, deny))).toBe(false);
    expect(() => chain(accept, wrap(accept))).toThrow(/operand 1 is not a checkable rule/);
  });

  it('substitutes its own context and info for a rule that drops them', async () => {
    const context = { user: 'u1' };
    const forgetful: Rule = async (resolve, parent, args) => resolve(parent, args);
    const resolve = vi.fn().mockResolvedValue('ok');
    await wrap(forgetful, accept)(resolve, 'p', 'a', context, info);
    expect(resolve).toHaveBeenCalledWith('p', 'a', context, info);
  });

  it('works with a single rule', async () => {
    const resolve = vi.fn().mockResolvedValue('ok');
    await expect(wrap(accept)(resolve, 'p', 'a', {}, info)).resolves.toBe('ok');
    await expect(wrap(deny)(resolve, 'p', 'a', {}, info)).rejects.toThrow('Forbidden');
  });

  it('rejects an empty call and a non-function operand', () => {
    expect(() => wrap()).toThrow(/needs at least one rule/);
    expect(() => wrap(accept, undefined as unknown as Rule)).toThrow(
      /operand 1 is undefined, not a rule/,
    );
  });
});
