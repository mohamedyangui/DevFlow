import { MemoryRepository } from "@devflow/core/testing";

/** A Spring Boot service built with the Maven wrapper, in a monorepo with a shared contract. */
export const SPRING_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>orders</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
      <plugin>
        <artifactId>maven-checkstyle-plugin</artifactId>
        <version>3.5.0</version>
      </plugin>
      <plugin>
        <groupId>com.github.spotbugs</groupId>
        <artifactId>spotbugs-maven-plugin</artifactId>
        <version>4.8.6.4</version>
      </plugin>
      <plugin>
        <groupId>io.github.ascopes</groupId>
        <artifactId>protobuf-maven-plugin</artifactId>
        <version>2.6.0</version>
      </plugin>
      <plugin>
        <groupId>org.openapitools</groupId>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <version>7.8.0</version>
        <executions>
          <execution>
            <configuration>
              <inputSpec>\${project.basedir}/../../contracts/orders.openapi.yaml</inputSpec>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;

const javaTest = (pkg: string, name: string, body: string, imports: string[] = []) =>
  [
    `package ${pkg};`,
    "",
    ...imports.map((i) => `import ${i};`),
    "",
    body.replace("{name}", name),
    "",
  ].join("\n");

export function springMavenRepo(): MemoryRepository {
  const pkg = "com.acme.orders";
  const dir = "services/orders/src/test/java/com/acme/orders";
  return new MemoryRepository({
    "services/orders/pom.xml": SPRING_POM,
    "services/orders/mvnw": "#!/bin/sh\n",
    "services/orders/mvnw.cmd": "@echo off\n",
    "services/orders/.mvn/wrapper/maven-wrapper.properties":
      "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip\n",
    "services/orders/src/main/java/com/acme/orders/OrdersApplication.java": `package ${pkg};\n\npublic class OrdersApplication {}\n`,
    "services/orders/src/main/proto/orders.proto": 'syntax = "proto3";\n',
    [`${dir}/OrderControllerTest.java`]: javaTest(
      pkg,
      "OrderControllerTest",
      [
        "@WebMvcTest",
        "class {name} {",
        "  @Test",
        '  @DisplayName("AC-1: returns the second page")',
        "  void ac1_returnsSecondPage() {",
        "    assertThat(1).isEqualTo(1);",
        "  }",
        "}",
      ].join("\n"),
      [
        "org.junit.jupiter.api.DisplayName",
        "org.junit.jupiter.api.Test",
        "static org.assertj.core.api.Assertions.assertThat",
      ],
    ),
    [`${dir}/PaymentControllerTest.java`]: javaTest(
      pkg,
      "PaymentControllerTest",
      [
        "@WebMvcTest",
        "class {name} {",
        "  @Test",
        '  @DisplayName("refunds")',
        "  void refunds() { assertThat(true).isTrue(); }",
        "}",
      ].join("\n"),
      [
        "org.junit.jupiter.api.DisplayName",
        "org.junit.jupiter.api.Test",
        "static org.assertj.core.api.Assertions.assertThat",
      ],
    ),
    [`${dir}/OrderServiceTest.java`]: javaTest(
      pkg,
      "OrderServiceTest",
      [
        "@ExtendWith(MockitoExtension.class)",
        "class {name} {",
        "  @Mock Object repository;",
        "  @Test void ac2_rejectsEmptyOrders() { assertThat(repository).isNull(); }",
        "}",
      ].join("\n"),
      [
        "org.junit.jupiter.api.Test",
        "org.junit.jupiter.api.extension.ExtendWith",
        "org.mockito.Mock",
        "org.mockito.junit.jupiter.MockitoExtension",
        "static org.assertj.core.api.Assertions.assertThat",
      ],
    ),
    [`${dir}/OrdersIT.java`]: javaTest(
      pkg,
      "OrdersIT",
      ["@SpringBootTest", "class {name} {", "  @Test void contextLoads() {}", "}"].join("\n"),
      ["org.junit.jupiter.api.Test", "org.springframework.boot.test.context.SpringBootTest"],
    ),
    [`${dir}/TestData.java`]: `package ${pkg};\n\nclass TestData { static final String ID = "1"; }\n`,
    [`${dir}/Helper.java`]: `package ${pkg};\n\nclass Helper { @org.junit.jupiter.api.Test void notRunBySurefire() {} }\n`,
    "contracts/orders.openapi.yaml": "openapi: 3.0.3\n",
  });
}

/** A Maven reactor with two modules, a standalone build next to it, and a test-fixture POM. */
export function mavenReactorRepo(): MemoryRepository {
  return new MemoryRepository({
    "pom.xml": `<project>
  <groupId>com.acme</groupId>
  <artifactId>parent</artifactId>
  <version>1.0</version>
  <packaging>pom</packaging>
  <properties><junit.version>5.10.2</junit.version><maven.compiler.release>17</maven.compiler.release></properties>
  <modules>
    <module>app</module>
    <module>lib</module>
  </modules>
</project>
`,
    "app/pom.xml": `<project>
  <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
  <artifactId>app</artifactId>
  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>\${junit.version}</version><scope>test</scope></dependency>
  </dependencies>
</project>
`,
    "lib/pom.xml": "<project><artifactId>lib</artifactId></project>\n",
    "app/src/main/java/com/acme/App.java": "package com.acme;\nclass App {}\n",
    "app/src/test/java/com/acme/AppTest.java":
      "package com.acme;\nimport org.junit.jupiter.api.Test;\nclass AppTest { @Test void works() {} }\n",
    "app/src/test/resources/fixture/pom.xml":
      "<project><artifactId>fixture</artifactId></project>\n",
    "tools/standalone/pom.xml": "<project><artifactId>standalone</artifactId></project>\n",
  });
}

/** A Gradle multi-project build (Kotlin DSL) with a version catalog. */
export function gradleRepo(): MemoryRepository {
  return new MemoryRepository({
    "settings.gradle.kts": [
      'rootProject.name = "shop"',
      'include("app", "lib:core")',
      '// include("ignored")',
      "",
    ].join("\n"),
    "build.gradle.kts": "// root build\n",
    "app/build.gradle.kts": [
      "plugins {",
      "    java",
      "    checkstyle",
      "    jacoco",
      "    alias(libs.plugins.spring.boot)",
      '    id("com.google.protobuf") version "0.9.4"',
      "}",
      "",
      "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }",
      "",
      "dependencies {",
      '    implementation("org.springframework.boot:spring-boot-starter-web")',
      "    testImplementation(libs.junit.jupiter)",
      '    testImplementation("org.mockito:mockito-core:5.12.0")',
      "}",
      "",
      "tasks.test { useJUnitPlatform() }",
      "",
    ].join("\n"),
    "lib/core/build.gradle.kts": "plugins {\n    `java-library`\n}\n",
    "gradle/libs.versions.toml": [
      "[versions]",
      'spring-boot = "3.3.4"',
      'junit = "5.10.3"',
      "",
      "[libraries]",
      'junit-jupiter = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }',
      "",
      "[plugins]",
      'spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }',
      "",
    ].join("\n"),
    gradlew: "#!/bin/sh\n",
    "gradlew.bat": "@echo off\n",
    "gradle/wrapper/gradle-wrapper.properties":
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip\n",
    "app/src/main/java/com/shop/App.java": "package com.shop;\nclass App {}\n",
    "app/src/main/proto/shop.proto": 'syntax = "proto3";\n',
    "app/src/test/java/com/shop/AppTest.java":
      "package com.shop;\nimport org.junit.jupiter.api.Test;\nclass AppTest { @Test void ac3_startsUp() {} }\n",
    "app/src/integrationTest/java/com/shop/CheckoutFlow.java":
      "package com.shop;\nimport org.junit.jupiter.api.Test;\nclass CheckoutFlow { @Test void checksOut() {} }\n",
    "lib/core/src/main/java/com/shop/core/Money.java": "package com.shop.core;\nclass Money {}\n",
    "lib/core/src/test/java/com/shop/core/MoneyTests.java":
      "package com.shop.core;\nimport org.junit.jupiter.api.Test;\nclass MoneyTests { @Test void adds() {} }\n",
  });
}

/** A single-project Gradle build in the Groovy DSL, without settings file or wrapper. */
export function legacyGradleRepo(): MemoryRepository {
  return new MemoryRepository({
    "legacy/build.gradle": [
      "apply plugin: 'java'",
      "sourceCompatibility = 1.8",
      "dependencies {",
      "    testImplementation 'junit:junit:4.13.2'",
      "}",
      "",
    ].join("\n"),
    "legacy/src/main/java/Legacy.java": "class Legacy {}\n",
    "legacy/src/test/java/LegacyTest.java":
      "import org.junit.Test;\npublic class LegacyTest { @Test public void ac1_works() {} }\n",
  });
}
