/**
 * The envelop integration — the optional entry point,
 * `@vantreeseba/graphql-casl/envelop`.
 *
 * `applyPermissions` wraps a schema up front, which needs a schema you own
 * and can replace. That is awkward on Apollo Server 4+, on federated gateways,
 * and anywhere the schema is built or swapped for you. {@link useGraphQLCasl}
 * hooks resolvers as [envelop](https://the-guild.dev/graphql/envelop) hands them
 * over, so the same map works wherever envelop does — GraphQL Yoga, Apollo with
 * the envelop integration, Hive Gateway, `graphql-ws`.
 *
 * The permission logic itself is not reimplemented here: the plugin calls
 * {@link resolvePermissions}, so wildcard precedence, `fallbackRule` coverage,
 * error control, masking and map validation behave exactly as they do under
 * `applyPermissions`.
 *
 * `@envelop/core` and `@envelop/on-resolve` are **optional** peer dependencies —
 * they are only needed by consumers who import this entry point, which is why
 * the main entry point still has no runtime dependencies of its own.
 *
 * @example
 * ```ts
 * import { createYoga } from 'graphql-yoga';
 * import { useGraphQLCasl } from '@vantreeseba/graphql-casl/envelop';
 *
 * const yoga = createYoga({
 *   schema,
 *   plugins: [useGraphQLCasl<Resolvers>({ permissions, fallbackRule: deny })],
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { Plugin } from '@envelop/core';
import { useOnResolve } from '@envelop/on-resolve';
import type { GraphQLField, GraphQLSchema } from 'graphql';
import {
  type ApplyPermissionsOptions,
  type PermissionResolver,
  resolvePermissions,
} from './applyPermissions.js';
import type { PermissionsMap } from './rules.js';

/**
 * Options for {@link useGraphQLCasl}: the permissions map, plus every option
 * {@link ApplyPermissionsOptions | `applyPermissions`} accepts.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 */
export interface GraphQLCaslPluginOptions<TResolvers>
  // `inPlace` is about how `applyPermissions` hands back a schema; the plugin
  // never rebuilds one, so the option has nothing to mean here.
  extends Omit<ApplyPermissionsOptions, 'inPlace'> {
  /** The map to enforce. Validated against the schema when the schema arrives. */
  permissions: PermissionsMap<TResolvers>;
}

/**
 * An envelop plugin that enforces a {@link PermissionsMap}.
 *
 * The map is validated against the schema as soon as envelop provides one, so a
 * map naming a type or field the schema does not have throws a `PermissionsError`
 * at that point rather than mid-query. A schema swapped at runtime is
 * re-validated and re-resolved.
 *
 * Introspection is never guarded, and a field with no resolver of its own is
 * guarded too — the default resolver is wrapped like any other, which is what
 * makes a `canUser.fields(...)` rule on a plain object type work here.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @typeParam TContext - The plugin's context type.
 * @param options - The map and the {@link ApplyPermissionsOptions}.
 * @returns The envelop plugin.
 * @throws `PermissionsError` if the map does not line up with the schema.
 * @example
 * ```ts
 * const getEnveloped = envelop({
 *   plugins: [useSchema(schema), useGraphQLCasl<Resolvers>({ permissions })],
 * });
 * ```
 */
export function useGraphQLCasl<
  TResolvers,
  // biome-ignore lint/suspicious/noExplicitAny: envelop's own plugin context bound
  TContext extends Record<string, any> = Record<string, any>,
>(options: GraphQLCaslPluginOptions<TResolvers>): Plugin<TContext> {
  const { permissions, ...permissionOptions } = options;

  /** Per schema, because envelop may hand over a new one at any point. */
  const resolvers = new WeakMap<GraphQLSchema, PermissionResolver>();
  /**
   * Fields already wrapped, so a rule is never applied twice to one field.
   * Keyed on the field definition itself — unique per schema, and looked up
   * without building a `Type.field` string on every resolver call.
   */
  const guarded = new WeakSet<GraphQLField<unknown, unknown>>();

  /** Resolves the map against a schema once, then reuses that lookup. */
  function permissionsFor(schema: GraphQLSchema): PermissionResolver {
    let resolve = resolvers.get(schema);
    if (!resolve) {
      resolve = resolvePermissions<TResolvers>(schema, permissions, permissionOptions);
      resolvers.set(schema, resolve);
    }
    return resolve;
  }

  return {
    onPluginInit({ addPlugin }) {
      addPlugin(
        useOnResolve<TContext>(({ info, resolver, replaceResolver }) => {
          // `replaceResolver` is permanent for the field, not per call, so this
          // runs once per field and every later call reuses the wrapper. This
          // callback itself still runs per call, so the "already done" test is
          // kept to one `WeakSet` lookup.
          const field = info.parentType.getFields()[info.fieldName];
          if (!field || guarded.has(field)) return;
          guarded.add(field);

          const rule = permissionsFor(info.schema)(info.parentType.name, info.fieldName);
          if (!rule) return;

          replaceResolver((root, args, context, resolveInfo) =>
            rule(
              // Not `async`: a synchronous resolver stays synchronous, which
              // is what lets a `rule()` guard resolve a field without a
              // promise. The declared `Promise` return is satisfied in the
              // sense `Rule` documents.
              (p, a, c, i) =>
                resolver(
                  p,
                  a as Record<string, unknown>,
                  c as TContext,
                  // biome-ignore lint/style/noNonNullAssertion: middleware always forwards info
                  i!,
                ) as Promise<unknown>,
              root,
              args,
              context,
              resolveInfo,
            ),
          );
        }),
      );
    },

    // Validate eagerly: a broken map should fail at wiring time, not on the
    // first query that happens to touch the offending field.
    onSchemaChange({ schema }) {
      permissionsFor(schema);
    },
  };
}
