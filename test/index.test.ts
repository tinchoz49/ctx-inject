import { test, expect, describe, mock } from 'bun:test';
import { z } from 'zod';
import { createContext, plugin, PluginSetupError } from '../src';

// ─── 1. Simple plugin (no deps, sync) ────────────────────────────────────────

describe('simple plugin', () => {
  test('registers and returns decorations', async () => {
    const greeter = plugin({
      name: 'greeter',
      setup() {
        return { greet: (name: string) => `Hello, ${name}!` };
      },
    });

    const ctx = await createContext().use(greeter).build();

    expect(ctx.greet('World')).toBe('Hello, World!');
  });
});

// ─── 2. Async plugin setup ───────────────────────────────────────────────────

describe('async plugin', () => {
  test('awaits async setup', async () => {
    const asyncPlugin = plugin({
      name: 'async',
      async setup() {
        await new Promise((r) => setTimeout(r, 10));
        return { value: 42 };
      },
    });

    const ctx = await createContext().use(asyncPlugin).build();

    expect(ctx.value).toBe(42);
  });
});

// ─── 3. Plugin with dependencies — type inference ────────────────────────────

describe('plugin with dependencies', () => {
  test('receives dependency context in setup', async () => {
    const loggerPlugin = plugin({
      name: 'logger',
      setup() {
        return { logger: { log: (...args: unknown[]) => args } };
      },
    });

    const servicePlugin = plugin({
      name: 'service',
      dependencies: [loggerPlugin],
      setup(ctx) {
        // ctx.logger should be available
        const result = ctx.logger.log('init');
        return { service: { result } };
      },
    });

    const ctx = await createContext().use(loggerPlugin).use(servicePlugin).build();

    expect(ctx.service.result).toEqual(['init']);
    expect(ctx.logger.log('test')).toEqual(['test']);
  });
});

// ─── 4. Transitive dependencies ──────────────────────────────────────────────

describe('transitive dependencies', () => {
  test('all dependencies must be explicitly registered in order', async () => {
    const a = plugin({
      name: 'a',
      setup() {
        return { a: 1 };
      },
    });

    const b = plugin({
      name: 'b',
      dependencies: [a],
      setup(ctx) {
        return { b: ctx.a + 1 };
      },
    });

    const c = plugin({
      name: 'c',
      dependencies: [b],
      setup(ctx) {
        return { c: ctx.a + ctx.b };
      },
    });

    const ctx = await createContext().use(a).use(b).use(c).build();

    expect(ctx.a).toBe(1);
    expect(ctx.b).toBe(2);
    expect(ctx.c).toBe(3);
  });
});

// ─── 5. Duplicate plugin skipped ─────────────────────────────────────────────

describe('duplicate plugin', () => {
  test('setup is called only once', async () => {
    const setupFn = mock(() => ({ val: 'once' }));

    const p = plugin({
      name: 'once',
      setup: setupFn,
    });

    const ctx = await createContext().use(p).use(p).build();

    expect(setupFn).toHaveBeenCalledTimes(1);
    expect(ctx.val).toBe('once');
  });
});

// ─── 6. Missing dependency detection ─────────────────────────────────────────

describe('missing dependency', () => {
  test('throws when dependency is not registered', async () => {
    const a = plugin({
      name: 'a',
      setup: () => ({ a: 1 }),
    });

    const b = plugin({
      name: 'b',
      dependencies: [a],
      setup: () => ({ b: 2 }),
    });

    // Cast to bypass type constraint — runtime should still catch it
    await expect((createContext() as any).use(b).build()).rejects.toThrow(
      /requires "a" to be registered before it/,
    );
  });
});

// ─── 7. Dispose in reverse order + double-close no-op ────────────────────────

describe('dispose', () => {
  test('calls dispose in reverse initialization order', async () => {
    const order: string[] = [];

    const first = plugin({
      name: 'first',
      setup: () => ({ first: true }),
      dispose: () => {
        order.push('first');
      },
    });

    const second = plugin({
      name: 'second',
      dependencies: [first],
      setup: () => ({ second: true }),
      dispose: () => {
        order.push('second');
      },
    });

    const third = plugin({
      name: 'third',
      dependencies: [second],
      setup: () => ({ third: true }),
      dispose: () => {
        order.push('third');
      },
    });

    const ctx = await createContext().use(first).use(second).use(third).build();

    await ctx.close();
    expect(order).toEqual(['third', 'second', 'first']);

    // Double close should be a no-op
    await ctx.close();
    expect(order).toEqual(['third', 'second', 'first']);
  });

  test('close is non-enumerable', async () => {
    const p = plugin({
      name: 'p',
      setup: () => ({ x: 1 }),
    });

    const ctx = await createContext().use(p).build();

    expect(Object.keys(ctx)).toEqual(['x']);
    expect(typeof ctx.close).toBe('function');
  });
});

// ─── 8. Plugin with options (Zod schema) ────────────────────────────────────

describe('plugin with options', () => {
  test('passes validated options to setup', async () => {
    const configPlugin = plugin({
      name: 'config',
      options: z.object({ port: z.number(), host: z.string() }),
      setup(_ctx, options) {
        return { config: { port: options.port, host: options.host } };
      },
    });

    const ctx = await createContext().use(configPlugin, { port: 3000, host: 'localhost' }).build();

    expect(ctx.config.port).toBe(3000);
    expect(ctx.config.host).toBe('localhost');
  });

  test('throws on invalid options', async () => {
    const configPlugin = plugin({
      name: 'config',
      options: z.object({ port: z.number(), host: z.string() }),
      setup(_ctx, options) {
        return { config: options };
      },
    });

    await expect(
      createContext()
        .use(configPlugin, { port: 'not-a-number', host: 123 } as any)
        .build(),
    ).rejects.toThrow();
  });
});

// ─── 9. Error during setup triggers cleanup ──────────────────────────────────

describe('setup error cleanup', () => {
  test('disposes already-initialized plugins on failure', async () => {
    const disposed: string[] = [];

    const good = plugin({
      name: 'good',
      setup: () => ({ good: true }),
      dispose: () => {
        disposed.push('good');
      },
    });

    const bad = plugin({
      name: 'bad',
      dependencies: [good],
      setup: (): Record<string, unknown> => {
        throw new Error('boom');
      },
    });

    await expect(createContext().use(good).use(bad).build()).rejects.toThrow(PluginSetupError);

    expect(disposed).toEqual(['good']);
  });

  test('PluginSetupError contains plugin name and cause', async () => {
    const failing = plugin({
      name: 'failing',
      setup: (): Record<string, unknown> => {
        throw new Error('original');
      },
    });

    try {
      await createContext().use(failing).build();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PluginSetupError);
      expect((err as PluginSetupError).pluginName).toBe('failing');
      expect((err as PluginSetupError).cause).toBeInstanceOf(Error);
    }
  });
});

// ─── 10. Type-level tests ────────────────────────────────────────────────────

describe('type-level correctness', () => {
  test('context is readonly (frozen)', async () => {
    const p = plugin({
      name: 'p',
      setup: () => ({ val: 'hello' }),
    });

    const ctx = await createContext().use(p).build();

    // Runtime freeze check
    expect(() => {
      (ctx as any).val = 'changed';
    }).toThrow();

    expect(ctx.val).toBe('hello');
  });

  test('key collision throws', async () => {
    const a = plugin({
      name: 'a',
      setup: () => ({ shared: 1 }),
    });

    const b = plugin({
      name: 'b',
      setup: () => ({ shared: 2 }),
    });

    await expect(createContext().use(a).use(b).build()).rejects.toThrow(/already exists/);
  });

  test('compile-time type inference works', async () => {
    const loggerPlugin = plugin({
      name: 'logger',
      setup() {
        return { logger: console };
      },
    });

    const dbPlugin = plugin({
      name: 'db',
      dependencies: [loggerPlugin],
      options: z.object({ url: z.string() }),
      async setup(ctx, options) {
        ctx.logger.log('Connecting to', options.url);
        const db = {
          query: async (sql: string) => sql,
          close: async () => {},
        };
        return { db };
      },
      async dispose({ db }) {
        await db.close();
      },
    });

    const ctx = await createContext()
      .use(loggerPlugin)
      .use(dbPlugin, { url: 'postgres://localhost' })
      .build();

    // These lines verify type inference at compile time
    const _logger: Console = ctx.logger;
    const _query: (sql: string) => Promise<string> = ctx.db.query;

    expect(_logger).toBe(console);
    expect(typeof _query).toBe('function');

    await ctx.close();
  });
});
