# ADR 0014: Safe invocation of Windows `.cmd`/`.bat` wrappers

- **Status:** Accepted, 2026-11-06. Implements refinement 1 of the architecture review. Phase 1
  defines the `InvocationStrategy` field of `ExecutionRecord`. Phase 2 implements the executor
  and its Windows integration tests; the question of `cross-spawn` is settled by
  [ADR 0018](0018-in-house-process-launcher.md). The adapters that produce wrapper commands
  arrive in Phase 3.
- **Deciders:** Mohamed Yangui

## Context

DevFlow's executor never uses a shell: commands are argv arrays (ADR 0006). On Windows, many
build entry points are batch files: `mvnw.cmd`, `gradlew.bat`, and the `npm`, `pnpm`, `npx` and
`node_modules/.bin/*` shims. Windows cannot execute a batch file without `cmd.exe`, and
`cmd.exe` re-parses the command line with its own rules (`%VAR%` expansion, `!` delayed
expansion, `^` escapes, `&`, `|`, `<`, `>`, parentheses). Node.js refuses to spawn `.cmd` and
`.bat` files without `shell: true` since the April 2024 security release (CVE-2024-27980),
for exactly this reason. So "no shell" and "run `mvnw.cmd`" conflict.

## Decision

The executor chooses an **invocation strategy** for every command and records it in
`ExecutionRecord.invocation`. Strategies are tried in this order:

1. **`direct`** — the executable is a real binary (`java`, `node`, `git`, an `.exe` found on
   `PATH`). It is spawned with an argv array and no shell, on every platform.
2. **`node-script`** — the target is a JavaScript entry point behind a shim. Package manager
   and `node_modules/.bin` shims are resolved to their JavaScript entry point (from the package's
   `bin` field), and spawned as `node <entry.js> <args>` using the current Node binary
   (`process.execPath`). No `cmd.exe` is involved. This covers npm, pnpm, yarn, Jest, Vitest,
   ESLint and tsc.
3. **`java-launcher`** — Maven and Gradle wrappers are run through their wrapper JARs with
   `java` directly:
   - Gradle: `java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <args>`;
   - Maven: the Maven Wrapper launcher in `.mvn/wrapper/maven-wrapper.jar`, with the
     `maven.multiModuleProjectDirectory` system property set the way `mvnw` sets it.

   The wrapper JAR's SHA-256 is part of the command fingerprint (ADR 0007), so a replaced JAR
   needs new approval. The Maven Wrapper "only-script" distribution type has no JAR; it uses
   strategy 4.

4. **`windows-batch`** — fallback only for a batch file that cannot be handled above. Allowed
   only when all of these hold:
   - the workspace is trusted and the batch file's SHA-256 is part of the approved command
     fingerprint;
   - every argument passes a strict character check: no `%`, `!`, `^`, `&`, `|`, `<`, `>`,
     `"`, `(`, `)`, and no control characters including CR and LF; anything else is rejected,
     not escaped;
   - the executor spawns `cmd.exe` explicitly, with a fixed argument layout:
     `cmd.exe /d /s /v:off /c "<batch> <args>"`, where `/d` disables AutoRun commands, `/v:off`
     disables delayed expansion, and `/s` fixes quote handling;
   - `windowsVerbatimArguments` is used so Node does not re-quote the line, and the line is
     built by one audited function with unit tests.

   Node's `shell: true` option is **never** used.

On POSIX systems, wrapper scripts (`./mvnw`, `./gradlew`) are executed directly with argv; no
batch handling exists there.

### Argument validation (all platforms)

In addition to the schema checks on `CommandSpec` (no control characters, maximum length,
whole-argument placeholders with anchored patterns), model-supplied parameter values must match
their declared pattern. The Windows batch character check above is applied on top, only for
`windows-batch`.

### Tests

Phase 2 adds Windows integration tests that run on the `windows-latest` CI leg and locally:

- a `.cmd` fixture that echoes its arguments, proving arguments arrive unchanged through
  `windows-batch`;
- rejection of each forbidden character, and of CR/LF, before any process starts;
- `node-script` resolution for a `node_modules/.bin` shim;
- `java-launcher` resolution for a Gradle wrapper fixture (skipped with a stated reason when
  Java is absent).

## Consequences

- Most commands never touch `cmd.exe`. The batch path is narrow, audited and visible in the
  report.
- Some legitimate arguments containing forbidden characters (for example a test filter with
  parentheses) cannot be passed to batch wrappers on Windows. The error says so and suggests the
  direct or java-launcher path.

## Alternatives considered

- **`cross-spawn`.** It escapes metacharacters for `cmd.exe`, but it is a general-purpose
  escaping layer we would have to trust for every argument shape. Deciding whether to use it
  is left to the Phase 2 executor design; if used, it would only serve the `windows-batch`
  path, behind the same character check.
- **`shell: true` with escaping.** Rejected: escaping for `cmd.exe` is error-prone.
- **Refusing all batch files.** Rejected: some Maven Wrapper distributions have no JAR.
