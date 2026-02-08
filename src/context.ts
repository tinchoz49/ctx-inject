import { PluginSetupError } from './errors';
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
  private _readyPromise: Promise<Context<T>> | null = null;

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
   * Initialize the context: run all plugin setups in registration order,
   * freeze the result, and attach a non-enumerable `close()` method.
   * Multiple calls return the same promise.
   */
  ready(): Promise<Context<T>> {
    if (!this._readyPromise) {
      this._readyPromise = this._initialize();
    }
    return this._readyPromise;
  }

  private async _initialize(): Promise<Context<T>> {
    const ctx: Record<string, unknown> = {};
    const initialized: Array<{
      plugin: AnyPlugin;
      decorations: Record<string, unknown>;
    }> = [];
    const initializedNames = new Set<string>();

    for (const [, entry] of this.plugins) {
      // Runtime dependency check
      for (const dep of entry.plugin.dependencies) {
        if (!initializedNames.has(dep.name)) {
          await disposeAll(initialized);
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
        decorations = await entry.plugin.setup(ctx, entry.options);
      } catch (err) {
        // Dispose already-initialized plugins in reverse order
        await disposeAll(initialized);
        throw new PluginSetupError(entry.plugin.name, err);
      }

      // Check for key collisions
      for (const key of Object.keys(decorations)) {
        if (key in ctx) {
          await disposeAll(initialized);
          throw new Error(
            `Plugin "${entry.plugin.name}" tried to add key "${key}" which already exists in the context`,
          );
        }
      }

      Object.assign(ctx, decorations);
      initialized.push({ plugin: entry.plugin, decorations });
      initializedNames.add(entry.plugin.name);
    }

    let closePromise: Promise<void> | null = null;

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

    Object.freeze(ctx);

    return ctx as Context<T>;
  }
}

export function createContext(): ContextBuilder {
  return new ContextBuilder();
}
