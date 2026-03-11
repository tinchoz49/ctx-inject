import { test, expect, describe, mock } from 'bun:test';
import { z } from 'zod';
import { createContext, plugin, DuplicatePluginError, PluginBuildError, PluginInitError, ReservedKeyError } from '../src';

// ─── 1. Simple plugin (no deps, sync) ────────────────────────────────────────

describe('simple plugin', () => {
  test('registers and returns decorations', async () => {
    const greeter = plugin({
      name: 'greeter',
      build() {
        return { greet: (name: string) => `Hello, ${name}!` };
      },
    });

    const ctx = createContext().use(greeter).build();
    await ctx.init();

    expect(ctx.greet('World')).toBe('Hello, World!');
  });
});

// ─── 2. Plugin with init (async lifecycle) ──────────────────────────────────

describe('plugin with init', () => {
  test('init is called after build with decorations', async () => {
    const initOrder: string[] = [];

    const asyncPlugin = plugin({
      name: 'async',
      build() {
        initOrder.push('build');
        return { state: { value: 0 } };
      },
      async init(decorations) {
        await new Promise((r) => setTimeout(r, 10));
        initOrder.push('init');
        // Mutate the object created in build
        decorations.state.value = 42;
      },
    });

    const ctx = createContext().use(asyncPlugin).build();
    await ctx.init();

    expect(initOrder).toEqual(['build', 'init']);
    expect(ctx.state.value).toBe(42);
  });

  test('build runs for all plugins synchronously, init runs sequentially', async () => {
    const order: string[] = [];

    const first = plugin({
      name: 'first',
      build() {
        order.push('first:build');
        return { first: { loaded: false } };
      },
      async init(decorations) {
        await new Promise((r) => setTimeout(r, 10));
        decorations.first.loaded = true;
        order.push('first:init');
      },
    });

    const second = plugin({
      name: 'second',
      dependencies: [first],
      build(ctx) {
        order.push('second:build');
        // first's build has run but init hasn't yet
        return { secondSawFirstLoaded: ctx.first.loaded };
      },
      async init() {
        order.push('second:init');
      },
    });

    const ctx = createContext().use(first).use(second).build();

    // build runs synchronously — both builds happen before any init
    expect(order).toEqual(['first:build', 'second:build']);

    await ctx.init();

    expect(order).toEqual(['first:build', 'second:build', 'first:init', 'second:init']);
    // second's build saw first.loaded as false (init hadn't run yet)
    expect(ctx.secondSawFirstLoaded).toBe(false);
    // but after init, first.loaded is true
    expect(ctx.first.loaded).toBe(true);
  });
});

// ─── 3. Plugin with dependencies — type inference ────────────────────────────

describe('plugin with dependencies', () => {
  test('receives dependency context in build', async () => {
    const loggerPlugin = plugin({
      name: 'logger',
      build() {
        return { logger: { log: (...args: unknown[]) => args } };
      },
    });

    const servicePlugin = plugin({
      name: 'service',
      dependencies: [loggerPlugin],
      build(ctx) {
        // ctx.logger should be available
        const result = ctx.logger.log('init');
        return { service: { result } };
      },
    });

    const ctx = createContext().use(loggerPlugin).use(servicePlugin).build();
    await ctx.init();

    expect(ctx.service.result).toEqual(['init']);
    expect(ctx.logger.log('test')).toEqual(['test']);
  });
});

// ─── 4. Transitive dependencies ──────────────────────────────────────────────

describe('transitive dependencies', () => {
  test('all dependencies must be explicitly registered in order', async () => {
    const a = plugin({
      name: 'a',
      build() {
        return { a: 1 };
      },
    });

    const b = plugin({
      name: 'b',
      dependencies: [a],
      build(ctx) {
        return { b: ctx.a + 1 };
      },
    });

    const c = plugin({
      name: 'c',
      dependencies: [b],
      build(ctx) {
        return { c: ctx.a + ctx.b };
      },
    });

    const ctx = createContext().use(a).use(b).use(c).build();
    await ctx.init();

    expect(ctx.a).toBe(1);
    expect(ctx.b).toBe(2);
    expect(ctx.c).toBe(3);
  });
});

// ─── 5. Duplicate plugin skipped ─────────────────────────────────────────────

describe('duplicate plugin', () => {
  test('throws DuplicatePluginError when registering the same plugin twice', () => {
    const p = plugin({
      name: 'once',
      build: () => ({ val: 'once' }),
    });

    expect(() => createContext().use(p).use(p)).toThrow(DuplicatePluginError);
    expect(() => createContext().use(p).use(p)).toThrow(/already registered/);
  });

  test('throws DuplicatePluginError for different plugins with same name', () => {
    const p1 = plugin({
      name: 'shared',
      build: () => ({ a: 1 }),
    });

    const p2 = plugin({
      name: 'shared',
      build: () => ({ b: 2 }),
    });

    expect(() => createContext().use(p1).use(p2)).toThrow(DuplicatePluginError);
  });
});

// ─── 5b. init() idempotency ─────────────────────────────────────────────────

describe('init idempotency', () => {
  test('multiple init() calls return the same promise and run init once', async () => {
    const initFn = mock(async () => {});

    const p = plugin({
      name: 'idem',
      build: () => ({ val: 'once' }),
      init: initFn,
    });

    const ctx = createContext().use(p).build();
    const p1 = ctx.init();
    const p2 = ctx.init();

    expect(p1).toBe(p2);

    await Promise.all([p1, p2]);
    expect(initFn).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. Missing dependency detection ─────────────────────────────────────────

describe('missing dependency', () => {
  test('throws when dependency is not registered', () => {
    const a = plugin({
      name: 'a',
      build: () => ({ a: 1 }),
    });

    const b = plugin({
      name: 'b',
      dependencies: [a],
      build: () => ({ b: 2 }),
    });

    // Cast to bypass type constraint — runtime should still catch it
    expect(() => (createContext() as any).use(b).build()).toThrow(
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
      build: () => ({ first: true }),
      dispose: () => {
        order.push('first');
      },
    });

    const second = plugin({
      name: 'second',
      dependencies: [first],
      build: () => ({ second: true }),
      dispose: () => {
        order.push('second');
      },
    });

    const third = plugin({
      name: 'third',
      dependencies: [second],
      build: () => ({ third: true }),
      dispose: () => {
        order.push('third');
      },
    });

    const ctx = createContext().use(first).use(second).use(third).build();
    await ctx.init();

    await ctx.close();
    expect(order).toEqual(['third', 'second', 'first']);

    // Double close should be a no-op
    await ctx.close();
    expect(order).toEqual(['third', 'second', 'first']);
  });

  test('concurrent close() calls share the same promise', async () => {
    const disposeFn = mock(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const p = plugin({
      name: 'slow-dispose',
      build: () => ({ slow: true }),
      dispose: disposeFn,
    });

    const ctx = createContext().use(p).build();
    await ctx.init();

    const c1 = ctx.close();
    const c2 = ctx.close();
    expect(c1).toBe(c2);

    await Promise.all([c1, c2]);
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  test('close is non-enumerable', async () => {
    const p = plugin({
      name: 'p',
      build: () => ({ x: 1 }),
    });

    const ctx = createContext().use(p).build();
    await ctx.init();

    expect(Object.keys(ctx)).toEqual(['x']);
    expect(typeof ctx.close).toBe('function');
  });
});

// ─── 8. Plugin with options (Zod schema) ────────────────────────────────────

describe('plugin with options', () => {
  test('passes validated options to build', async () => {
    const configPlugin = plugin({
      name: 'config',
      options: z.object({ port: z.number(), host: z.string() }),
      build(_ctx, options) {
        return { config: { port: options.port, host: options.host } };
      },
    });

    const ctx = createContext().use(configPlugin, { port: 3000, host: 'localhost' }).build();
    await ctx.init();

    expect(ctx.config.port).toBe(3000);
    expect(ctx.config.host).toBe('localhost');
  });

  test('throws on invalid options', () => {
    const configPlugin = plugin({
      name: 'config',
      options: z.object({ port: z.number(), host: z.string() }),
      build(_ctx, options) {
        return { config: options };
      },
    });

    expect(() =>
      createContext()
        .use(configPlugin, { port: 'not-a-number', host: 123 } as any)
        .build(),
    ).toThrow();
  });
});

// ─── 9. Error during build triggers cleanup ──────────────────────────────────

describe('build error', () => {
  test('throws PluginBuildError on failure', () => {
    const good = plugin({
      name: 'good',
      build: () => ({ good: true }),
    });

    const bad = plugin({
      name: 'bad',
      dependencies: [good],
      build: (): Record<string, unknown> => {
        throw new Error('boom');
      },
    });

    expect(() => createContext().use(good).use(bad).build()).toThrow(PluginBuildError);
  });

  test('PluginBuildError contains plugin name and cause', () => {
    const failing = plugin({
      name: 'failing',
      build: (): Record<string, unknown> => {
        throw new Error('original');
      },
    });

    try {
      createContext().use(failing).build();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PluginBuildError);
      expect((err as PluginBuildError).pluginName).toBe('failing');
      expect((err as PluginBuildError).cause).toBeInstanceOf(Error);
    }
  });
});

// ─── 9b. Init error cleanup ──────────────────────────────────────────────────

describe('init error cleanup', () => {
  test('disposes already-initialized plugins on init failure', async () => {
    const disposed: string[] = [];

    const good = plugin({
      name: 'good',
      build: () => ({ good: true }),
      dispose: () => {
        disposed.push('good');
      },
    });

    const bad = plugin({
      name: 'bad',
      dependencies: [good],
      build: () => ({ bad: true }),
      init: () => {
        throw new Error('init boom');
      },
    });

    const ctx = createContext().use(good).use(bad).build();
    await expect(ctx.init()).rejects.toThrow(PluginInitError);

    // both should be disposed
    expect(disposed).toEqual(['good']);
  });

  test('PluginInitError contains plugin name and cause', async () => {
    const failing = plugin({
      name: 'failing',
      build: () => ({ x: 1 }),
      init: () => {
        throw new Error('init original');
      },
    });

    const ctx = createContext().use(failing).build();

    try {
      await ctx.init();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PluginInitError);
      expect((err as PluginInitError).pluginName).toBe('failing');
      expect((err as PluginInitError).cause).toBeInstanceOf(Error);
    }
  });
});

// ─── 10. Type-level tests ────────────────────────────────────────────────────

describe('type-level correctness', () => {
  test('context is readonly (frozen)', async () => {
    const p = plugin({
      name: 'p',
      build: () => ({ val: 'hello' }),
    });

    const ctx = createContext().use(p).build();
    await ctx.init();

    // Runtime freeze check
    expect(() => {
      (ctx as any).val = 'changed';
    }).toThrow();

    expect(ctx.val).toBe('hello');
  });

  test('key collision throws', () => {
    const a = plugin({
      name: 'a',
      build: () => ({ shared: 1 }),
    });

    const b = plugin({
      name: 'b',
      build: () => ({ shared: 2 }),
    });

    expect(() => createContext().use(a).use(b).build()).toThrow(/already exists/);
  });

  test('compile-time type inference works', async () => {
    const loggerPlugin = plugin({
      name: 'logger',
      build() {
        return { logger: console };
      },
    });

    const dbPlugin = plugin({
      name: 'db',
      dependencies: [loggerPlugin],
      options: z.object({ url: z.string() }),
      build(ctx, options) {
        ctx.logger.log('Connecting to', options.url);
        const db = {
          url: options.url,
          connected: false,
          query: async (sql: string) => sql,
          close: async () => {},
        };
        return { db };
      },
      async init({ db }) {
        // Simulate async connection
        db.connected = true;
      },
      async dispose({ db }) {
        await db.close();
      },
    });

    const ctx = createContext()
      .use(loggerPlugin)
      .use(dbPlugin, { url: 'postgres://localhost' })
      .build();
    await ctx.init();

    // These lines verify type inference at compile time
    const _logger: Console = ctx.logger;
    const _query: (sql: string) => Promise<string> = ctx.db.query;

    expect(_logger).toBe(console);
    expect(typeof _query).toBe('function');

    await ctx.close();
  });
});

// ─── 11. Reserved keys ───────────────────────────────────────────────────────

describe('reserved keys', () => {
  test('plugin declaring "init" key throws ReservedKeyError', () => {
    const bad = plugin({
      name: 'bad-init',
      build: () => ({ init: () => {} }),
    });

    expect(() => createContext().use(bad).build()).toThrow(ReservedKeyError);
    expect(() => createContext().use(bad).build()).toThrow(/reserved context method/);
  });

  test('plugin declaring "close" key throws ReservedKeyError', () => {
    const bad = plugin({
      name: 'bad-close',
      build: () => ({ close: () => {} }),
    });

    expect(() => createContext().use(bad).build()).toThrow(ReservedKeyError);
    expect(() => createContext().use(bad).build()).toThrow(/reserved context method/);
  });

  test('init and close are non-enumerable', () => {
    const p = plugin({
      name: 'p',
      build: () => ({ x: 1 }),
    });

    const ctx = createContext().use(p).build();

    expect(Object.keys(ctx)).toEqual(['x']);
    expect(typeof ctx.init).toBe('function');
    expect(typeof ctx.close).toBe('function');
  });
});
