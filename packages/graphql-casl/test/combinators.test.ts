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
