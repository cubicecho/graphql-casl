/**
 * Argument validation as a rule: {@link validateArgs} runs a
 * [Standard Schema](https://standardschema.dev) over a field's arguments before
 * the resolver does, and hands the resolver the *parsed* arguments — defaults
 * filled in, values coerced, transforms applied.
 *
 * The schema is whatever validator you already use: zod (3.24+), valibot,
 * arktype, yup (1.7+) and others all expose the `~standard` property the spec
 * defines, so this module needs none of them as a dependency. The interface it
 * checks against is vendored below, as the spec intends.
 */

import type { GraphQLResolveInfo } from 'graphql';
import { GraphQLError } from 'graphql';
import { denialFrom, isThenable, type Rule } from './rules.js';

// ---------------------------------------------------------------------------
// The Standard Schema interface, copied verbatim from
// https://github.com/standard-schema/standard-schema (MIT). The spec is
// designed to be vendored rather than depended on, so that a library can
// accept any conforming validator without adding a package.
// ---------------------------------------------------------------------------

/** The Standard Schema interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  export interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Validates unknown input values. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The result interface of the validate function. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  export interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** The non-existent issues. */
    readonly issues?: undefined;
  }

  /** The result interface if validation fails. */
  export interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** The issue interface of the failure output. */
  export interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  export interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard Schema types interface. */
  export interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Schema. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Schema. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

// ---------------------------------------------------------------------------
// End of the vendored spec.
// ---------------------------------------------------------------------------

/**
 * The `extensions.code` a {@link validateArgs} failure carries — Apollo's
 * conventional code for a request whose input is malformed, so clients that
 * already branch on it need no new vocabulary.
 */
export const BAD_USER_INPUT = 'BAD_USER_INPUT';

/**
 * One validation problem, as reported under `extensions.issues` of the error
 * {@link validateArgs} throws. The spec's issue with its path flattened to the
 * keys alone, so it serializes cleanly.
 */
export interface ArgumentIssue {
  /** The validator's message for this problem. */
  readonly message: string;
  /**
   * Where in the arguments it was found, outermost key first — `['input',
   * 'tags', 0]`. Empty for a problem with the arguments as a whole.
   */
  readonly path: ReadonlyArray<string | number>;
}

/**
 * The arguments type a resolver behind `validateArgs(schema)` receives: the
 * schema's *output* type. Where the resolver's own signature is generated (a
 * `typescript-resolvers` `Resolvers` type) it is already typed from the SDL, and
 * this is the type to assert the parsed arguments to inside it.
 *
 * @example
 * ```ts
 * const CreateNoteArgs = z.object({ input: z.object({ title: z.string().trim().min(1) }) });
 * type Args = ValidatedArgs<typeof CreateNoteArgs>; // { input: { title: string } }
 * ```
 */
export type ValidatedArgs<TSchema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<TSchema>;

/** Options for {@link validateArgs}. */
export interface ValidateArgsOptions {
  /**
   * Whether the resolver receives the schema's parsed output in place of the
   * raw arguments. Defaults to `true`, which is the point of a Standard Schema
   * — defaults, coercion and transforms reach the resolver.
   *
   * `false` validates only: the arguments the resolver sees are exactly the
   * ones GraphQL coerced, and the schema's output is discarded. Use it when a
   * schema's transforms are for checking rather than for shaping, or when a
   * generated resolver must see its arguments untouched.
   */
  replace?: boolean;
}

/**
 * A rule that validates a field's arguments against a Standard Schema, and on
 * success calls the resolver with the parsed output as its `args`.
 *
 * GraphQL's own input coercion checks *shape* — the right scalars in the right
 * places. It has nothing to say about a title that is blank, an end date before
 * its start, or a page size of ten million. Those checks usually end up
 * hand-written at the top of each resolver; `validateArgs` lifts them into the
 * permissions map, next to the authorization the same field needs, and gives
 * the resolver the *parsed* arguments — trimmed, defaulted, coerced — rather
 * than the raw ones.
 *
 * A failure is **not a permission denial**. It rejects with a `GraphQLError`
 * whose message lists the issues, with `extensions.code` set to
 * {@link BAD_USER_INPUT} and `extensions.issues` holding each one as an
 * {@link ArgumentIssue}. The error control on `applyPermissions` leaves it
 * verbatim: `fallbackError` never rewords it — it named its own error — and
 * under `onDeny: 'filter'` it keeps its own code rather than taking
 * `UNAUTHORIZED_FIELD_OR_TYPE`. Under `onDeny: 'mask'` it is masked like any
 * other refusal, so bad input then reads as a missing record; that is the
 * trade-off `'mask'` already makes. An error thrown by the validator *itself*
 * is a rule failure, not a validation result, and surfaces as one.
 *
 * Because it rewrites arguments and calls the resolver, it is a plain
 * {@link Rule}, not a `CheckableRule`: it cannot be an operand of `and` / `or` /
 * `not` / `chain` / `race`. Compose it with `wrap` — the authorization rule
 * first, so a caller who may not run the field at all learns that rather than
 * what is wrong with their input:
 *
 * ```ts
 * Mutation: {
 *   createNote: wrap(canUser(Actions.create, Subject.Note), validateArgs(CreateNoteArgs)),
 * }
 * ```
 *
 * Rewritten arguments bypass GraphQL's coercion, exactly as `scopeArgs`'s do.
 * The schema's output is what the resolver gets, so a transform that changes a
 * value's *type* — a string to a `Date`, say — hands the resolver something the
 * SDL never promised. That is often the point; just make sure the resolver
 * expects it.
 *
 * @typeParam TSchema - The Standard Schema. Its output type is what the
 * resolver receives; {@link ValidatedArgs} names it.
 * @param schema - Any object with a `~standard` property: a zod, valibot,
 * arktype or yup schema, or a hand-written one.
 * @param options - See {@link ValidateArgsOptions}.
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { validateArgs, wrap } from '@vantreeseba/graphql-casl';
 *
 * const CreateNoteArgs = z.object({
 *   input: z.object({
 *     title: z.string().trim().min(1, 'A note needs a title'),
 *     tags: z.array(z.string()).max(10).default([]),
 *   }),
 * });
 *
 * const permissions = {
 *   Mutation: {
 *     createNote: wrap(canUser(Actions.create, Subject.Note), validateArgs(CreateNoteArgs)),
 *   },
 * } satisfies PermissionsMap<Resolvers>;
 * ```
 */
export function validateArgs<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  options?: ValidateArgsOptions,
): Rule {
  const standard = (schema as Partial<StandardSchemaV1> | null | undefined)?.['~standard'];
  if (typeof standard?.validate !== 'function') {
    throw new Error(
      'graphql-casl: `validateArgs` expects a Standard Schema — an object with a `~standard` ' +
        'property, which zod (3.24+), valibot, arktype and yup (1.7+) schemas all have. ' +
        'See https://standardschema.dev.',
    );
  }
  const validate = standard.validate;
  const replace = options?.replace ?? true;

  /** Delivers the validator's answer: reject on issues, else run the resolver. */
  function settle(
    result: StandardSchemaV1.Result<unknown>,
    resolve: Parameters<Rule>[0],
    parent: unknown,
    args: unknown,
    context: unknown,
    info: GraphQLResolveInfo,
  ): unknown {
    if (result.issues) return Promise.reject(invalidArguments(result.issues));
    return resolve(parent, replace ? result.value : args, context, info);
  }

  return (resolve, parent, args, context, info) => {
    let result: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
    try {
      result = validate(args);
    } catch (error) {
      // The validator broke; that is a rule failure, which error control tells
      // apart from a decision.
      return Promise.reject(error);
    }
    if (isThenable(result)) {
      return Promise.resolve(result).then((settled) =>
        settle(settled, resolve, parent, args, context, info),
      );
    }
    // Synchronous end to end when the validator and the resolver both are — see
    // `Rule` on why that is within contract.
    return settle(result, resolve, parent, args, context, info) as Promise<unknown>;
  };
}

/**
 * Builds the error a failed validation rejects with, marked as an explicit
 * denial so `applyPermissions`' error control passes it through untouched.
 */
function invalidArguments(issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
  const flattened: ArgumentIssue[] = issues.map((issue) => ({
    message: issue.message,
    path: pathOf(issue),
  }));
  const message = flattened
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
  const error = new GraphQLError(message, {
    extensions: { code: BAD_USER_INPUT, issues: flattened },
  });
  return denialFrom(error) as Error;
}

/**
 * Flattens an issue's path to its keys. The spec allows each segment to be a
 * bare key or a `{ key }` object; a symbol key has no JSON form and is spelled
 * out instead, so the extension stays serializable.
 */
function pathOf(issue: StandardSchemaV1.Issue): ReadonlyArray<string | number> {
  if (!issue.path) return [];
  return issue.path.map((segment) => {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment;
    return typeof key === 'symbol' ? String(key) : key;
  });
}
