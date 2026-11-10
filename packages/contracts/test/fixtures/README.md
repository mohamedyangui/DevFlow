# Contract fixtures

Base and head versions of contracts, made up for the tests, and recorded tool output.

- `openapi/petstore.base.yaml` and `openapi/petstore.head.json`: an OpenAPI 3.0 document in
  YAML and its changed version in JSON. The head removes an operation, renames a path
  variable, adds operations and parameters, and changes shared schemas reached through
  `$ref`s (including a reference cycle, `Pet` -> `Owner` -> `Pet`).
- `protobuf/orders.base.proto` and `protobuf/orders.head.proto`: a proto3 file and its changed
  version, with nested types, a map, a oneof, `optional`, reservations, enums and services.
- `tools/oasdiff-breaking.json`: output in the shape of `oasdiff breaking --format json`
  (a JSON array of `id`, `text`, `level`, `operation`, `path`, ...).
- `tools/buf-breaking.jsonl`: output in the shape of `buf breaking --error-format json`
  (one JSON object per line: `path`, `start_line`, `type`, `message`, ...).

The tool outputs were written by hand from the tools' documented formats: oasdiff and buf are
not installed where these tests run, so they were not produced by running the tools.
