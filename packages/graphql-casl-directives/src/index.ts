/**
 * Declare `@vantreeseba/graphql-casl` permissions in SDL.
 *
 * This package is a translator, not an enforcer: {@link permissionsFromDirectives}
 * reads `@can` and `@rule` directives off a `GraphQLSchema` and produces the
 * `PermissionsMap` that the runtime's `applyPermissions` / `useGraphQLCasl`
 * enforce. Wildcards, `fallbackRule`, error control and filtering therefore keep
 * their one implementation; the directives only decide *which* rule guards
 * *which* field.
 *
 * - `@can(action:, subject:)` maps to `can(action, subject)` on the `createCan`
 *   builder you pass in. `subject` defaults to the type the directive is written
 *   on, or, on a root field, to the field's return type.
 * - `@rule(names:)` maps to rules from a registry you pass in. Nested lists
 *   encode AND/OR: inner lists combine with `and`, the outer list with `or`.
 *
 * Several directives on one field — including one on the type and one on the
 * field, or one on an interface and one on the implementing type — compose with
 * `and`.
 *
 * @packageDocumentation
 */

import {
  type Action,
  Actions,
  type AnyResolvers,
  and,
  type CheckableRule,
  isCheckableRule,
  or,
  PermissionsError,
  type PermissionsMap,
} from '@vantreeseba/graphql-casl';
import {
  type ConstDirectiveNode,
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
  isEnumType,
  isIntrospectionType,
  isLeafType,
  isObjectType,
  valueFromASTUntyped,
} from 'graphql';

/**
 * The SDL for the two directives. Add it to your `typeDefs` alongside your own
 * schema — the directives have to be defined before they can be used.
 *
 * The names deliberately avoid the federation auth vocabulary
 * (`@authenticated`, `@requiresScopes`, `@policy`), so a subgraph can carry
 * both without a collision.
 *
 * @example
 * ```ts
 * const schema = makeExecutableSchema({
 *   typeDefs: [directiveTypeDefs, typeDefs],
 *   resolvers,
 * });
 * ```
 */
export const directiveTypeDefs = /* GraphQL */ `
  """
  Guards the field, or every field of the type, with a CASL ability check:
  \`can(action, subject)\` on the \`createCan\` builder given to
  \`permissionsFromDirectives\`. \`subject\` defaults to the type the directive is
  written on, or on a root field to the name of the field's return type.
  """
  directive @can(action: String!, subject: String) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE

  """
  Guards the field, or every field of the type, with named rules from the
  registry given to \`permissionsFromDirectives\`. Inner lists combine with AND,
  the outer list with OR: \`[["isAuthenticated", "isOwner"], ["isAdmin"]]\` reads
  (isAuthenticated AND isOwner) OR isAdmin.
  """
  directive @rule(names: [[String!]!]!) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE
`;

/**
 * The rules `@rule(names:)` may name, keyed by the name used in the SDL.
 *
 * Every entry must be a `CheckableRule` — one built by `rule()`, `createCan()`,
 * the combinators, or `accept` / `deny` — because `@rule` composes its operands
 * with `and` / `or`, which need to ask a rule for its verdict without running
 * the resolver. A `createCan(...).onResult`, `scopeArgs(...)` or `wrap(...)`
 * rule cannot be named from SDL; put those in a hand-written map entry instead.
 */
export type DirectiveRules = Record<string, CheckableRule>;

/**
 * A `createCan` builder, in the shape this package calls it: `can(action,
 * subject)` with a bare subject name and no extractor.
 *
 * The subject parameter is typed `never` so that any `RequireCan` /
 * `RequireCanBare` — whose subject type is the key union of *its* subject map —
 * is accepted without a cast. Nothing is lost: the subject names come from the
 * SDL, and `applyPermissions` checks them against the schema when the map is
 * applied.
 */
export type CanBuilder = (action: Action, subject: never) => CheckableRule;

/**
 * Options for {@link permissionsFromDirectives}. Both are optional, but a
 * schema that uses `@can` needs `can` and one that uses `@rule` needs `rules`;
 * a directive with nothing to resolve against is reported as a problem.
 */
export interface DirectivePermissionsOptions {
  /** The `createCan` builder that `@can(action:, subject:)` calls as `can(action, subject)`. */
  can?: CanBuilder;
  /** The registry `@rule(names:)` resolves its names against. */
  rules?: DirectiveRules;
}

/**
 * The map {@link permissionsFromDirectives} returns: a `PermissionsMap` in its
 * loose, codegen-free form. Type and field names come straight from the schema,
 * and `applyPermissions` re-checks them against it anyway.
 */
export type DirectivePermissions = PermissionsMap<AnyResolvers>;

const CAN = 'can';
const RULE = 'rule';
const WILDCARD = '*';

/** Where a directive was found, for rule resolution and for error messages. */
interface Site {
  /** The type the directive is written on — an object or an interface. */
  readonly typeName: string;
  /** The field it is written on; absent for a type-level directive. */
  readonly field?: GraphQLField<unknown, unknown>;
  /** Whether `typeName` is the schema's Query, Mutation or Subscription type. */
  readonly root: boolean;
}

function labelOf(site: Site): string {
  return site.field ? `${site.typeName}.${site.field.name}` : site.typeName;
}

/** A directive's arguments as plain values. SDL cannot carry variables, so this is total. */
function argumentsOf(node: ConstDirectiveNode): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of node.arguments ?? []) {
    args[arg.name.value] = valueFromASTUntyped(arg.value);
  }
  return args;
}

/** Every directive on a type: its definition plus each `extend type` node. */
function typeDirectives(type: GraphQLObjectType | GraphQLInterfaceType): ConstDirectiveNode[] {
  const nodes = [type.astNode, ...(type.extensionASTNodes ?? [])];
  return nodes.flatMap((node) => node?.directives ?? []);
}

/** Every directive on a field. A field added by `extend type` has its own node. */
function fieldDirectives(field: GraphQLField<unknown, unknown>): readonly ConstDirectiveNode[] {
  return field.astNode?.directives ?? [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const ACTIONS: ReadonlySet<string> = new Set(Object.values(Actions));
const ACTION_NAMES = [...ACTIONS].map((action) => `"${action}"`).join(', ');

/** Whether a value is one of the runtime's `Action`s — the only ones `createCan` accepts. */
function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.has(value);
}

/** The `names` shape `@rule` accepts: a non-empty list of non-empty lists of names. */
function isNamesShape(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (group) => Array.isArray(group) && group.length > 0 && group.every(isNonEmptyString),
    )
  );
}

/** One rule for a field: the rule itself, or every rule ANDed. */
function combine(rules: readonly CheckableRule[]): CheckableRule {
  return rules.length === 1 ? (rules[0] as CheckableRule) : and(...rules);
}

/**
 * One translation. Problems are collected, not thrown, so a schema with three
 * mistakes reports all three.
 */
class Translator {
  private readonly problems: string[] = [];
  private readonly can: ((action: Action, subject: string) => CheckableRule) | undefined;
  private readonly rules: ReadonlyMap<string, CheckableRule> | undefined;
  private readonly roots: ReadonlySet<string>;
  /** Interface-level rules, built once per interface rather than once per implementor. */
  private readonly interfaceRules = new Map<string, CheckableRule[]>();

  constructor(
    private readonly schema: GraphQLSchema,
    options: DirectivePermissionsOptions,
  ) {
    this.can = options.can as typeof this.can;
    this.rules = options.rules && new Map(Object.entries(options.rules));
    this.roots = new Set(
      [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
        .filter((type) => type != null)
        .map((type) => type.name),
    );
  }

  translate(): DirectivePermissions {
    const map: Record<string, Record<string, CheckableRule>> = {};

    for (const type of Object.values(this.schema.getTypeMap())) {
      // Interfaces are not walked on their own: the runtime resolves fields
      // against the concrete object type, so their directives are projected
      // onto each implementing type below instead.
      if (!isObjectType(type) || isIntrospectionType(type)) continue;

      const root = this.roots.has(type.name);
      const interfaces = type.getInterfaces();
      const typeRules = [
        ...interfaces.flatMap((iface) => this.interfaceTypeRules(iface)),
        ...this.rulesAt(typeDirectives(type), { typeName: type.name, root }),
      ];

      const entry: Record<string, CheckableRule> = {};
      if (typeRules.length > 0) entry[WILDCARD] = combine(typeRules);

      for (const field of Object.values(type.getFields())) {
        const fieldRules = [
          ...interfaces.flatMap((iface) => this.interfaceFieldRules(iface, field.name)),
          ...this.rulesAt(fieldDirectives(field), { typeName: type.name, field, root }),
        ];
        // A field with its own directives still honours the type's: the two
        // compose with AND here, rather than the field entry shadowing the
        // wildcard entry under the map's precedence rules.
        if (fieldRules.length > 0) entry[field.name] = combine([...typeRules, ...fieldRules]);
      }

      if (Object.keys(entry).length > 0) map[type.name] = entry;
    }

    if (this.problems.length > 0) {
      throw new PermissionsError(
        [...new Set(this.problems)],
        'the schema directives could not be translated',
      );
    }
    return map;
  }

  private interfaceTypeRules(iface: GraphQLInterfaceType): CheckableRule[] {
    return this.memo(iface.name, () =>
      this.rulesAt(typeDirectives(iface), { typeName: iface.name, root: false }),
    );
  }

  private interfaceFieldRules(iface: GraphQLInterfaceType, fieldName: string): CheckableRule[] {
    const field = iface.getFields()[fieldName];
    if (!field) return [];
    return this.memo(`${iface.name}.${fieldName}`, () =>
      this.rulesAt(fieldDirectives(field), { typeName: iface.name, field, root: false }),
    );
  }

  private memo(key: string, build: () => CheckableRule[]): CheckableRule[] {
    let rules = this.interfaceRules.get(key);
    if (!rules) {
      rules = build();
      this.interfaceRules.set(key, rules);
    }
    return rules;
  }

  /** The rules the auth directives at one site translate to, in SDL order. */
  private rulesAt(directives: readonly ConstDirectiveNode[], site: Site): CheckableRule[] {
    const rules: CheckableRule[] = [];
    for (const node of directives) {
      const name = node.name.value;
      const built =
        name === CAN
          ? this.canRule(argumentsOf(node), site)
          : name === RULE
            ? this.ruleRule(argumentsOf(node), site)
            : undefined;
      if (built) rules.push(built);
    }
    return rules;
  }

  private canRule(args: Record<string, unknown>, site: Site): CheckableRule | undefined {
    const label = labelOf(site);
    if (!this.can) {
      this.problems.push(
        `\`@can\` on \`${label}\` has no \`createCan\` builder to call: pass \`can\` to \`permissionsFromDirectives\`.`,
      );
      return undefined;
    }
    if (!isAction(args.action)) {
      this.problems.push(
        `\`@can\` on \`${label}\` has an unknown \`action\` ${JSON.stringify(args.action)}; expected one of ${ACTION_NAMES}.`,
      );
      return undefined;
    }
    const subject = args.subject === undefined ? this.inferSubject(site) : args.subject;
    if (!isNonEmptyString(subject)) {
      if (args.subject !== undefined) {
        this.problems.push(
          `\`@can\` on \`${label}\` has a \`subject\` that is not a non-empty string.`,
        );
      }
      return undefined;
    }
    return this.can(args.action, subject);
  }

  /**
   * The subject a `@can` without one means. On an object or interface field
   * that is the type itself — `Note.body` is a field *of a Note*. A root field
   * has no such parent, so its return type stands in: `Query.notes: [Note!]!`
   * reads Notes. A leaf return type is not a subject, and the type-level form on
   * a root type has no single answer, so both must be named explicitly.
   */
  private inferSubject(site: Site): string | undefined {
    if (!site.root) return site.typeName;
    const label = labelOf(site);
    if (!site.field) {
      this.problems.push(
        `\`@can\` on the root type \`${label}\` needs an explicit \`subject\`: its fields return different types, so there is nothing to infer.`,
      );
      return undefined;
    }
    const named = getNamedType(site.field.type);
    if (isLeafType(named)) {
      const kind = isEnumType(named) ? 'enum' : 'scalar';
      this.problems.push(
        `\`@can\` on root field \`${label}\` has no \`subject\` and none can be inferred: the field returns the ${kind} \`${named.name}\`. Name it, e.g. \`@can(action: "read", subject: "...")\`.`,
      );
      return undefined;
    }
    return named.name;
  }

  private ruleRule(args: Record<string, unknown>, site: Site): CheckableRule | undefined {
    const label = labelOf(site);
    if (!this.rules) {
      this.problems.push(
        `\`@rule\` on \`${label}\` has no registry to resolve against: pass \`rules\` to \`permissionsFromDirectives\`.`,
      );
      return undefined;
    }
    const { names } = args;
    if (!isNamesShape(names)) {
      this.problems.push(
        `\`@rule\` on \`${label}\` has a malformed \`names\`: expected a non-empty list of non-empty lists of rule names, e.g. \`[["isAuthenticated", "isOwner"], ["isAdmin"]]\`.`,
      );
      return undefined;
    }

    const registry = this.rules;
    let broken = false;
    const groups = names.map((group) =>
      group.map((name) => {
        const found = registry.get(name);
        if (found === undefined) {
          broken = true;
          this.problems.push(
            `\`@rule\` on \`${label}\` names \`${name}\`, which is not in the rules registry.`,
          );
        } else if (!isCheckableRule(found)) {
          broken = true;
          this.problems.push(
            `\`@rule\` on \`${label}\` names \`${name}\`, which is not a checkable rule. Build it with \`rule()\` or \`createCan()\`; \`onResult\`, \`scopeArgs\` and \`wrap\` rules cannot be named from SDL.`,
          );
        }
        return found as CheckableRule;
      }),
    );
    if (broken) return undefined;

    // Inner lists are AND groups, the outer list ORs them. A single name at
    // either level is used as-is rather than wrapped in a one-operand combinator.
    const alternatives = groups.map(combine);
    return alternatives.length === 1 ? (alternatives[0] as CheckableRule) : or(...alternatives);
  }
}

/**
 * Translates the `@can` and `@rule` directives in a schema into a
 * `PermissionsMap`.
 *
 * Nothing is enforced here. Hand the result to `applyPermissions` or
 * `useGraphQLCasl` from `@vantreeseba/graphql-casl`, exactly as you would a
 * hand-written map — or spread the two together.
 *
 * What lands where:
 *
 * - A directive on a **field** guards that field: `{ Note: { body: rule } }`.
 * - A directive on an **object type** guards every field of the type:
 *   `{ Note: { '*': rule } }`. A field of that type with directives of its own
 *   gets `and(typeRule, fieldRule)`, so the type's requirement is never
 *   shadowed by the field's.
 * - A directive on an **interface**, or on one of its fields, is projected onto
 *   every implementing object type — the runtime resolves fields against the
 *   concrete type, so a rule keyed by the interface would never run. It
 *   composes with the implementing type's own directives with `and`.
 * - Several directives at one site compose with `and`, in SDL order.
 *
 * Introspection types are skipped. Extension nodes (`extend type`) are read.
 *
 * @param schema - The schema to read directives from. Types and fields need
 * their `astNode`s — a schema built from SDL (`buildSchema`,
 * `makeExecutableSchema`) has them; one assembled from `GraphQLObjectType`
 * constructors does not, and translates to an empty map.
 * @param options - The `can` builder and the `rules` registry.
 * @returns The map. Empty when the schema uses neither directive.
 * @throws {PermissionsError} Listing every problem at once: a `@can` whose
 * subject cannot be inferred, a `@rule` naming a rule the registry lacks or one
 * that is not checkable, a malformed `names`, or a directive with no `can` /
 * `rules` to resolve against.
 * @example
 * ```ts
 * const schema = makeExecutableSchema({ typeDefs: [directiveTypeDefs, typeDefs], resolvers });
 * const permissions = permissionsFromDirectives(schema, {
 *   can: canUser,
 *   rules: { isAuthenticated, isOwner, isAdmin },
 * });
 * const guarded = applyPermissions(schema, permissions);
 * ```
 */
export function permissionsFromDirectives(
  schema: GraphQLSchema,
  options: DirectivePermissionsOptions,
): DirectivePermissions {
  return new Translator(schema, options).translate();
}
