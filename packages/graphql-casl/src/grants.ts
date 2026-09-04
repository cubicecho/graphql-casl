/**
 * Granted scopes: a parent field's authorization, reused by the fields of what
 * it returned.
 *
 * {@link grants} wraps the rule on a field that returns objects — a list, a
 * lookup — and, once that rule has passed and the resolver has answered, tags
 * each returned object with a named scope for the rest of the request.
 * {@link granted} is the rule a child field puts on the other end: it passes
 * when its `parent` carries that scope, and answers synchronously, so a type
 * whose rows were already authorized by the field that loaded them resolves
 * without re-asking CASL once per field per row.
 *
 * This is Pothos' `grantScopes` / `$granted`. As there, a grant is separate
 * from every other permission and does **not** inherit transitively: a scope
 * granted to a `Post` says nothing about the `User` its `author` field returns,
 * unless that field grants too.
 */

import { SCOPE_INFO, type ScopeInfo } from './internal.js';
import { type CheckableRule, isThenable, type Rule, rule } from './rules.js';

/**
 * Every grant made in every live request: the scopes each object was granted,
 * keyed on the context the request ran under.
 *
 * Both maps are weak. A context is created per request and dropped with it, so
 * a request's grants are unreachable once the request is, and an object tagged
 * in one request is untagged in every other — a second context finds nothing.
 * Nothing is ever shared between requests, or between two copies of the same
 * row loaded by two requests.
 */
const grantsByContext = new WeakMap<object, WeakMap<object, Set<string>>>();

/** Whether a value can key a `WeakMap` — and so can carry, or hang, a grant. */
function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Tags a resolved value with `scopes` for the request `context` identifies:
 * the object itself, or every object in a list (nested lists included, since
 * `[[Post]]` is a legal field type). `null`, scalars and anything else that
 * cannot be a `parent` carry nothing.
 */
function tag(context: object, value: unknown, scopes: readonly string[]): void {
  if (!isObject(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) tag(context, item, scopes);
    return;
  }
  let byObject = grantsByContext.get(context);
  if (!byObject) {
    byObject = new WeakMap();
    grantsByContext.set(context, byObject);
  }
  let held = byObject.get(value);
  if (!held) {
    held = new Set();
    byObject.set(value, held);
  }
  for (const scope of scopes) held.add(scope);
}

/** Whether `parent` was granted `scope` in the request `context` identifies. */
function hasGrant(context: unknown, parent: unknown, scope: string): boolean {
  if (!isObject(context) || !isObject(parent)) return false;
  return grantsByContext.get(context)?.get(parent)?.has(scope) === true;
}

/** The scopes a {@link grants} call names, validated. */
function scopesOf(scope: string | readonly string[]): readonly string[] {
  const scopes = typeof scope === 'string' ? [scope] : [...scope];
  if (scopes.length === 0 || scopes.some((name) => typeof name !== 'string' || name === '')) {
    throw new Error(
      'graphql-casl: `grants()` needs a scope name — a non-empty string, or a list of them.',
    );
  }
  return scopes;
}

/**
 * Wraps a rule so that, when it passes and the resolver returns, what it
 * returned is **granted** `scope` for the rest of the request — the object
 * itself, or each object of a list. A child field guarded by
 * {@link granted}`(scope)` then passes on those objects without a check of its
 * own.
 *
 * ```ts
 * Query: { posts: grants(canUser(Actions.read, Subject.Post), 'post') },
 * Post: race(granted('post'), canUser.fields(Actions.read, Subject.Post)),
 * ```
 *
 * The grant is made *after* the wrapped rule has let the resolver run and the
 * resolver has answered, so a denial grants nothing, a resolver error grants
 * nothing, and a post-execution rule (`canUser.onResult`) that rejects a row
 * grants nothing either — only what the field actually hands to its children
 * is tagged. `null` and scalars are ignored: they cannot be a `parent`.
 *
 * Grants hang off the request's context object in a `WeakMap`, so they are
 * unreachable once the request is and a second request sees none of them. A
 * context that is not an object cannot be a `WeakMap` key, so such a request
 * grants nothing and every `granted` rule in it denies — the safe direction.
 *
 * A grant does **not** inherit transitively. `Post.author` returns a `User`; the
 * `User` is not granted `'post'`, and `User`'s fields still need their own rule
 * — or `Post.author` grants in turn.
 *
 * Any rule can be wrapped: one built by `rule()` or `createCan`, a combinator,
 * `canUser.onResult(...)`, `scopeArgs(...)`, a `wrap(...)`. The result is a
 * plain {@link Rule}, never a {@link CheckableRule}: it decides by running the
 * resolver, so it cannot be an operand of `and` / `or` / `not` / `chain` /
 * `race`. Compose it with `wrap` instead, or combine the rule *inside* it.
 *
 * @param inner - The rule that authorizes the field. Its verdict is unchanged.
 * @param scope - The scope name, or a list of names, to grant.
 * @returns A rule with `inner`'s verdict that also tags what the field returned.
 */
export function grants(inner: Rule, scope: string | readonly string[]): Rule {
  if (typeof inner !== 'function') {
    throw new Error(`graphql-casl: \`grants()\` expects a rule, got ${typeof inner}.`);
  }
  const scopes = scopesOf(scope);

  const granting: Rule = (resolve, parent, args, context, info) => {
    const out = inner(resolve, parent, args, context, info);
    // Nothing to hang the grants off — see the module comment.
    if (!isObject(context)) return out;
    if (isThenable(out)) {
      return Promise.resolve(out).then((value) => {
        tag(context, value, scopes);
        return value;
      });
    }
    // Synchronous end to end when the inner rule and the resolver both are:
    // the tagging costs no promise, so the field stays on the sync path.
    tag(context, out, scopes);
    return out;
  };

  // An argument-scoping rule advertises the argument it injects into so
  // `applyPermissions` can check the field declares it. Wrapping one must not
  // hide that — the same care `wrap()` takes.
  const scopeInfo = (inner as Partial<Record<typeof SCOPE_INFO, ScopeInfo>>)[SCOPE_INFO];
  if (scopeInfo) Object.defineProperty(granting, SCOPE_INFO, { value: scopeInfo });
  return granting;
}

/**
 * A {@link CheckableRule} that passes when the field's `parent` was
 * {@link grants | granted} `scope` earlier in this request, and denies with
 * `Forbidden` otherwise.
 *
 * The check is synchronous — a `WeakMap` lookup — so a field it guards resolves
 * without a promise, and it needs no `cache`: it is already cheaper than a
 * cache hit. Put it first in a `race` so the fallback check only runs for rows
 * that arrived some other way:
 *
 * ```ts
 * Post: race(granted('post'), canUser.fields(Actions.read, Subject.Post)),
 * ```
 *
 * On its own it is deny-by-default: a `Post` that no granting field returned —
 * one reached through a field that does not grant, or a root field's `parent`,
 * which is no object at all — is denied. That is what makes it a *scope*
 * rather than a bypass. Use `race` / `or` when the type is also reachable by
 * paths that should authorize it themselves.
 *
 * @param scope - The scope name to look for.
 */
export function granted(scope: string): CheckableRule {
  if (typeof scope !== 'string' || scope === '') {
    throw new Error('graphql-casl: `granted()` needs a scope name — a non-empty string.');
  }
  return rule((parent, _args, context) => hasGrant(context, parent, scope), {
    name: `granted(${scope})`,
  });
}
