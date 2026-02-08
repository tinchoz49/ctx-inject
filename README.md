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
  setup() {
    return { logger: console };
  },
});

const db = plugin({
  name: 'db',
  dependencies: [logger],
  options: z.object({ url: z.string() }),
  async setup(ctx, options) {
    ctx.logger.log('Connecting to', options.url);
    const connection = await connect(options.url);
    return { db: connection };
  },
  async dispose({ db }) {
    await db.close();
  },
});

const ctx = await createContext()
  .use(logger)
  .use(db, { url: 'postgres://localhost/mydb' })
  .ready();

ctx.logger; // Console - fully typed
ctx.db;     // connection - fully typed

await ctx.close(); // disposes in reverse order
```

## Features

- **Full type inference** - Every `.use()` call accumulates types. The final context is fully typed with no manual annotations needed.
- **Chainable API** - Fluent builder pattern: `createContext().use(a).use(b).ready()`
- **Plugin dependencies** - Plugins declare dependencies as a contract. TypeScript enforces that all dependencies are registered before the dependent plugin.
- **Plugin options** - Plugins can declare a Zod schema for typed, validated configuration options.
- **Lifecycle management** - Optional `dispose` handlers are called in reverse initialization order on `ctx.close()`.
- **Graceful error handling** - If a plugin fails during setup, all already-initialized plugins are disposed before the error propagates.
- **Frozen context** - The built context is `Object.freeze()`'d. The `close()` method is non-enumerable.
- **Zod validation** - Options are validated at runtime via Zod schemas, with full type inference.

## API

### `plugin(config)`

Creates a plugin definition.

```ts
import { z } from 'zod';

// Plugin without options
const greeter = plugin({
  name: 'greeter',
  setup() {
    return { greet: (name: string) => `Hello, ${name}!` };
  },
});

// Plugin with dependencies and options (Zod schema)
const mailer = plugin({
  name: 'mailer',
  dependencies: [logger],
  options: z.object({ apiKey: z.string() }),
  setup(ctx, options) {
    // options is { apiKey: string } — inferred from the Zod schema
    ctx.logger.log('Mailer initialized');
    return {
      sendMail: (to: string, body: string) => { /* ... */ },
    };
  },
  dispose({ sendMail }) {
    // cleanup if needed
  },
});
```

**Config fields:**

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique plugin identifier |
| `dependencies` | No | Array of plugins this plugin depends on. Acts as a type-level contract — all must be registered via `.use()` before this plugin. |
| `options` | No | Zod schema for plugin options. When provided, `.use()` requires a matching options argument and the value is validated at initialization time. |
| `setup(ctx, options?)` | Yes | Receives resolved dependency context (and validated options if `options` schema is declared). Returns an object of values to add to the context. Can be async. |
| `dispose(decorations)` | No | Teardown handler. Receives the object returned by `setup`. Can be async. |

### `createContext()`

Returns a `ContextBuilder` instance.

### `ContextBuilder`

#### `.use(plugin)` / `.use(plugin, options)`

Registers a plugin. Returns the builder for chaining.

All dependencies declared by the plugin must be registered (via prior `.use()` calls) before this plugin — enforced at the type level. If the plugin declares an `options` Zod schema, a matching options argument is required.

#### `.ready(): Promise<Context<T>>`

Initializes all registered plugins in registration order and returns a frozen context object. Multiple calls return the same promise — initialization only runs once.

The context includes all values returned by plugin `setup` functions, plus a non-enumerable `close()` method.

#### `ctx.close(): Promise<void>`

Calls `dispose` on all plugins in reverse initialization order. Multiple calls return the same promise — disposal only runs once.

## Dependencies

Dependencies are declared as a contract — TypeScript enforces that all dependencies are registered before the dependent plugin:

```ts
const a = plugin({ name: 'a', setup: () => ({ a: 1 }) });
const b = plugin({ name: 'b', dependencies: [a], setup: (ctx) => ({ b: ctx.a + 1 }) });
const c = plugin({ name: 'c', dependencies: [b], setup: (ctx) => ({ c: ctx.a + ctx.b }) });

// All plugins must be explicitly registered in order
const ctx = await createContext().use(a).use(b).use(c).ready();
ctx.a // 1
ctx.b // 2
ctx.c // 3

// This would be a type error — b's dependency (a) is not registered:
// createContext().use(b).ready();
```

Duplicate registrations are skipped (setup is only called once per plugin).

## Error Handling

### `PluginSetupError`

Thrown during `.ready()` if a plugin's setup function throws. All already-initialized plugins are disposed before the error propagates.

```ts
import { PluginSetupError } from 'ctx-inject';

try {
  await createContext().use(flakyPlugin).ready();
} catch (err) {
  if (err instanceof PluginSetupError) {
    console.log(err.pluginName); // 'flaky'
    console.log(err.cause);      // original error
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
