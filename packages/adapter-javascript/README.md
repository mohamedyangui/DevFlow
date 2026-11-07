# @devflow/adapter-javascript

**Status: not implemented. Planned for Phase 3.** The package exists so that its boundaries are
enforced from the start: it may depend only on `@devflow/core`. Lint rules forbid it from
importing `node:child_process`, `node:fs` or network modules (ADR 0003, ADR 0006).

Planned scope (see [docs/specs/language-adapter.md](../../docs/specs/language-adapter.md)):

- Package manager (npm, pnpm, yarn) and workspace detection.
- Evidence-based detection of Express, NestJS, React, Next.js and Vite.
- Jest, Vitest, Playwright (only when configured), ESLint and `tsc`, invoked through the
  project's locally installed tools. Nothing is installed automatically.
- Windows-safe invocation that resolves `node_modules/.bin` shims to their JavaScript entry
  points, so `cmd.exe` is not needed (ADR 0014).
- Detection of Protobuf code generation (`@bufbuild/protobuf`, `ts-proto`, `protobufjs`,
  `grpc-tools`) to link `.proto` files to consuming modules (ADR 0017).
