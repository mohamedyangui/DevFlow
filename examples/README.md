# Examples

Small, real projects that DevFlow's own tests build and verify (`pnpm test:examples`), and that
you can try DevFlow on.

| Directory                                  | What it is                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`java-spring-boot`](java-spring-boot)     | Orders API with Spring Boot 4.1 and Maven, MockMvc tests, Maven wrapper with its JAR          |
| [`java-gradle`](java-gradle)               | Java library built with Gradle 9.9 (Kotlin DSL) and JUnit 6, Gradle wrapper                   |
| [`nodejs-express`](nodejs-express)         | Orders service with Express 5, tested with Vitest and Supertest                               |
| [`fullstack-monorepo`](fullstack-monorepo) | A Maven backend and a TypeScript web client, with modules and gates in `.devflow/config.yaml` |
| [`tasks`](tasks)                           | Task contracts in YAML, Markdown and JSON                                                     |

[`tasks/add-pagination.task.yaml`](tasks/add-pagination.task.yaml) (TASK-142) is written for
the `backend` module of `fullstack-monorepo`.

## Trying `devflow verify`

From a copy of an example (Java 21 or newer on PATH; for the JavaScript examples, run
`npm ci --ignore-scripts` first):

```bash
devflow trust
devflow verify
```

`devflow verify` asks before running each command, and shows the command, its working
directory and the files it executes. The builds download their dependencies from Maven
Central, services.gradle.org or the npm registry.

## Wrappers

The wrappers were generated with Maven 3.9.16 (`maven-wrapper-plugin` 3.3.4) and Gradle
9.9.0, each downloaded from its official site and checked against its published checksum.
They verify what they download:

| File                                                               | Pins                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `java-spring-boot/.mvn/wrapper/maven-wrapper.properties`           | `distributionSha256Sum` of Maven 3.9.16, `wrapperSha256Sum` of `maven-wrapper.jar` 3.3.4 |
| `fullstack-monorepo/backend/.mvn/wrapper/maven-wrapper.properties` | `distributionSha256Sum` of Maven 3.9.16 (script-only wrapper, no JAR)                    |
| `java-gradle/gradle/wrapper/gradle-wrapper.properties`             | `distributionSha256Sum` of Gradle 9.9.0                                                  |

Checksums of the committed wrapper JARs (SHA-256):

- `java-spring-boot/.mvn/wrapper/maven-wrapper.jar` (3.3.4):
  `4e2fbf6554bc8a4702cdfdd3bef464f423393d784ddbb037216320ce55d5e4e1`, the same file as
  `org.apache.maven.wrapper:maven-wrapper:3.3.4` on Maven Central.
- `java-gradle/gradle/wrapper/gradle-wrapper.jar` (9.9.0):
  `621008afc4f5d59357fcf06ffa644dd5aade5e091bdc363742710445f73cdaf8`, as published at
  `https://services.gradle.org/distributions/gradle-9.9.0-wrapper.jar.sha256`.

DevFlow binds the wrapper scripts, JARs and properties into each command's approval
fingerprint, so a changed wrapper needs a new approval.
