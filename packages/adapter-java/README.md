# @devflow-ai/adapter-java

The Java language adapter: it recognizes Maven and Gradle builds, describes what they use with
evidence, lists their tests, provides the commands that build and test them, and reads the
reports those commands write. It implements the `LanguageAdapter` port of `@devflow-ai/core`
([docs/specs/language-adapter.md](../../docs/specs/language-adapter.md), section 9).

The adapter only reads files through `RepositoryView` and returns data. It never runs a build
to learn about a project: POMs are parsed as XML, Gradle scripts and version catalogs are read
as text. ESLint forbids it from importing `node:child_process`, `node:fs` or network modules
(ADR 0003, ADR 0006). Its only dependency besides `@devflow-ai/core` is `fast-xml-parser`; XML
with entity declarations is refused, and truncated XML is never read as complete.

```ts
import { javaAdapter } from "@devflow-ai/adapter-java";
registry.register(javaAdapter);
```

## What it detects

| Concern         | Maven                                                                                                           | Gradle (Groovy and Kotlin DSL)                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Module          | a POM no other POM aggregates; its `<modules>` belong to it                                                     | the outermost settings file, or a build file outside any settings tree                |
| Build tool      | version from `.mvn/wrapper/maven-wrapper.properties`, wrapper `mvnw`                                            | version from `gradle/wrapper/gradle-wrapper.properties`, wrapper `gradlew`            |
| Java version    | `maven.compiler.release`/`target`/`source`, `java.version`, compiler plugin `release`                           | toolchain `languageVersion`, `jvmToolchain`, `sourceCompatibility`, `options.release` |
| Frameworks      | Spring Boot (parent, BOM, plugin, starters)                                                                     | Spring Boot (plugin, starters)                                                        |
| Test frameworks | JUnit 5, JUnit 4, TestNG, Mockito, AssertJ, Testcontainers                                                      | the same, plus `useJUnitPlatform()`                                                   |
| Quality tools   | Checkstyle, SpotBugs, PMD, JaCoCo, Spotless plugins                                                             | the same plugins                                                                      |
| Contracts       | `.proto` and OpenAPI files in the module; `protobuf-maven-plugin`, `openapi-generator-maven-plugin` `inputSpec` | `com.google.protobuf`, `org.openapi.generator` `inputSpec`                            |

Every detection carries evidence: the build file and, where it can be found, the declaring line.
Version catalog entries (`gradle/libs.versions.toml`) count fully only where a build file
references them (`libs.junit.jupiter`, `alias(libs.plugins.spring.boot)`); an entry nobody
references is reported with confidence 0.7. Plugins declared with `apply false` or only in a
settings file are not counted as applied.

## Tests and conventions

- **Inventory.** Maven: classes whose names match the Surefire (`*Test`, `*Tests`, `Test*`,
  `*TestCase`) and Failsafe (`*IT`, `IT*`, `*ITCase`) defaults. Gradle: every class in the test
  source sets (`src/test`, `src/integrationTest`, …). A readable file must contain a test
  annotation, so helpers such as `TestData` are not listed. Failsafe names, integration source
  sets and `@SpringBootTest`/`@Testcontainers` classes are `integration`; the rest `unit`.
- **Conventions**, each reported only when at least 60% of at least two files follow it, with
  the files as evidence: test class suffix, assertion library, Mockito extension, the Spring
  test slice used by controller, service and repository tests, and `@DisplayName`.
- **Authoring guide.** New tests go to `src/test/java` as `{name}Test.java`. The acceptance
  criterion marker is a method-name prefix, `void ac1_returnsSecondPage()`, with
  `@DisplayName("AC-1: …")` on JUnit 5: the method name reaches the JUnit XML report.

## Commands

Commands run in the module root with the wrapper when there is one, otherwise `mvn` or `gradle`
from PATH. One command per purpose has no parameters: that is the command a gate runs.

| Command        | Maven                                                  | Gradle                                                                  | Parser           |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------- |
| `compile`      | `test-compile`                                         | `testClasses`                                                           | `javac`          |
| `test`         | `test`                                                 | `cleanTest test`                                                        | `junit-xml`      |
| `test-filter`  | `--define {testSelector} … test` (`test=Class#method`) | `cleanTest test --tests {testFilter}`                                   | `junit-xml`      |
| `build`        | `verify`                                               | `cleanTest build`                                                       | `junit-xml`      |
| `checkstyle`   | `checkstyle:check`                                     | `cleanCheckstyleMain cleanCheckstyleTest checkstyleMain checkstyleTest` | `checkstyle-xml` |
| `spotbugs`     | `compile spotbugs:check`                               | `cleanSpotbugsMain spotbugsMain`                                        | `spotbugs-xml`   |
| `format-check` | `spotless:check`                                       | `spotlessCheck`                                                         | `exit-code`      |

Maven commands add `--batch-mode` and `--no-transfer-progress` (from Maven 3.6.1); Gradle
commands add `--no-daemon --console=plain`, so no daemon outlives the command. The quality
commands exist only when the build applies the plugin. Builds may download dependencies, so
commands declare network access.

## Reading results

- `junit-xml` reads `TEST-*.xml` from `target/surefire-reports` and `target/failsafe-reports`
  (Maven) or `build/test-results/*` (Gradle) of every project of the build, and only files
  written by this execution. Failures are `assertion_failure`, errors `runtime_error`, timeout
  exceptions `timeout`, skips `skipped`. Each test links to its source file and to the
  acceptance criteria in its name. No fresh report, or one that is not complete JUnit XML, is
  `unparseable`, never a pass; compiler errors from the build output are attached.
- `checkstyle-xml` and `spotbugs-xml` turn violations into diagnostics with repository-relative
  locations.
- `javac` reads compiler errors and warnings (Maven, javac and kotlinc formats) from the
  build output; the result is the exit code. A failed build whose output names no compiler
  error is `unparseable`.
- `exit-code` is for tools whose only result is their exit code.

## Limits

- Gradle scripts are not evaluated, so builds configured imperatively (custom source sets in
  code, plugins applied from convention plugins in `buildSrc` by computed names) may be
  partly missed; what is missed is not claimed.
- In a multi-project Gradle build, `--tests` applies to every project's `test` task, and
  Gradle fails a task whose tests do not match the filter.
- Report locations follow the tools' defaults; custom report directories are not read.
