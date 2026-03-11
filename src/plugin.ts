import type { ZodType } from 'zod';
import type {
  AnyPlugin,
  Plugin,
  PluginWithOptions,
  PluginConfigWithOptions,
  PluginConfigWithoutOptions,
} from './types';

/**
 * Overload: config with `options` Zod schema.
 */
export function plugin<
  TDecorations extends Record<string, unknown>,
  const TDeps extends readonly AnyPlugin[],
  TOptions extends ZodType,
>(
  config: PluginConfigWithOptions<TDecorations, TDeps, TOptions>,
): PluginWithOptions<TDecorations, TDeps, TOptions>;

/**
 * Overload: config without `options`.
 */
export function plugin<
  TDecorations extends Record<string, unknown>,
  const TDeps extends readonly AnyPlugin[],
>(config: PluginConfigWithoutOptions<TDecorations, TDeps>): Plugin<TDecorations, TDeps, undefined>;

export function plugin(config: {
  name: string;
  dependencies?: readonly AnyPlugin[];
  options?: ZodType;
  setup: (ctx: any, options?: any) => any;
  init?: (decorations: any) => void | Promise<void>;
  dispose?: (decorations: any) => void | Promise<void>;
}): AnyPlugin {
  return {
    name: config.name,
    dependencies: config.dependencies ?? [],
    options: config.options,
    setup: config.setup,
    init: config.init,
    dispose: config.dispose,
  };
}
