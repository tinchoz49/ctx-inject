import { PluginBuildError, PluginInitError, ReservedKeyError } from './errors';
import type {
  AnyPlugin,
  Context,
  Decorations,
  EnsureDeps,
  PluginOptions,
  PluginWithOptions,
} from './types';

interface PluginEntry {
  plugin: AnyPlugin;
  options?: unknown;
}

const RESERVED_KEYS = ['init', 'close'];

async function disposeAll(
  initialized: Array<{ plugin: AnyPlugin; decorations: Record<string, unknown> }>,
) {
  const reversed = [...initialized].toReversed();
  for (const { plugin: p, decorations } of reversed) {
    if (p.dispose) {
      await p.dispose(decorations);
    }
  }
}

export class ContextBuilder<T = {}> {
  private plugins: Map<string, PluginEntry> = new Map();

  /**
   * Registers a plugin. Duplicate registrations are skipped.
   */
  private addPlugin(entry: PluginEntry): void {
    const name = entry.plugin.name;

    // Already registered — skip (but preserve options if provided later)
    if (this.plugins.has(name)) {
      if (entry.options !== undefined) {
        this.plugins.get(name)!.options = entry.options;
      }
      return;
    }

    this.plugins.set(name, entry);
  }

  /**
   * Register a plugin that requires options.
   * All dependencies must be registered before this plugin.
   */
  use<P extends PluginWithOptions>(
    plugin: P & EnsureDeps<P, T>,
    options: PluginOptions<P>,
  ): ContextBuilder<T & Decorations<P>>;

  /**
   * Register a plugin without options.
   * All dependencies must be registered before this plugin.
   */
  use<P extends AnyPlugin>(plugin: P & EnsureDeps<P, T>): ContextBuilder<T & Decorations<P>>;

  use(plugin: AnyPlugin, options?: unknown): any {
    this.addPlugin({ plugin, options });
    return this;
  }

  /**
   * Build the context synchronously. Runs each plugin's `build()` method
   * in registration order, respecting dependencies. Returns a context
   * with `init()` and `close()` methods (non-enumerable).
   */
  build(): Context<T> {
    const plugins = [...this.plugins.values()];
    const ctx: Record<string, unknown> = {};
    const initialized: Array<{
      plugin: AnyPlugin;
      decorations: Record<string, unknown>;
    }> = [];

    const initializedNames = new Set<string>();

    for (const entry of plugins) {
      // Runtime dependency check
      for (const dep of entry.plugin.dependencies) {
        if (!initializedNames.has(dep.name)) {
          throw new Error(
            `Plugin "${entry.plugin.name}" requires "${dep.name}" to be registered before it`,
          );
        }
      }

      let decorations: Record<string, unknown>;
      try {
        if (entry.plugin.options) {
          entry.options = entry.plugin.options.parse(entry.options);
        }
        decorations = entry.plugin.build(ctx, entry.options);
      } catch (err) {
        throw new PluginBuildError(entry.plugin.name, err);
      }

      // Check for reserved keys
      for (const key of Object.keys(decorations)) {
        if (RESERVED_KEYS.includes(key)) {
          throw new ReservedKeyError(entry.plugin.name, key);
        }
      }

      // Check for key collisions
      for (const key of Object.keys(decorations)) {
        if (key in ctx) {
          throw new Error(
            `Plugin "${entry.plugin.name}" tried to add key "${key}" which already exists in the context`,
          );
        }
      }

      Object.assign(ctx, decorations);
      initialized.push({ plugin: entry.plugin, decorations });
      initializedNames.add(entry.plugin.name);
    }

    let initPromise: Promise<void> | null = null;
    let closePromise: Promise<void> | null = null;

    Object.defineProperty(ctx, 'init', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: () => {
        if (!initPromise) {
          initPromise = initializePlugins(ctx, initialized);
        }
        return initPromise;
      },
    });

    Object.defineProperty(ctx, 'close', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: () => {
        if (!closePromise) {
          closePromise = disposeAll([...initialized]);
        }
        return closePromise;
      },
    });

    return ctx as Context<T>;
  }
}

async function initializePlugins(
  ctx: Record<string, unknown>,
  initialized: Array<{ plugin: AnyPlugin; decorations: Record<string, unknown> }>,
): Promise<void> {
  for (const { plugin: p, decorations } of initialized) {
    if (p.init) {
      try {
        await p.init(decorations);
      } catch (err) {
        await disposeAll(initialized);
        throw new PluginInitError(p.name, err);
      }
    }
  }

  Object.freeze(ctx);
}

export function createContext(): ContextBuilder {
  return new ContextBuilder();
}
