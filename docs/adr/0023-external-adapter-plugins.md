# ADR 0023: External language adapters as user-installed plugins, with adapter API versioning

- **Status:** Accepted, 2026-11-10. Implemented in Phase 6 in `@devflow-ai/core`
  (`src/adapters/api-version.ts`, `src/adapters/plugins.ts`) and `@devflow-ai/cli`
  (`devflow plugins`, `src/adapters.ts`).
- **Deciders:** Mohamed Yangui

## Context

DevFlow ships three language adapters (Java, JavaScript/TypeScript, Python). Other ecosystems
(Go, Rust, .NET, in-house build systems) need adapters written and released outside this
repository. Loading third-party code raises three questions: who decides which code is
loaded, how DevFlow notices that the code changed, and how an adapter written for one version
of the interface fails cleanly on another.

The rule that matters most comes from [ADR 0007](0007-workspace-trust.md): repository content
is untrusted. A repository must never be able to load code into DevFlow by itself, whether by
shipping a `node_modules` package, a plugin list, or a configuration entry.

## Decision

**API versioning.** The adapter interface has a semver version, `ADAPTER_API_VERSION`
(`1.0.0`), exported by `@devflow-ai/core`. Every adapter declares the version it targets in
`apiVersion` (the built-in adapters declare `1.0.0`; `defineAdapter` defaults to the SDK's
version). The registry accepts an adapter when the major versions are equal and the
adapter's minor version is not above the host's; the patch version is ignored. Otherwise it
throws `ADAPTER_API_INCOMPATIBLE`, naming both versions. A minor version may only add optional
capabilities that older adapters do without; removing or changing anything adapters rely on
is a major version.

**Plugins are declared by the user only.** A plugin is an ES module, usually an npm package,
whose `devflowAdapter` export (or default export) is an adapter object with a manifest: `id`,
`displayName`, `apiVersion` and `languages`. The user adds it with
`devflow plugins add <package|path>`; DevFlow records it in `$DEVFLOW_HOME/plugins.json`
(`~/.devflow/plugins.json` by default), next to the trust store and outside every repository.
A package name is resolved only in `$DEVFLOW_HOME/plugins/node_modules` (installed with
`npm install --prefix "$DEVFLOW_HOME/plugins" <package>`); anything else is a path the user
typed. The current directory and the analysed repository are never searched. The project
configuration cannot add, enable or point at a plugin: it can only name an adapter id that is
already registered (`modules[].adapter`), as before.

**Integrity.** The list records the resolved real path of the entry file, its SHA-256 and the
SHA-256 of the package's `package.json`. Before every import the hashes are compared; a
plugin whose files changed or disappeared is refused with `PLUGIN_CHANGED` and verification
stops, rather than quietly losing a language's modules. Adding the plugin again accepts the
change. The import URL carries the checked hash, so a re-added plugin is imported afresh
instead of from the module cache.

**Validation.** The imported export is checked at run time: required methods are functions,
the id matches `^[a-z][a-z0-9-]{0,31}$`, `languages` is a non-empty list, and the API version
is compatible (`PLUGIN_INVALID`, `ADAPTER_API_INCOMPATIBLE`). The adapter is then registered
like a built-in one: `validatedAdapter` checks everything it returns against the core schemas
and turns an exception into `ADAPTER_FAILED` naming the adapter and the operation, and a
failure during discovery is a warning that does not hide other modules.

**Precedence.** Built-in adapters take precedence: `plugins add` refuses a plugin with a
built-in id, and a hand-edited list entry with such an id is ignored with a warning. Two
plugins with the same id are refused (the list is keyed by id; adding the same id from
another location requires removing the first).

**Commands.** A plugin returns `CommandSpec`s and never executes anything itself; its commands
go through the same command policy, hard deny list, workspace trust and approval fingerprints
as the built-in adapters' commands.

## Consequences

- A plugin is **trusted code running in the DevFlow process** with the user's privileges,
  exactly like any npm package the user installs. The rule "adapters have no side effects"
  is enforced by lint for the built-in adapters only; for a plugin it is a contract DevFlow
  cannot enforce. Adding a plugin is a decision of the same kind as `npm install`.
- The hashes cover the entry file and `package.json`, not the modules the entry imports or
  the plugin's dependencies. They detect a changed or replaced plugin at rest; they do not
  protect against an attacker who can already write to the user's home directory, nor
  against a change between the hash check and the import.
- Importing a plugin runs its top-level code, so `plugins add` executes the plugin once to
  check it. `plugins list` only hashes files and imports nothing.
- No sandboxing (worker threads, separate processes) for now: it would not make an untrusted
  plugin safe while it shares the user's privileges, and it would complicate the interface.
- New error codes: `ADAPTER_API_INCOMPATIBLE`, `PLUGIN_INVALID`, `PLUGIN_CHANGED`,
  `PLUGIN_NOT_FOUND`, `PLUGIN_STORE_INVALID`.

## Alternatives considered

- **Discovering plugins in the repository's `node_modules` or from a config key.** Rejected:
  it lets a repository load code into DevFlow, which ADR 0007 forbids.
- **A repository-level selection among installed plugins** (`adapters.enable`). Not needed
  yet: declared modules already choose an adapter by id, and all installed plugins are the
  user's own choice. It can be added later without changing the trust model, since it could
  only narrow the set.
- **Integer API version (the previous `apiVersion: 1`).** Replaced by semver so a minor,
  backward-compatible extension does not lock out every older adapter.
