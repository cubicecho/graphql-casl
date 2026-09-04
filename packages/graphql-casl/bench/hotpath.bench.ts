/**
 * Hot-path benchmarks: what one request costs under each way of guarding a
 * 100-row list with 5 selected fields. Run with `npm run bench` from the
 * package. Numbers are relative — compare rows within one run, not across
 * machines.
 */

import { envelop, useEngine, useSchema } from '@envelop/core';
import { makeExecutableSchema } from '@graphql-tools/schema';
import * as GraphQLJS from 'graphql';
import { type GraphQLSchema, graphql, isObjectType, parse } from 'graphql';
import { bench, describe } from 'vitest';
import { useGraphQLCasl } from '../src/envelop.js';
import {
  type ApplyPermissionsOptions,
  accept,
  and,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  type PermissionsMap,
  resolvePermissions,
  rule,
} from '../src/index.js';

type Note = { id: string; title: string; body: string; author: string; year: number };
type SubjectMap = { Note: Note };
type Context = { userId: string | null };

const ROWS = 100;
const rows: Note[] = Array.from({ length: ROWS }, (_, i) => ({
  id: String(i),
  title: 't',
  body: 'b',
  author: i % 2 ? 'u1' : 'u2',
  year: 2020,
}));

const typeDefs = /* GraphQL */ `
  type Note { id: ID title: String body: String author: String year: Int }
  type Query { notes: [Note!]! }
`;

function baseSchema(): GraphQLSchema {
  return makeExecutableSchema({ typeDefs, resolvers: { Query: { notes: () => rows } } });
}

const query = '{ notes { id title body author year } }';
const document = parse(query);
const typed = createTyped<SubjectMap>();

function abilityFor(userId: string | null, conditioned: boolean) {
  const { can, build } = createGraphQLAbility<SubjectMap>();
  if (userId) {
    if (conditioned) can('read', 'Note', { author: userId });
    else can('read', 'Note');
  }
  return build();
}

function makeCan(conditioned: boolean) {
  return createCan<Context, SubjectMap>(
    async (ctx) => abilityFor(ctx.userId, conditioned),
    (ctx) => ctx.userId != null,
    typed,
    { onUnconditionedSubject: 'allow' },
  );
}

type Map = PermissionsMap<Record<string, Record<string, unknown>>>;

function guarded(permissions: Map, options?: ApplyPermissionsOptions): () => Promise<void> {
  const schema = applyPermissions(baseSchema(), permissions, options);
  return async () => {
    const result = await graphql({ schema, source: query, contextValue: { userId: 'u1' } });
    if (result.errors) throw result.errors[0];
  };
}

describe('100 rows x 5 fields', () => {
  const unguarded = baseSchema();
  bench('unguarded schema (graphql-js baseline)', async () => {
    const result = await graphql({ schema: unguarded, source: query, contextValue: {} });
    if (result.errors) throw result.errors[0];
  });

  bench('accept on every field', guarded({ Query: { notes: accept }, Note: accept }));

  const syncRole = rule((_p, _a, ctx) => ctx.userId === 'u1', { name: 'isU1' });
  bench('sync rule() on every field', guarded({ Query: { notes: syncRole }, Note: syncRole }));

  const asyncRole = rule(async (_p, _a, ctx) => ctx.userId === 'u1', { name: 'isU1' });
  bench('async rule() on every field', guarded({ Query: { notes: asyncRole }, Note: asyncRole }));

  const contextual = rule(async (_p, _a, ctx) => ctx.userId === 'u1', {
    name: 'isU1',
    cache: 'contextual',
  });
  bench(
    "rule() with cache: 'contextual'",
    guarded({ Query: { notes: contextual }, Note: contextual }),
  );

  const strict = rule(async (_p, _a, ctx) => ctx.userId === 'u1', {
    name: 'isU1',
    cache: 'strict',
  });
  bench("rule() with cache: 'strict'", guarded({ Query: { notes: strict }, Note: strict }));

  const canUser = makeCan(false);
  const bare = canUser('read', 'Note');
  bench('createCan bare check on every field', guarded({ Query: { notes: bare }, Note: bare }));

  const canUserWarn = createCan<Context, SubjectMap>(
    async (ctx) => abilityFor(ctx.userId, true),
    (ctx) => ctx.userId != null,
    typed,
  );
  const bareWarn = canUserWarn('read', 'Note');
  bench(
    'createCan bare check, conditioned ability (warn path)',
    guarded({ Query: { notes: bareWarn }, Note: bareWarn }),
  );

  const canRow = makeCan(true);
  const rowRule = canRow('read', 'Note', (_args, parent: Note) => ({ author: parent.author }));
  const allRows = createCan<Context, SubjectMap>(
    async (ctx) => abilityFor(ctx.userId, false),
    (ctx) => ctx.userId != null,
    typed,
  )('read', 'Note', (_args, parent: Note) => ({ author: parent.author }));
  bench(
    'createCan conditioned check from parent on every field',
    guarded({ Query: { notes: accept }, Note: allRows }),
  );

  const fields = makeCan(false).fields('read', 'Note');
  bench('createCan.fields on the type', guarded({ Query: { notes: accept }, Note: fields }));

  bench(
    'and(sync, sync) on every field',
    guarded({ Query: { notes: accept }, Note: and(syncRole, accept) }),
  );

  bench(
    'accept + fallbackError set (error-control wrapper)',
    guarded({ Query: { notes: accept }, Note: accept }, { fallbackError: 'Nope' }),
  );

  const halfDenied = rule((parent: unknown) => (parent as Note).author === 'u1', {
    name: 'ownRow',
  });
  bench(
    'maskDenials, half the rows denied on every field',
    guarded({ Query: { notes: accept }, Note: halfDenied }, { maskDenials: true }),
  );

  bench(
    'maskDenials, conditioned createCan, half the rows denied',
    guarded({ Query: { notes: accept }, Note: rowRule }, { maskDenials: true }),
  );

  // The envelop path, for parity with applyPermissions.
  const getEnveloped = envelop({
    plugins: [
      useEngine(GraphQLJS),
      useSchema(baseSchema()),
      useGraphQLCasl<Record<string, Record<string, unknown>>>({
        permissions: { Query: { notes: syncRole }, Note: syncRole },
      }),
    ],
  });
  bench('envelop plugin, sync rule() on every field', async () => {
    const { execute, schema, contextFactory } = getEnveloped({ userId: 'u1' });
    const result = await execute({
      schema,
      document,
      contextValue: await contextFactory(),
    });
    if (result.errors) throw result.errors[0];
  });

  void deny;
});

describe('apply time', () => {
  const TYPES = 1000;
  const FIELDS = 8;
  const bigTypeDefs = [
    ...Array.from(
      { length: TYPES },
      (_, t) =>
        `type T${t} { ${Array.from({ length: FIELDS }, (_, f) => `f${f}: String`).join(' ')} }`,
    ),
    `type Query { ${Array.from({ length: TYPES }, (_, t) => `t${t}: T${t}`).join(' ')} }`,
  ].join('\n');
  const big = makeExecutableSchema({ typeDefs: bigTypeDefs });

  bench(`applyPermissions, ${TYPES} types x ${FIELDS} fields, sparse map`, () => {
    applyPermissions(big, { Query: { t0: accept } });
  });

  bench(`applyPermissions, ${TYPES} types x ${FIELDS} fields, fallbackRule: deny`, () => {
    applyPermissions(big, { Query: { t0: accept } }, { fallbackRule: deny });
  });

  bench(`applyPermissions, ${TYPES} types x ${FIELDS} fields, fallbackRule + maskDenials`, () => {
    applyPermissions(
      big,
      { Query: { t0: accept } },
      { fallbackRule: deny, maskDenials: true, fallbackError: 'Nope' },
    );
  });

  // The half this package owns: validation plus the per-field rule lookup for
  // every field, without graphql-middleware's rebuild.
  bench(`resolvePermissions only, ${TYPES} types x ${FIELDS} fields, fallbackRule: deny`, () => {
    const permissionFor = resolvePermissions(
      big,
      { Query: { t0: accept } },
      { fallbackRule: deny },
    );
    for (const type of Object.values(big.getTypeMap())) {
      if (!isObjectType(type)) continue;
      for (const fieldName of Object.keys(type.getFields())) permissionFor(type.name, fieldName);
    }
  });

  // `inPlace` mutates, and refuses a second pass over the same schema, so each
  // iteration has to build a fresh one — and vitest's bench options carry no
  // per-iteration hook to keep that out of the timing. So the build is timed
  // on its own, and the in-place rows are read as "row minus baseline".
  bench(`makeExecutableSchema only, ${TYPES} types x ${FIELDS} fields (baseline)`, () => {
    makeExecutableSchema({ typeDefs: bigTypeDefs });
  });

  bench(`build + applyPermissions inPlace, ${TYPES} types x ${FIELDS} fields, sparse map`, () => {
    const fresh = makeExecutableSchema({ typeDefs: bigTypeDefs });
    applyPermissions(fresh, { Query: { t0: accept } }, { inPlace: true });
  });

  bench(
    `build + applyPermissions inPlace, ${TYPES} types x ${FIELDS} fields, fallbackRule: deny`,
    () => {
      const fresh = makeExecutableSchema({ typeDefs: bigTypeDefs });
      applyPermissions(fresh, { Query: { t0: accept } }, { fallbackRule: deny, inPlace: true });
    },
  );
});
