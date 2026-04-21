# Contributing to lacelang-executor (TypeScript)

The reference TypeScript executor for [Lace](https://github.com/tracedown/lacelang)
is an open-source project under the Apache License 2.0. Contributions are
welcome — bug fixes, new features, test coverage, and documentation.

## Relationship to the spec

This executor implements the Lace specification defined in the
[lacelang](https://github.com/tracedown/lacelang) repository. The spec
is the source of truth. If the executor's behaviour diverges from the
spec, that is a bug in the executor — not in the spec.

Changes that require spec modifications (new syntax, new result fields,
changed semantics) must be proposed upstream in the spec repo first.

## Conventions

- **Naming**: camelCase for wire-format fields (matching the spec),
  camelCase for internal TypeScript identifiers.
- **No purely stylistic changes**: refactoring whitespace, rewording
  comments, or reformatting code without a functional reason will not
  be accepted.
- **Tests required**: every behaviour change must include tests. Unit
  tests run without network access; integration tests are gated behind
  `NETWORK=1`.
- **Semicolons required**, 2-space indent, no `any` unless structurally
  necessary (mark with `eslint-disable`).

## How to contribute

1. **Open an issue** if you want feedback before implementing. This is
   optional — you can also go straight to a PR.
2. **Open a PR** with the proposed changes. Include:
   - The code change
   - Unit tests (in `src/tests/`) and/or integration tests
   - Updated README if the public API changes
3. Run the test suite before submitting:
   ```bash
   npm test                    # offline tests
   npm run test:network        # full suite including HTTP integration
   ```
4. Discussion happens in PR comments. A maintainer must approve before
   merge.

## Test suite

| Suite | Command | Network | Covers |
|-------|---------|---------|--------|
| Unit | `npm test` | No | Expression eval, interpolation, config, schema, API |
| Integration | `npm run test:network` | Yes | Full HTTP execution against httpbin.org |

## Version

This package tracks the spec version via `__ast_version__` in
`src/index.ts`. The package version is independent and follows its own
release cadence. Only bump `__ast_version__` when updating to conform
to a new spec version.

## License

By contributing, you agree that your contributions will be licensed
under the Apache License 2.0, the same license as the project.
