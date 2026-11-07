# @devflow/adapter-java

**Status: not implemented. Planned for Phase 3.** The package exists so that its boundaries are
enforced from the start: it may depend only on `@devflow/core`. Lint rules forbid it from
importing `node:child_process`, `node:fs` or network modules, because adapters only read
through `RepositoryView` and return commands as data (ADR 0003, ADR 0006).

Planned scope (see [docs/specs/language-adapter.md](../../docs/specs/language-adapter.md)):

- Maven and Gradle (Groovy and Kotlin DSL, single and multi-module), with wrapper resolution
  that is safe on Windows (ADR 0014).
- Evidence-based detection of Spring Boot, JUnit 5, Mockito, Checkstyle and SpotBugs.
- Detection of Protobuf build plugins (`protobuf-maven-plugin`, `com.google.protobuf`) so
  that `.proto` files can be linked to the modules that generate code from them (ADR 0017).
- Command catalog and parsers for Surefire, Failsafe and Gradle JUnit XML, Checkstyle and
  SpotBugs reports.
