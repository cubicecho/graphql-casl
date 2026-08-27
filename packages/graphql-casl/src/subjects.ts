/**
 * Subject helpers: bind a subject-name namespace and a `typed()` tagger to a
 * specific {@link SubjectMap}. No external dependencies.
 *
 * @see {@link SubjectMap} from `./schemaTypes.js` for deriving `TMap`.
 */

/**
 * A subject-name namespace: every key of `TMap` mapped to its own name as a
 * string literal. `Subject.User` has type `'User'`, not `string`.
 *
 * @typeParam TMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type Subjects<TMap> = { readonly [K in string & keyof TMap]: K };

/**
 * Returns a {@link Subjects} namespace for `TMap` — autocompleted, typo-proof
 * subject names, with nothing to declare.
 *
 * The names live entirely in `TMap`, so there is no list to keep in step with
 * the schema: adding a type to the schema makes `Subject.NewType` available on
 * the next codegen run, and removing one turns every reference into a compile
 * error. Bound to a map exactly like {@link createTyped}.
 *
 * Note that `Subject` is a convenience, not a requirement — every API that takes
 * a subject name accepts the bare string literal and checks it just as strictly,
 * so `can('read', 'User')` is equivalent to `can('read', Subject.User)`. Reach
 * for this when you want the autocomplete and the rename/find-references anchor.
 *
 * The returned object is a `Proxy` that answers every property with its own
 * name, so it cannot be enumerated: `Object.keys(Subject)` is `[]`, spreading it
 * yields `{}`, and `JSON.stringify` gives `"{}"`. Property access is the only
 * supported operation. Symbol properties read as `undefined` so the object still
 * behaves normally when inspected, awaited, or coerced.
 *
 * @typeParam TMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @returns A namespace mapping each subject name to itself.
 * @example
 * ```ts
 * const Subject = subjectsOf<AppSubjectMap>();
 *
 * ability.can('read', Subject.User); // typed literal 'User', not plain string
 * Subject.Uesr;                      // compile error: no such property
 * ```
 */
export function subjectsOf<TMap extends Record<string, object>>(): Subjects<TMap> {
  return new Proxy(Object.create(null), {
    // Every string key answers with itself; the type parameter is what restricts
    // which keys are reachable, so there is nothing to look up.
    get: (_target, property) => (typeof property === 'symbol' ? undefined : property),
  }) as Subjects<TMap>;
}

/**
 * Returns a helper that validates a subject-name const object against the keys
 * of `TMap`.
 *
 * The object's keys must exactly cover the derived domain type names — TypeScript
 * errors if any are missing or misspelled. Values equal keys so each entry can be
 * used directly in CASL calls.
 *
 * @deprecated Use {@link subjectsOf}, which needs no object and stays in step
 * with the schema on its own. This restates names `TMap` already carries, so
 * every type added to the schema has to be listed here too — interfaces and
 * unions included — before anything compiles again. It keeps working and is not
 * scheduled for removal.
 *
 * @typeParam TMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @example
 * ```ts
 * const Subject = createSubjects<AppSubjectMap>()({
 *   User: 'User', Note: 'Note', Org: 'Org', OrgMember: 'OrgMember',
 * } as const);
 *
 * ability.can('read', Subject.User); // typed literal 'User', not plain string
 * ```
 */
export function createSubjects<TMap extends Record<string, object>>() {
  return function subjects<T extends Record<string & keyof TMap, string & keyof TMap>>(map: T): T {
    return map;
  };
}

/**
 * Returns a `typed(type, attrs)` helper bound to a specific subject map.
 *
 * Call once at the app level to tag plain objects with a required `__typename`
 * so CASL can classify them — both at runtime (`detectSubjectType`) and at the
 * type level, where the narrowed `__typename` makes the object satisfy a typed
 * `GraphQLAbility`'s `can`/`cannot` subject parameter.
 *
 * @typeParam TMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @example
 * ```ts
 * const typed = createTyped<AppSubjectMap>();
 * ability.can('update', typed('User', { id: targetId }));
 * ```
 */
export function createTyped<TMap extends Record<string, object>>() {
  return function typed<K extends string & keyof TMap>(
    type: K,
    attrs: Partial<TMap[K]>,
  ): TMap[K] & { __typename: K } {
    // Spread attrs first so the `__typename` tag always wins — an attrs object
    // that carries its own `__typename` must not be able to mis-tag the subject.
    return { ...attrs, __typename: type } as unknown as TMap[K] & { __typename: K };
  };
}
