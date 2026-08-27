/**
 * A GraphQL Code Generator plugin that emits the `@vantreeseba/graphql-casl`
 * subject bindings for your generated resolver types, so you never hand-write
 * them.
 *
 * Run it after `typescript` + `typescript-resolvers` in the same output file (it
 * references the `Resolvers` / `ResolversTypes` they emit). It generates:
 *
 * - `AppSubjectMap` — `SubjectMap<Resolvers, ResolversTypes>`
 * - `Subject` — a `subjectsOf` namespace of subject names, derived from the map
 * - `typed` — a `createTyped` tagger bound to `AppSubjectMap`
 * - `ability` — a `createGraphQLAbility` factory bound to `AppSubjectMap`
 *
 * @packageDocumentation
 */

import type { PluginFunction, PluginValidateFn } from '@graphql-codegen/plugin-helpers';

/** Configuration for the {@link plugin}. Every field has a sensible default. */
export interface GraphqlCaslPluginConfig {
  /** Import path for the runtime library. Default `@vantreeseba/graphql-casl`. */
  importPath?: string;
  /** Name of the generated subject-map type. Default `AppSubjectMap`. */
  subjectMapTypeName?: string;
  /** Name of the generated subject-name namespace. Default `Subject`. */
  subjectConstName?: string;
  /** Name of the generated `typed` tagger. Default `typed`. */
  typedName?: string;
  /** Name of the generated ability factory. Default `ability`. */
  abilityName?: string;
  /** Name of the `Resolvers` type emitted by `typescript-resolvers`. Default `Resolvers`. */
  resolversTypeName?: string;
  /** Name of the `ResolversTypes` type emitted by `typescript-resolvers`. Default `ResolversTypes`. */
  resolversTypesName?: string;
}

const DEFAULTS = {
  importPath: '@vantreeseba/graphql-casl',
  subjectMapTypeName: 'AppSubjectMap',
  subjectConstName: 'Subject',
  typedName: 'typed',
  abilityName: 'ability',
  resolversTypeName: 'Resolvers',
  resolversTypesName: 'ResolversTypes',
} satisfies Required<GraphqlCaslPluginConfig>;

export const plugin: PluginFunction<GraphqlCaslPluginConfig> = (_schema, _documents, config) => {
  const opts = { ...DEFAULTS, ...config };

  const content = [
    `export type ${opts.subjectMapTypeName} = SubjectMap<${opts.resolversTypeName}, ${opts.resolversTypesName}>;`,
    '',
    `export const ${opts.subjectConstName} = subjectsOf<${opts.subjectMapTypeName}>();`,
    '',
    `export const ${opts.typedName} = createTyped<${opts.subjectMapTypeName}>();`,
    '',
    `export const ${opts.abilityName} = () => createGraphQLAbility<${opts.subjectMapTypeName}>();`,
    '',
  ].join('\n');

  return {
    prepend: [
      `import { createGraphQLAbility, createTyped, type SubjectMap, subjectsOf } from '${opts.importPath}';`,
    ],
    content,
  };
};

export const validate: PluginValidateFn = async (_schema, _documents, config) => {
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`graphql-casl-codegen: config option \`${key}\` must be a string.`);
    }
  }
};
