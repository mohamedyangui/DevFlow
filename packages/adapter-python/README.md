# @devflowai/adapter-python

The Python language adapter: it recognizes uv, Poetry, Pipenv, pip and plain Python projects,
describes what they use with evidence, lists their tests, provides the commands that test,
lint and type-check them, and reads the output and reports those commands write. It
implements the `LanguageAdapter` port of `@devflowai/core`
([docs/specs/language-adapter.md](../../docs/specs/language-adapter.md), section 11).

The adapter only reads files through `RepositoryView` and returns data. It never imports,
runs or installs anything to learn about a project: `pyproject.toml` is parsed as TOML,
`setup.cfg`, `tox.ini` and `mypy.ini` as INI, and `setup.py` and requirements files are read
as text. ESLint forbids it from importing `node:child_process`, `node:fs` or network modules.
Its dependencies are `@devflowai/core` and `fast-xml-parser` (for pytest's JUnit XML).

```ts
import { pythonAdapter } from "@devflowai/adapter-python";
registry.register(pythonAdapter);
```

## What it detects

| Concern         | Detected from                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module          | `pyproject.toml` (`[project]`, `[tool.poetry]`, `[build-system]`), `setup.cfg`, `setup.py`, `Pipfile`, `uv.lock`, `poetry.lock`, requirements files |
| Build tool      | `uv.lock` or `[tool.uv]` (uv), `poetry.lock` or `[tool.poetry]` (Poetry), `Pipfile` (Pipenv), requirements files, `setup.py` or `setup.cfg` (pip)   |
| Language        | Python, with the version from `.python-version`, `requires-python` or the virtual environment                                                       |
| Frameworks      | Django, Flask, FastAPI                                                                                                                              |
| Test frameworks | pytest, unittest (`unittest.TestCase` subclasses)                                                                                                   |
| Quality tools   | Ruff, flake8, mypy, Pyright                                                                                                                         |

A tool counts when the module declares it as a dependency (confidence 0.95), configures it
(a configuration file or a `[tool.<name>]` table, 0.9), or only imports it (0.8). The version
is that of the package installed in the project's `.venv` or `venv` (`*.dist-info`); a
declared range such as `>=8` is shown in the evidence, never reported as the version. A
repository with Python files but no project file is one plain module (confidence 0.6).
Virtual environments, `__pycache__`, `.tox` and `.nox` are never walked.

## Tests and conventions

- **Inventory.** `test_*.py` and `*_test.py` that define a test function or a `TestCase`.
  Levels: `e2e` for `e2e/`, `*_e2e.py` and Playwright or Selenium imports; `integration` for
  `integration/`, `*_integration.py`, Testcontainers, `pytest.mark.integration` and Django's
  `LiveServerTestCase`; otherwise `unit`.
- **Conventions**, each reported only when at least 60% of at least two files follow it:
  `test_` prefix or `_test` suffix, a `tests/` directory or tests next to the code, plain
  functions, test classes or `unittest.TestCase`, and `test_acN_` name markers.
- **Authoring guide.** The acceptance criterion marker is a name prefix,
  `def test_ac1_returns_the_second_page() -> None: ...`. Test names reach the JUnit XML report
  and unittest's verbose output, which is how DevFlow links results to criteria.

## Commands

Every command runs the interpreter with `-m <tool>`, never a console script or a package
manager. The interpreter is the project's `.venv` (or `venv`) when it has a `pyvenv.cfg`
(`./.venv/bin/python`, or `./.venv/Scripts/python.exe` on Windows; the command policy binds
`pyvenv.cfg` into the approval fingerprint), otherwise the first of `python`, `py -3` and
`python3` on PATH on Windows, or `python3` and `python` elsewhere.

| Command       | Tool     | Arguments                                                                                  | Parser             |
| ------------- | -------- | ------------------------------------------------------------------------------------------ | ------------------ |
| `test`        | pytest   | `-m pytest -q --junitxml=.pytest_cache/devflow-<module>-junit.xml`                         | `pytest-junit-xml` |
| `test`        | unittest | `-m unittest discover -v [-s <tests> -t .]`                                                | `unittest-text`    |
| `test-filter` | either   | the same, plus `-k {testExpression}` (pytest) or `-k {testPattern}` (unittest)             | as `test`          |
| `lint`        | Ruff     | `-m ruff check --no-fix --output-format json .`                                            | `ruff-json`        |
| `lint`        | flake8   | `-m flake8 --format=default --extend-exclude .venv,venv,.tox,.nox,node_modules .`          | `flake8-text`      |
| `typecheck`   | mypy     | `-m mypy --no-color-output --show-column-numbers --show-error-codes --no-pretty [<roots>]` | `mypy-text`        |

- A module gets a command only for a tool it declares or configures. Ruff is preferred to
  flake8. mypy gets the source roots unless its configuration names `files`.
- Commands run in the module root with `PYTHONDONTWRITEBYTECODE=1`, `PYTHONIOENCODING=utf-8`
  and `NO_COLOR=1`, and need no network. Nothing is ever installed: when a tool is missing from
  the environment, its gate fails or is `unparseable`, with the tool's own output in the log.
- The command policy allows `python -m` only for `pytest`, `unittest`, `mypy`, `ruff` and
  `flake8`, and denies `-c`, `-` and Python package managers (`pip`, `uv`, `poetry`, `pipx`,
  `uvx`, ...).

## Results

- `pytest-junit-xml`: only a report written by this execution is read. Exit codes 3 and 4
  (internal or usage error) and a missing report are `unparseable`.
- `unittest-text`: the verbose per-test lines, checked against the `Ran N tests` count; a
  mismatch is `unparseable`.
- `ruff-json`, `flake8-text` and `mypy-text` become diagnostics with locations relative to the
  repository. A tool exit code above 1 without parseable output is `unparseable`.

The unittest and mypy parsers are tested with real output captured from Python 3.10 and mypy
0.931, and the `python-unittest` example runs for real in `pnpm test:examples`. pytest was not
available where the adapter was built: the pytest JUnit XML fixture is written by hand, and the
`python-pytest` example is skipped, with the reason, until pytest is installed.
