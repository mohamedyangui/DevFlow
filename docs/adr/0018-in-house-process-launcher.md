# ADR 0018: An in-house process launcher instead of `cross-spawn`

- **Status:** Accepted, 2026-11-07. Settles the open question in the alternatives of
  [ADR 0014](0014-windows-invocation.md). Implemented in Phase 2 in `@devflow/core`
  (`src/security/invocation.ts`, `windows-invocation.ts`, `process-launcher.ts`,
  `executor.ts`).
- **Deciders:** Mohamed Yangui

## Context

ADR 0014 fixes four invocation strategies for commands (`direct`, `node-script`,
`java-launcher`, `windows-batch`) and leaves open whether the `windows-batch` path, and
command resolution in general, should use the `cross-spawn` package. The architecture proposal
had listed `cross-spawn` as the process library.

`cross-spawn` solves a different problem from DevFlow's. It makes `spawn` behave the same on
every platform for **any** command: it resolves the executable with `PATHEXT`, follows shebangs,
and when the target is a batch file it runs `cmd.exe` and escapes every argument so that
`cmd.exe` passes it through. DevFlow does not want any argument to reach `cmd.exe` that needs
escaping, and it already knows which few kinds of programs it runs: binaries, Node.js shims,
Maven and Gradle wrappers, and the occasional batch file.

## Decision

1. **DevFlow does not depend on `cross-spawn`.** Command resolution and launching are written
   in `@devflow/core`, in small modules with their own tests.
2. **Exactly one module may start processes:** `src/security/process-launcher.ts` imports
   `node:child_process`, and only the executor imports the launcher. ESLint forbids
   `child_process` everywhere else, and a repository test fails if a second file imports it,
   loads it dynamically, or uses `process.binding` or `worker_threads`.
3. **The executor runs only `ApprovedCommand` objects** that the command policy created in the
   same process. They are deep-frozen and tracked in a `WeakSet`, so a copied or hand-built
   object is refused with `COMMAND_NOT_APPROVED`.
4. **Resolution** (`invocation.ts`):
   - Bare tool names are looked up on `PATH`. Relative `PATH` entries (`.`, `bin`) are ignored,
     so a repository cannot shadow a tool. On Windows only `.com`, `.exe`, `.bat` and `.cmd`
     are considered, in `PATHEXT` order; `.js`, `.vbs` and other associations are not.
   - **`node-script`:** a `.cmd` shim (npm's `cmd-shim`, pnpm's shims, Node's own `npm.cmd`) is
     read (at most 64 KB), and its JavaScript entry point is taken from the shim text. The entry
     point must be an existing `.js`, `.mjs` or `.cjs` file one level above the shim's directory
     or below it (for `node_modules/.bin/vitest.cmd`, inside `node_modules`), and it is run as
     `process.execPath <entry> <args>`. Reading the shim, rather than a package's `bin` field,
     binds exactly the file that the shim would have run.
   - **`java-launcher`:** on Windows, `gradlew` and `mvnw` with a wrapper JAR run as `java`
     from `JAVA_HOME` (else `PATH`) with the JAR on the class path, the same arguments the
     wrapper scripts pass (`-Xmx64m -Xms64m -Dorg.gradle.appname=gradlew` for Gradle,
     `-Dmaven.multiModuleProjectDirectory=<cwd>` for Maven). The JAR and its properties file
     are bound into the command fingerprint by hash.
   - **`windows-batch`:** everything else on Windows that is a batch file, including the Maven
     Wrapper "only-script" distribution. `cmd.exe` is taken from `%SystemRoot%\System32`, not
     from `PATH` or `ComSpec`, with the fixed layout `/d /s /v:off /c "<line>"` and
     `windowsVerbatimArguments`. Every argument passes the ADR 0014 character check; an
     argument that would need quoting and ends with a backslash is also rejected, because the
     backslash would escape the closing quote. Arguments containing a space, tab, `,`, `;` or
     `=` (which `cmd.exe` treats as separators) or that are empty are quoted.
   - On POSIX, wrappers and tools are run directly.
5. **Launching** (`process-launcher.ts`): `spawn` with an argv array, `shell: false`, stdin
   closed, `windowsHide`, and the allowlisted environment. On POSIX the child gets its own
   process group. On timeout or cancellation the whole tree is killed: `taskkill /T /F` on
   Windows, `SIGTERM` and then `SIGKILL` to the process group on POSIX. Output is kept as a
   tail of at most 5 MB per stream by default.

## Consequences

- The code that decides how an argument reaches a process is about 800 lines that DevFlow owns
  and tests, including integration tests that start real processes on the Windows and Linux CI
  legs. There is no general-purpose escaping layer to audit.
- Arguments that `cmd.exe` would interpret are refused on the `windows-batch` path instead of
  escaped. A test filter with parentheses cannot be passed to a batch wrapper; the error names
  the argument and the character.
- Shim formats are recognized by pattern. A package manager that changes its shim format falls
  back to `windows-batch`, which is safe but stricter; a test pins the formats known today.
- One fewer runtime dependency in `@devflow/core`.

## Alternatives considered

- **`cross-spawn` for every command.** Rejected: it would decide escaping for all argument
  shapes, and its batch path re-quotes arguments for `cmd.exe`, which is the behaviour ADR 0014
  avoids.
- **`cross-spawn` only behind the `windows-batch` character check.** Rejected: once the check
  has rejected every metacharacter, what remains is quoting a few separators, which does not
  justify a dependency on the security path.
- **`execa`.** Rejected for the same reasons, and it is larger.
- **Node's `shell: true`.** Rejected by ADR 0014.
