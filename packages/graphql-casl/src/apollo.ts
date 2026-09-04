/**
 * The Apollo Server integration — the optional entry point,
 * `@vantreeseba/graphql-casl/apollo`.
 *
 * On Apollo Server the schema is wrapped up front with `applyPermissions`, so
 * enforcement needs nothing from here. What `applyPermissions` cannot do is see
 * the finished response — and under `onDeny: 'filter'` some denials can only be
 * reported there: a non-null list resolves to `[]`, which cannot also be an
 * error, and under `report: 'extensions'` every denial waits for the response.
 * Those are held per request until {@link reportDenials} merges them in.
 * {@link reportDenialsPlugin} is that call, made from Apollo's own
 * `willSendResponse` hook, so there is nothing left to wire by hand.
 *
 * The plugin is typed structurally against the slice of Apollo Server's plugin
 * contract it uses, so `@apollo/server` is not a dependency of this package,
 * optional or otherwise. Apollo Server 4 and 5 share that contract.
 *
 * @example
 * ```ts
 * import { ApolloServer } from '@apollo/server';
 * import { applyPermissions } from '@vantreeseba/graphql-casl';
 * import { reportDenialsPlugin } from '@vantreeseba/graphql-casl/apollo';
 *
 * const server = new ApolloServer<Context>({
 *   schema: applyPermissions<Resolvers>(schema, permissions, { onDeny: 'filter' }),
 *   plugins: [reportDenialsPlugin()],
 * });
 * ```
 *
 * @packageDocumentation
 */

import type {
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLError,
  GraphQLFormattedError,
} from 'graphql';
import { reportDenials } from './applyPermissions.js';

/**
 * The response body Apollo Server hands `willSendResponse`: the slice of its
 * `GraphQLResponseBody` this plugin reads. A `'single'` body is the whole
 * result; an `'incremental'` one (`@defer` / `@stream`) is a stream of
 * payloads, which the plugin leaves alone.
 */
export type ApolloResponseBody =
  | { kind: 'single'; singleResult: FormattedExecutionResult }
  | { kind: 'incremental' };

/**
 * The slice of Apollo Server's `ApolloServerPlugin` that
 * {@link reportDenialsPlugin} implements. Structurally compatible with the real
 * interface — every hook Apollo defines is optional — so the returned object
 * goes straight into `plugins` without a type from `@apollo/server`.
 */
export interface ReportDenialsApolloPlugin {
  requestDidStart(requestContext: { contextValue: unknown }): Promise<{
    willSendResponse(requestContext: {
      contextValue: unknown;
      response: { body: ApolloResponseBody };
    }): Promise<void>;
  }>;
}

/** Whether an error is still a `GraphQLError` instance rather than its JSON. */
function isUnformatted(error: GraphQLFormattedError | GraphQLError): error is GraphQLError {
  return typeof (error as Partial<GraphQLError>).toJSON === 'function';
}

/**
 * An Apollo Server plugin that reports the denials `onDeny: 'filter'` held for
 * each request — the ones the response could not carry through the denied
 * field itself — into the response before it is sent. It is
 * {@link reportDenials}, called from `willSendResponse` with the request's
 * `contextValue`; see {@link ApplyPermissionsOptions.onDeny} for which denials
 * those are.
 *
 * Under `report: 'errors'` they are appended to the response's `errors`,
 * formatted the way Apollo formats its own; under `report: 'extensions'` they
 * land in `extensions.authorizationErrors`. A request with nothing recorded
 * leaves the response untouched, as does a request under `'reject'` or
 * `'mask'`, so the plugin is safe to install regardless of mode.
 *
 * Only a `kind: 'single'` response is reported into. Under incremental
 * delivery (`@defer` / `@stream`) the body is a stream the plugin does not
 * follow, so a denial held for a deferred payload is silently masked — the same
 * degradation as no hook at all.
 *
 * @returns The plugin, for Apollo Server's `plugins` array.
 * @example
 * ```ts
 * const server = new ApolloServer<Context>({
 *   schema: applyPermissions<Resolvers>(schema, permissions, { onDeny: 'filter' }),
 *   plugins: [reportDenialsPlugin()],
 * });
 * ```
 */
export function reportDenialsPlugin(): ReportDenialsApolloPlugin {
  return {
    async requestDidStart() {
      return {
        async willSendResponse({ contextValue, response }) {
          const { body } = response;
          if (body.kind !== 'single') return;
          const { singleResult } = body;
          // Apollo has already formatted its own errors by this point, so the
          // result is a `FormattedExecutionResult`; `reportDenials` appends
          // `GraphQLError`s, which are formatted the same way below before the
          // response goes out.
          const reported = reportDenials(contextValue, singleResult as ExecutionResult);
          if (reported === singleResult) return;
          if (reported.errors) {
            singleResult.errors = reported.errors.map((error) =>
              isUnformatted(error) ? error.toJSON() : error,
            );
          }
          if (reported.extensions) singleResult.extensions = reported.extensions;
        },
      };
    },
  };
}
