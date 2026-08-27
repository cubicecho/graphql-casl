import type { Types } from '@graphql-codegen/plugin-helpers';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { plugin, validate } from '../src/index.js';

const schema = buildSchema(`
  type Query { me: User, notes: [Note!]! }
  type Mutation { updateNote(id: ID!): Note }
  type User { id: ID! }
  type Note { id: ID!, userId: ID! }
  type Org { id: ID! }
`);

async function run(config: Parameters<typeof plugin>[2]) {
  const out = (await plugin(schema, [], config)) as Types.ComplexPluginOutput;
  return { prepend: out.prepend ?? [], content: out.content ?? '' };
}

describe('graphql-casl codegen plugin', () => {
  it('emits the four subject bindings', async () => {
    const { prepend, content } = await run({});

    expect(prepend).toContain(
      "import { createGraphQLAbility, createTyped, type SubjectMap, subjectsOf } from '@vantreeseba/graphql-casl';",
    );
    expect(content).toContain('export type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;');
    expect(content).toContain('export const Subject = subjectsOf<AppSubjectMap>();');
    expect(content).toContain('export const typed = createTyped<AppSubjectMap>();');
    expect(content).toContain(
      'export const ability = () => createGraphQLAbility<AppSubjectMap>();',
    );
  });

  it('emits no hand-listed subject names', async () => {
    // `subjectsOf` reads the names from `AppSubjectMap` at the type level, so no
    // name from the schema is ever written into the output.
    const { content } = await run({});

    for (const name of ['User', 'Note', 'Org', 'Query', 'Mutation']) {
      expect(content).not.toMatch(new RegExp(`${name}: '${name}'`));
    }
  });

  it('emits identical output regardless of the schema', async () => {
    // The whole emission is derived from `Resolvers`/`ResolversTypes` types, not
    // from the schema, so which types exist cannot change it. This is what makes
    // the output immune to schema drift: interfaces, unions and newly added types
    // become subjects via `SubjectMap` without regenerating anything here.
    const withComposites = buildSchema(`
      scalar DateTime
      enum Role { ADMIN USER }
      input NoteFilter { q: String }
      interface Node { id: ID! }
      type User implements Node { id: ID!, role: Role }
      type Note implements Node { id: ID! }
      union SearchResult = User | Note
      type Query { node(id: ID!): Node, search(f: NoteFilter): [SearchResult!]! }
    `);
    const minimal = buildSchema('type Query { ok: Boolean }');

    const [a, b, c] = (await Promise.all(
      [schema, withComposites, minimal].map((s) => plugin(s, [], {})),
    )) as Types.ComplexPluginOutput[];

    expect(b.content).toBe(a.content);
    expect(c.content).toBe(a.content);
  });

  it('honors config overrides', async () => {
    const { prepend, content } = await run({
      importPath: '#auth',
      subjectMapTypeName: 'SubjectsMap',
      subjectConstName: 'S',
      abilityName: 'makeAbility',
    });

    expect(prepend[0]).toContain("from '#auth'");
    expect(content).toContain('export type SubjectsMap = SubjectMap<Resolvers, ResolversTypes>;');
    expect(content).toContain('export const S = subjectsOf<SubjectsMap>();');
    expect(content).toContain(
      'export const makeAbility = () => createGraphQLAbility<SubjectsMap>();',
    );
  });

  it('validate accepts valid (string / undefined / absent) config', async () => {
    await expect(
      validate(schema, [], { subjectConstName: 'S', importPath: undefined }, 'out.ts', []),
    ).resolves.toBeUndefined();
    await expect(validate(schema, [], {}, 'out.ts', [])).resolves.toBeUndefined();
    await expect(validate(schema, [], undefined as never, 'out.ts', [])).resolves.toBeUndefined();
  });

  it('validate rejects non-string config values', async () => {
    await expect(validate(schema, [], { subjectConstName: 123 }, 'out.ts', [])).rejects.toThrow(
      /must be a string/,
    );
  });
});
