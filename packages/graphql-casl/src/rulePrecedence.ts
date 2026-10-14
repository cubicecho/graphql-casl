/**
 * Which rule of a permissions map guards a field.
 *
 * @remarks
 * A map entry can name a field, a type, an interface or union the type belongs
 * to, or a wildcard, and exactly one of them applies. This module reads the
 * map's entries and holds that order — see `PermissionsMap` for the table.
 */

import {
  type GraphQLAbstractType,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  isAbstractType,
  isUnionType,
} from 'graphql';
import { getOrCreate } from './internal.js';
import { type Rule, WILDCARD } from './rules.js';

/** The permissions map with its compile-time typing erased, for the walk. */
export type RawPermissions = Record<string, Rule | Record<string, Rule | undefined> | undefined>;

/**
 * Whether a map value is a rule rather than a per-field entry.
 *
 * @param value - The map value.
 * @returns `true` for a function.
 */
export function isRule(value: unknown): value is Rule {
  return typeof value === 'function';
}

/**
 * The object types an abstract type stands for: an interface's implementors
 * (through interfaces that implement it, too) or a union's members. These are
 * the types an entry keyed on the abstract type actually guards, since
 * execution resolves every field against the concrete object type.
 *
 * @param schema - The schema.
 * @param abstract - The interface or union.
 * @returns Its concrete object types.
 */
export function possibleTypesOf(schema: GraphQLSchema, abstract: GraphQLAbstractType): GraphQLObjectType[] {
  if (isUnionType(abstract)) {
    return [...abstract.getTypes()];
  }
  const objects = new Set<GraphQLObjectType>();
  const seen = new Set<GraphQLInterfaceType>();
  const visit = (iface: GraphQLInterfaceType): void => {
    if (seen.has(iface)) {
      return;
    }
    seen.add(iface);
    const implementations = schema.getImplementations(iface);
    for (const object of implementations.objects) {
      objects.add(object);
    }
    for (const sub of implementations.interfaces) {
      visit(sub);
    }
  };
  visit(abstract);
  return [...objects];
}

/**
 * Object type name -> the interface and union entries in the map that cover it,
 * in map order. Only types under at least one such entry are listed.
 */
export type Supertypes = ReadonlyMap<string, readonly string[]>;

/**
 * Finds, for each object type, the abstract entries of the map that cover it.
 *
 * @param schema - The schema.
 * @param permissions - The permissions map.
 * @returns Object type name to covering entry names, in map order.
 */
export function supertypesOf(schema: GraphQLSchema, permissions: RawPermissions): Supertypes {
  const supertypes = new Map<string, string[]>();
  for (const [typeName, entry] of Object.entries(permissions)) {
    if (entry == null) {
      continue;
    }
    const type = schema.getType(typeName);
    if (!type || isAbstractType(type) === false) {
      continue;
    }
    for (const object of possibleTypesOf(schema, type)) {
      getOrCreate(supertypes, object.name, () => []).push(typeName);
    }
  }
  return supertypes;
}

/**
 * Reads a rule out of a map entry, tolerating the type-level-`Rule` shorthand.
 *
 * @param entry - A type's map entry.
 * @param fieldName - The field name, or the wildcard.
 * @returns The rule, or `undefined` when the entry has none for that key.
 */
export function fieldRuleOf(
  entry: Rule | Record<string, Rule | undefined> | undefined,
  fieldName: string,
): Rule | undefined {
  if (entry === undefined) {
    return undefined;
  }
  // `{ Note: rule }` is shorthand for `{ Note: { '*': rule } }`.
  if (isRule(entry)) {
    return fieldName === WILDCARD ? entry : undefined;
  }
  const rule = entry[fieldName];
  return isRule(rule) ? rule : undefined;
}

/**
 * The rule the interfaces (and unions) an object type belongs to give one of its
 * field keys. Validation has already rejected the case where two of them
 * disagree, so the first one found is the only one.
 *
 * @param permissions - The permissions map.
 * @param abstracts - The abstract entries covering the type.
 * @param fieldName - The field name, or the wildcard.
 * @returns The inherited rule, or `undefined`.
 */
function inheritedRuleOf(
  permissions: RawPermissions,
  abstracts: readonly string[] | undefined,
  fieldName: string,
): Rule | undefined {
  if (!abstracts) {
    return undefined;
  }
  for (const name of abstracts) {
    const rule = fieldRuleOf(permissions[name], fieldName);
    if (rule) {
      return rule;
    }
  }
  return undefined;
}

/**
 * The single rule guarding one field, or `undefined` to leave it unguarded.
 *
 * @param permissions - The permissions map.
 * @param typeName - The object type.
 * @param fieldName - The field.
 * @param supertypes - Each object type's covering abstract entries.
 * @param fallbackRule - The rule for fields nothing else covers.
 * @returns The rule, by precedence.
 *
 * @remarks
 * Wildcards never compose — exactly one rule applies, and the most specific
 * entry wins. See {@link PermissionsMap} for the precedence table; the order of
 * the lookups below *is* that table.
 */
export function ruleForField(
  permissions: RawPermissions,
  typeName: string,
  fieldName: string,
  supertypes: Supertypes,
  fallbackRule: Rule | undefined,
): Rule | undefined {
  const named = permissions[typeName];
  const abstracts = supertypes.get(typeName);
  const wild = permissions[WILDCARD];
  return (
    fieldRuleOf(named, fieldName) ??
    inheritedRuleOf(permissions, abstracts, fieldName) ??
    fieldRuleOf(named, WILDCARD) ??
    inheritedRuleOf(permissions, abstracts, WILDCARD) ??
    fieldRuleOf(wild, fieldName) ??
    fieldRuleOf(wild, WILDCARD) ??
    fallbackRule
  );
}
