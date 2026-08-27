# [1.1.0](https://github.com/cubicecho/graphql-casl/compare/v1.0.0...v1.1.0) (2026-08-27)


### Bug Fixes

* point package metadata at the actual repository ([71d46b3](https://github.com/cubicecho/graphql-casl/commit/71d46b3bf6df6700a13fdf2cbef296b182c73e6a))


### Features

* add fallbackRule and wildcard keys to the permissions map ([f9c6083](https://github.com/cubicecho/graphql-casl/commit/f9c608331c30378b1870185fceb135d9c1724ad1))
* add wrap(), composing rules the combinators cannot ([f70ceae](https://github.com/cubicecho/graphql-casl/commit/f70ceaeee4aa6dc031316504888e797fba8bb2fc))
* **graphql-casl-envelop:** add an envelop/Yoga plugin ([37e16cf](https://github.com/cubicecho/graphql-casl/commit/37e16cf38fc0b6f1214c032e68eece19c47f23a3))
* **graphql-casl:** add accessibleBy for row-level filtering ([cd37b90](https://github.com/cubicecho/graphql-casl/commit/cd37b90e36c6e873f7055c94bbb5bff5dcdb7b7b))
* **graphql-casl:** add fallbackError, allowExternalErrors, debug and CASL reasons ([ecb154b](https://github.com/cubicecho/graphql-casl/commit/ecb154ba22612fbbc5877a14dcc365192435e872))
* **graphql-casl:** add optional argument scoping via a /scoping subpath ([7e89ce3](https://github.com/cubicecho/graphql-casl/commit/7e89ce3fa2c620f59c2ae13eb28cf04b976197c4))
* **graphql-casl:** add post-execution rules via canUser.onResult ([df29b06](https://github.com/cubicecho/graphql-casl/commit/df29b06fbed8a9cb4051c650b32f63543f572ea3))
* **graphql-casl:** add rule() and the and/or/not/chain/race combinators ([c70b896](https://github.com/cubicecho/graphql-casl/commit/c70b896c8ed25d67b8c72a81c83d99085b52b4b2))
* **graphql-casl:** drive field rules from CASL field permissions ([3191e1d](https://github.com/cubicecho/graphql-casl/commit/3191e1de3b9be96e81a58dcd33abf1394ac1ebad))
* **graphql-casl:** expose resolvePermissions for other integrations ([fb55986](https://github.com/cubicecho/graphql-casl/commit/fb55986cb22de31c6e6706cdc1655727053aee75))
* **graphql-casl:** mask denied fields instead of throwing ([d355a65](https://github.com/cubicecho/graphql-casl/commit/d355a652a5bf9e8cd6a0deb037da27efea83d175))
* **graphql-casl:** pass parent to getSubjectData for field-level rules ([72b3932](https://github.com/cubicecho/graphql-casl/commit/72b393273244092814c6aedfe889a2b85213ab20))
* guard bare-subject checks and memoize the request ability ([5890794](https://github.com/cubicecho/graphql-casl/commit/5890794fd72881b0856013dfeb8024e99c59dbe1))
* validate the permissions map against the schema ([da137c3](https://github.com/cubicecho/graphql-casl/commit/da137c377d937444084697328d00577f8d3c8b24))

# [1.0.0](https://github.com/vantreeseba/graphql-casl/compare/v0.2.1...v1.0.0) (2026-06-19)


### Bug Fixes

* address code-review findings (matcher, tagging, codegen, IDOR) ([8dec69d](https://github.com/vantreeseba/graphql-casl/commit/8dec69defb751d881f8b79377f4e7a1ae1cf7e76))
* review pass — packaging, codegen peer dep, release auth, docs ([3b29ecd](https://github.com/vantreeseba/graphql-casl/commit/3b29ecdd7488c91d5a6eddd7c4bace627a6051d3))
* tighten AbilityLike typing and fail loud on untagged subjects ([fa93235](https://github.com/vantreeseba/graphql-casl/commit/fa93235c59d321a57c821203c0fcc814e01ea144))


### Features

* **codegen:** add codegen plugin in an npm-workspaces monorepo ([1514c36](https://github.com/vantreeseba/graphql-casl/commit/1514c3670f5eec47dfb91f60db07b71bb21184f0))
* replace MongoAbility with a schema-typed GraphQLAbility ([ca3e6eb](https://github.com/vantreeseba/graphql-casl/commit/ca3e6eb36740d44528fe05bc6fdff8b6b4983a29))
* type getSubjectData against the subject's fields ([8c327aa](https://github.com/vantreeseba/graphql-casl/commit/8c327aa6f663a955200421ee44e463a9d16668bd))


### BREAKING CHANGES

* condition operators are now CASL mongo-style ($in/$gt/$ne/…)
instead of the previous bare names (in/gt/ne); the GqlOperators/GqlConditions/
GqlFieldCondition/GqlConditionsFor types and gqlConditionsMatcher are removed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
* createCan's second type parameter is now the SubjectMap, not
the ability type, and getSubjectData's args are typed by annotating the
callback parameter instead of passing canUser<Args>(...).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
* AppAbility and abilityOptions are removed. Build abilities
with createGraphQLAbility/buildGraphQLAbility; conditions now use the
eq/ne/in/nin/gt/gte/lt/lte operator set instead of mongo-query operators.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

## [0.2.1](https://github.com/vantreeseba/graphql-casl/compare/v0.2.0...v0.2.1) (2026-06-18)


### Bug Fixes

* trigger release ([6e1b745](https://github.com/vantreeseba/graphql-casl/commit/6e1b7458c6d6224f3c2fd32bf203d5688e5e0f5a))

# [0.2.0](https://github.com/vantreeseba/graphql-casl/compare/v0.1.1...v0.2.0) (2026-06-18)


### Bug Fixes

* Change workflow to use OIDC ([9516676](https://github.com/vantreeseba/graphql-casl/commit/9516676a12fa4b5e9757f518dc6a2965e4a09585))
* validate createTyped attrs and return against the named subject ([9f10799](https://github.com/vantreeseba/graphql-casl/commit/9f1079942d6c7e575e1c663cd633f68fc082e897))


### Features

* make createCan type-safe and guard getSubjectData misuse ([4e43b98](https://github.com/vantreeseba/graphql-casl/commit/4e43b986572a3a8781704ad903cfb9532845fd8e))
* validate PermissionsMap keys and add applyPermissions ([409dfd9](https://github.com/vantreeseba/graphql-casl/commit/409dfd932cb473ffd50efa6fb93a9738e044c50e))

## [0.1.1](https://github.com/vantreeseba/graphql-casl/compare/v0.1.0...v0.1.1) (2026-06-17)


### Bug Fixes

* Update version manually to force publish. ([71de95a](https://github.com/vantreeseba/graphql-casl/commit/71de95a79e2b9faca03d42383a0de64aed048244))
