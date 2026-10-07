/**
 * The error a mismatch with the schema is reported as, and the wording it
 * shares between the validators.
 *
 * @remarks
 * Kept apart from the walks that throw it, so the permissions-map check and the
 * stored-rule check can both report through it without importing each other.
 */

import {
  type GraphQLNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isScalarType,
  isUnionType,
} from 'graphql';

/**
 * Thrown by {@link applyPermissions} / {@link validatePermissions} when a
 * permissions map does not line up with the schema, and by
 * {@link validateGraphQLRules} when stored ability rules do not. Reports
 * *every* problem at once, in {@link problems}, so a mismatch is fixed in one
 * pass rather than one error per run.
 */
export class PermissionsError extends Error {
  /** Every problem found, one message per offending type, field or rule. */
  readonly problems: readonly string[];

  /**
   * Builds the message from the heading and one line per problem.
   *
   * @param problems - Every problem found.
   * @param [heading] - What failed to line up, as the message's first line.
   */
  constructor(problems: readonly string[], heading = 'the permissions map does not match the schema') {
    super(`graphql-casl: ${heading}.\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'PermissionsError';
    this.problems = problems;
  }
}

/**
 * Names a type's kind for an error message. Shared with `validateGraphQLRules`.
 *
 * @param type - The type to name.
 * @returns A phrase such as `an enum`.
 */
export function describeKind(type: GraphQLNamedType): string {
  if (isInterfaceType(type)) {
    return 'an interface type';
  }
  if (isUnionType(type)) {
    return 'a union type';
  }
  if (isScalarType(type)) {
    return 'a scalar type';
  }
  if (isEnumType(type)) {
    return 'an enum type';
  }
  if (isInputObjectType(type)) {
    return 'an input object type';
  }
  return 'not an object type';
}
