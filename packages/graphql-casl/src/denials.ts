/**
 * What a denied field resolves to, and how the denial is reported.
 *
 * @remarks
 * The modes of `onDeny`, the value a field is masked with, and the per-request
 * record of the denials a response could not carry through the field itself.
 */

import {
  type ExecutionResult,
  GraphQLError,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  isListType,
  isNonNullType,
  locatedError,
  responsePathAsArray,
} from 'graphql';
import { isWeakKey } from './internal.js';

/**
 * The `extensions.code` a denial carries under `onDeny: 'filter'`.
 *
 * @remarks
 * It is Apollo Router's code for a field its authorization directives removed
 * from a query, so clients and tooling that already handle the router's partial
 * responses handle these without learning a second vocabulary.
 */
export const UNAUTHORIZED_FIELD_OR_TYPE = 'UNAUTHORIZED_FIELD_OR_TYPE';

/**
 * The response extension {@link reportDenials} fills under
 * `report: 'extensions'` — again Apollo Router's key, holding the same error
 * objects it would otherwise put in `errors`.
 */
export const AUTHORIZATION_ERRORS_EXTENSION = 'authorizationErrors';

/**
 * What a denied field does — see {@link ApplyPermissionsOptions.onDeny}. The
 * object names each mode, so `onDeny: DenialMode.Filter` reads the same as
 * `onDeny: 'filter'`.
 */
export const DenialMode = { Reject: 'reject', Filter: 'filter', Mask: 'mask' } as const;
export type DenialMode = (typeof DenialMode)[keyof typeof DenialMode];

/**
 * Where a filtered denial is reported — see {@link ApplyPermissionsOptions.report}.
 * The object names each place: `report: DenialReport.Extensions`.
 */
export const DenialReport = { Errors: 'errors', Extensions: 'extensions' } as const;
export type DenialReport = (typeof DenialReport)[keyof typeof DenialReport];

export type Mask = () => unknown;

// Shared instances, so a wrapper built for one mask can serve every field with
// the same one — see `withErrorControl`.
const MASK_NULL: Mask = () => null;
const MASK_LIST: Mask = () => [];

/**
 * The value a denied field is masked with, or `undefined` if it cannot be masked.
 *
 * @param fieldType - The field's declared type.
 * @returns A function producing `null` or `[]`.
 *
 * @remarks
 * A factory, not a value: `[]` handed to two requests would be the same array.
 *
 * Masking is bounded by the schema. A nullable field becomes `null`, and a
 * non-null *list* becomes `[]` — an empty list satisfies non-null, which is what
 * makes masking useful for the `[Todo!]!` shape where a thrown denial otherwise
 * nulls the whole branch. A non-null field of any other kind has no value that
 * satisfies it, so it keeps throwing.
 */
export function maskFor(fieldType: GraphQLOutputType): Mask | undefined {
  if (isNonNullType(fieldType) === false) {
    return MASK_NULL;
  }
  if (isListType(fieldType.ofType)) {
    return MASK_LIST;
  }
  return undefined;
}

/** Filtered denials the response itself could not carry, per request context. */
interface DenialRecord {
  report: DenialReport;
  errors: GraphQLError[];
}

const recorded = new WeakMap<object, DenialRecord>();

/**
 * The error a filtered denial is reported as: the denial's own words under the
 * standard code. A denial that already names a code — a check that returned a
 * `GraphQLError` with one, or a `fallbackError` that built one — is the rule
 * author's deliberate choice and is kept as is.
 *
 * @param denial - The denial as the rule made it.
 * @returns The error to report.
 */
function standardized(denial: Error): Error {
  const extensions = (denial as { extensions?: unknown }).extensions;
  const own =
    typeof extensions === 'object' && extensions !== null ? (extensions as Record<string, unknown>) : undefined;
  if (typeof own?.code === 'string') {
    return denial;
  }
  return new GraphQLError(denial.message, {
    originalError: denial,
    extensions: { ...own, code: UNAUTHORIZED_FIELD_OR_TYPE },
  });
}

/**
 * Delivers a denial under `onDeny: 'filter'`: the field resolves to its mask and
 * the denial is reported.
 *
 * @param denial - The denial to report.
 * @param mask - Produces the field's masked value.
 * @param report - Where the denial is reported.
 * @param context - The request context, which keys the record.
 * @param info - The field's resolve info, for the path.
 * @returns The masked value, or a rejection when the field cannot be masked.
 *
 * @remarks
 * Where the field can carry the report itself it does — a nullable field that
 * rejects *is* `null` plus an error at that path, and needs no response hook.
 * Everything else goes through the per-request record {@link reportDenials}
 * drains: a non-null list, whose `[]` cannot also be an error, and every denial
 * under `report: 'extensions'`. A field with no mask at all — non-null, not a
 * list — cannot be filtered, and rejects with the standard code so the denial
 * propagates exactly as Apollo Router's does. So does a denial with nowhere to
 * be recorded, when the context is not an object.
 */
export function deliver(
  denial: Error,
  mask: Mask | undefined,
  report: DenialReport,
  context: unknown,
  info: GraphQLResolveInfo,
): unknown {
  const error = standardized(denial);
  if (!mask || (mask === MASK_NULL && report === DenialReport.Errors) || isWeakKey(context) === false) {
    return Promise.reject(error);
  }
  let record = recorded.get(context);
  if (!record) {
    record = { report, errors: [] };
    recorded.set(context, record);
  }
  record.errors.push(locatedError(error, info.fieldNodes, responsePathAsArray(info.path)));
  return mask();
}

/**
 * Merges the denials `onDeny: 'filter'` recorded for a request into its
 * execution result — the ones the response could not carry through the denied
 * field itself (see {@link ApplyPermissionsOptions.onDeny}).
 *
 * @param context - The request's context value: the one the resolvers saw.
 * @param result - The execution result to report into.
 * @returns The result with the denials merged in, or `result` itself if there were none.
 *
 * @remarks
 * The `/envelop` entry point calls this for you. Under `applyPermissions` no
 * hook sees the finished response, so call it from your server's own — Apollo
 * Server's `willSendResponse`, or straight after `execute`:
 *
 * ```ts
 * const result = reportDenials(contextValue, await execute({ schema, document, contextValue }));
 * ```
 *
 * Under `report: 'errors'` the denials are appended to `result.errors`; under
 * `report: 'extensions'` they are formatted into
 * `result.extensions.authorizationErrors`. The record is drained, so a context
 * is reported once, and a context with nothing recorded returns the result
 * untouched. Nothing is recorded under `'reject'` or `'mask'`.
 */
export function reportDenials<TResult extends ExecutionResult>(context: unknown, result: TResult): TResult {
  if (isWeakKey(context) === false) {
    return result;
  }
  const record = recorded.get(context);
  if (!record) {
    return result;
  }
  recorded.delete(context);
  if (record.report === DenialReport.Errors) {
    return { ...result, errors: [...(result.errors ?? []), ...record.errors] };
  }
  const existing = result.extensions?.[AUTHORIZATION_ERRORS_EXTENSION];
  const previous = Array.isArray(existing) ? existing : [];
  return {
    ...result,
    extensions: {
      ...result.extensions,
      [AUTHORIZATION_ERRORS_EXTENSION]: [...previous, ...record.errors.map((error) => error.toJSON())],
    },
  };
}
