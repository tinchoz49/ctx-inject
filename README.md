# ctx-inject

Strongly-typed, chainable dependency injection context builder for TypeScript.

Inspired by [Elysia.js](https://elysiajs.com/)'s type accumulation pattern, each `.use()` call accumulates types via intersection, giving full type inference on the final context.

## Install

```sh
bun install ctx-inject
```

## Quick Start

```ts
import { z } from 'zod';
import { createContext, plugin } from 'ctx-inject';

const logger = plugin({
  name: 'logger',
  build() {
    return { logger: console };
  },
});

const db = plugin({
  name: 'db',
  dependencies: [logger],
  options: z.object({ url: z.string() }),
  build(ctx, options) {
    ctx.logger.log('Building db for', options.url);
    return { db: createConnection(options.url) };
  },
  async init({ db }) {
    await db.connect();
  },
  async dispose({ db }) {
    await db.close();
  },
});

const ctx = createContext()
  .use(logger)
  .use(db, { url: 'postgres://localhost/mydb' })
  .build(); // synchronously runs each plugin's build()

await ctx.init(); // runs each plugin's init() in order

ctx.logger; // Console - fully typed
ctx.db;     // connection - fully typed

await ctx.close(); // disposes in reverse order
```

## Features

- **Full type inference** - Every `.use()` call accumulates types. The final context is fully typed with no manual annotations needed.
- **Chainable API** - Fluent builder pattern: `createContext().use(a).use(b).build()`
- **Synchronous build** - `.build()` synchronously runs each plugin's `build()` method, resolving dependencies and decorating the context. Call `ctx.init()` to run async initialization.
- **Plugin dependencies** - Plugins declare dependencies as a contract. TypeScript enforces that all dependencies are registered before the dependent plugin.
- **Plugin options** - Plugins can declare a Zod schema for typed, validated configuration options.
- **Sync build, async init** - `build` is synchronous for creating objects and decorating the context. Optional `init` is async for loading resources (e.g. connecting to databases).
- **Lifecycle management** - Optional `dispose` handlers (opposite of `init`) are called in reverse initialization order on `ctx.close()`.
- **Graceful error handling** - If a plugin fails during build, a `PluginBuildError` is thrown. If a plugin fails during init, all already-initialized plugins are disposed before the error propagates.
- **Frozen context** - The context is `Object.freeze()`'d after `init()`. The `init()` and `close()` methods are non-enumerable.
- **Reserved keys** - `init` and `close` are reserved context methods. Plugins that try to add these keys will throw a `ReservedKeyError`.
- **Zod validation** - Options are validated at build time via Zod schemas, with full type inference.

## API

### `plugin(config)`

Creates a plugin definition.

```ts
import { z } from 'zod';

// Plugin without options
const greeter = plugin({
  name: 'greeter',
  build() {
    return { greet: (name: string) => `Hello, ${name}!` };
  },
});

// Plugin with dependencies and options (Zod schema)
const mailer = plugin({
  name: 'mailer',
  dependencies: [logger],
  options: z.object({ apiKey: z.string() }),
  build(ctx, options) {
    // options is { apiKey: string } — inferred from the Zod schema
    ctx.logger.log('Mailer created');
    return {
      mailer: createMailer(options.apiKey),
    };
  },
  async init({ mailer }) {
    await mailer.verify(); // async initialization
  },
  dispose({ mailer }) {
    // cleanup if needed
  },
});
```

**Config fields:**

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique plugin identifier |
| `dependencies` | No | Array of plugins this plugin depends on. Acts as a type-level contract — all must be registered via `.use()` before this plugin. |
| `options` | No | Zod schema for plugin options. When provided, `.use()` requires a matching options argument and the value is validated at build time. |
| `build(ctx, options?)` | Yes | Synchronous. Receives resolved dependency context (and validated options if `options` schema is declared). Returns an object of values to add to the context. Called during `.build()`. |
| `init(decorations)` | No | Async initialization handler. Receives the object returned by `build`. Use for loading async resources (connecting to databases, reading files, etc.). Called during `ctx.init()`. |
| `dispose(decorations)` | No | Teardown handler (opposite of `init`). Receives the object returned by `build`. Can be async. |

### `createContext()`

Returns a `ContextBuilder` instance.

### `ContextBuilder`

#### `.use(plugin)` / `.use(plugin, options)`

Registers a plugin. Returns the builder for chaining.

All dependencies declared by the plugin must be registered (via prior `.use()` calls) before this plugin — enforced at the type level. If the plugin declares an `options` Zod schema, a matching options argument is required.

#### `.build(): Context<T>`

Synchronously runs each plugin's `build()` method in registration order, validating dependencies, parsing options, checking for key collisions, and assigning decorations to the context. Returns the context object with `init()` and `close()` methods (non-enumerable).

#### `ctx.init(): Promise<void>`

Runs each plugin's `init()` handler in registration order and freezes the context. Multiple calls return the same promise — initialization only runs once.

#### `ctx.close(): Promise<void>`

Calls `dispose` on all plugins in reverse initialization order. Multiple calls return the same promise — disposal only runs once.

## Dependencies

Dependencies are declared as a contract — TypeScript enforces that all dependencies are registered before the dependent plugin:

```ts
const a = plugin({ name: 'a', build: () => ({ a: 1 }) });
const b = plugin({ name: 'b', dependencies: [a], build: (ctx) => ({ b: ctx.a + 1 }) });
const c = plugin({ name: 'c', dependencies: [b], build: (ctx) => ({ c: ctx.a + ctx.b }) });

// All plugins must be explicitly registered in order
const ctx = createContext().use(a).use(b).use(c).build();
await ctx.init();
ctx.a // 1
ctx.b // 2
ctx.c // 3

// This would be a type error — b's dependency (a) is not registered:
// createContext().use(b).build();
```

Duplicate registrations are skipped (build is only called once per plugin).

## Error Handling

### `PluginBuildError`

Thrown during `.build()` if a plugin's build function throws.

```ts
import { PluginBuildError } from 'ctx-inject';

try {
  const ctx = createContext().use(flakyPlugin).build();
} catch (err) {
  if (err instanceof PluginBuildError) {
    console.log(err.pluginName); // 'flaky'
    console.log(err.cause);      // original error
  }
}
```

### `PluginInitError`

Thrown during `ctx.init()` if a plugin's `init` function throws. All already-initialized plugins are disposed before the error propagates.

```ts
import { PluginInitError } from 'ctx-inject';

const ctx = createContext().use(flakyPlugin).build();
try {
  await ctx.init();
} catch (err) {
  if (err instanceof PluginInitError) {
    console.log(err.pluginName); // 'flaky'
    console.log(err.cause);      // original error
  }
}
```

### `ReservedKeyError`

Thrown during `.build()` if a plugin tries to add a key that is a reserved context method (`init` or `close`).

```ts
import { ReservedKeyError } from 'ctx-inject';

const bad = plugin({
  name: 'bad',
  build: () => ({ init: () => {} }), // "init" is reserved
});

try {
  const ctx = createContext().use(bad).build();
} catch (err) {
  if (err instanceof ReservedKeyError) {
    console.log(err.pluginName); // 'bad'
    console.log(err.key);        // 'init'
  }
}
```

## Development

```sh
bun install
bun test              # run tests
bun run typecheck     # type checking
bun run lint          # lint with oxlint
bun run format        # format with oxfmt
bun run check         # all of the above
```

## License

MIT
