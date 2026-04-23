# lacelang-executor (TypeScript)

Reference TypeScript executor for [Lace](https://github.com/tracedown/lacelang) --
the reference implementation with **100% spec conformance** (v0.9.1, 171/171
conformance vectors). Runs `.lace` scripts against real HTTP endpoints and
emits ProbeResult JSON.

Parsing and semantic validation are delegated to
[`@lacelang/validator`](https://github.com/tracedown/lacelang-js-validator) -- this
package contains only the runtime (HTTP client, assertion evaluation, cookie jars,
extension dispatch). See `lace-spec.md` section 15 for the validator / executor package
separation rule.

## Install

```bash
npm install @lacelang/executor
```

This automatically installs `@lacelang/validator` as a dependency.

Or from source:

```bash
npm install git+https://github.com/tracedown/lacelang-js-executor.git
```

## CLI

```bash
# Parse (delegates to validator)
lacelang-executor parse script.lace

# Validate (delegates to validator)
lacelang-executor validate script.lace --vars-list vars.json

# Run -- full HTTP execution
lacelang-executor run script.lace \
    --vars vars.json \
    --prev prev.json

# Enable extensions
lacelang-executor run script.lace --enable-extension laceNotifications
```

All subcommands support `--pretty` for indented JSON.

## Library

```typescript
import { LaceExecutor } from "@lacelang/executor";

// Point to the lace/ directory -- config loaded once
const executor = new LaceExecutor("lace");

// Prepare a probe by name -- resolves to lace/scripts/health/health.lace
// AST is parsed and validated once, reused across runs
const probe = executor.probe("health");

// Run -- returns a ProbeResult dict
const result = await probe.run({ base_url: "https://api.example.com" });

// Run again -- prev result from last run injected automatically
const result2 = await probe.run();

// One-shot execution (no probe caching, no prev tracking)
const result3 = await executor.run('get("https://example.com").expect(status: 200)');
```

### Project layout

```
my-project/
  lace/
    lace.config                      # executor config (auto-discovered)
    extensions/                      # third-party extensions
    scripts/
      health/
        health.lace                  # script (name = directory name)
        vars.json                    # default variables
```

### Configuration

```toml
# lace/lace.config

[executor]
maxRedirects = 10
maxTimeoutMs = 300000

# Staging overlay -- deep-merged on top of base
[lace.config.staging]
[lace.config.staging.executor]
maxTimeoutMs = 60000
```

```typescript
const executor = new LaceExecutor("lace", { env: "staging" });
```

### Extensions

Built-in extensions (`laceNotifications`, `laceBaseline`) are bundled and
activated via config or constructor:

```typescript
// Via constructor
const executor = new LaceExecutor("lace", {
  extensions: ["laceNotifications"],
});

// Via lace.config
// [executor]
// extensions = ["laceNotifications"]
```

Register third-party extensions:

```typescript
// Directory (finds myext.laceext + myext.config inside)
executor.extension("lace/extensions/myext");

// Explicit paths
executor.extension("path/to/custom.laceext", "path/to/custom.config");
```

### Low-level API

The stateless `runScript()` function is available for callers that need
full control over parsing, validation, and config:

```typescript
import { parse } from "@lacelang/validator";
import { runScript, loadConfig } from "@lacelang/executor";
import * as fs from "node:fs";

const ast = parse(fs.readFileSync("script.lace", "utf-8"));
const config = loadConfig({ explicitPath: "lace.config" });

const result = await runScript(ast, { key: "val" }, null, null, null, null, null, config);
```

## Responsible use

This software is designed for monitoring endpoints you **own or have
explicit authorization to probe**. See `NOTICE` for the full statement.

## License

Apache License 2.0
