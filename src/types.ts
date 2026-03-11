import type { ZodType } from 'zod';

/**
 * Converts a union type to an intersection type.
 */
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Extracts the input type from a Zod schema.
 */
type ZodInput<T extends ZodType> = T extends ZodType<any, infer I> ? I : never;

/**
 * A plugin definition.
 *
 * @typeParam TDecorations - The record of values this plugin adds to the context.
 * @typeParam TDeps - Tuple of plugins this plugin depends on.
 * @typeParam TOptions - Zod schema for options (undefined if none).
 */
export interface Plugin<
  TDecorations extends Record<string, unknown> = any,
  TDeps extends readonly AnyPlugin[] = any,
  TOptions extends ZodType | undefined = any,
> {
  readonly name: string;
  readonly dependencies: TDeps;
  readonly options?: TOptions;
  readonly setup: (ctx: any, options?: any) => TDecorations;
  readonly init?: (decorations: TDecorations) => void | Promise<void>;
  readonly dispose?: (decorations: TDecorations) => void | Promise<void>;
}

/**
 * A plugin that requires options to be passed to `.use()`.
 */
export interface PluginWithOptions<
  TDecorations extends Record<string, unknown> = any,
  TDeps extends readonly AnyPlugin[] = any,
  TOptions extends ZodType = ZodType,
> extends Plugin<TDecorations, TDeps, TOptions> {
  readonly __hasOptions: true;
  readonly options: TOptions;
}

/** Shorthand for any plugin. */
export type AnyPlugin = Plugin<any, any, any>;

/**
 * Extract decorations type from a plugin.
 */
export type Decorations<P extends AnyPlugin> = P extends Plugin<infer D, any, any> ? D : never;

/**
 * Extract the deps tuple from a plugin.
 */
type DepPlugins<P extends AnyPlugin> =
  P extends Plugin<any, infer D, any> ? (D extends readonly AnyPlugin[] ? D : []) : [];

/**
 * Recursively collects all decorations from a plugin and its transitive dependencies.
 * Uses a depth counter to prevent infinite recursion.
 */
export type AllDecorations<
  P extends AnyPlugin,
  Depth extends readonly unknown[] = [],
> = Depth['length'] extends 10
  ? Decorations<P>
  : Decorations<P> &
      (DepPlugins<P> extends readonly [
        infer First extends AnyPlugin,
        ...infer Rest extends AnyPlugin[],
      ]
        ? AllDecorations<First, [...Depth, unknown]> & ResolveDepsImpl<Rest, Depth>
        : {});

/**
 * Internal: resolve deps with depth tracking.
 */
type ResolveDepsImpl<
  Deps extends readonly AnyPlugin[],
  Depth extends readonly unknown[],
> = Deps extends readonly [infer First extends AnyPlugin, ...infer Rest extends AnyPlugin[]]
  ? AllDecorations<First, [...Depth, unknown]> & ResolveDepsImpl<Rest, Depth>
  : {};

/**
 * Given a tuple of plugins, resolves the intersection of all their decorations
 * (including transitive deps).
 */
export type ResolveDeps<Deps extends readonly AnyPlugin[]> = ResolveDepsImpl<Deps, []>;

/**
 * The initialized context: a frozen object with all accumulated decorations
 * plus a non-enumerable `close()` method.
 */
export type Context<T> = Readonly<T> & { ready(): Promise<void>; close(): Promise<void> };

/**
 * Extracts the options type from a plugin with options.
 */
export type PluginOptions<P> =
  P extends PluginWithOptions<any, any, infer TOptions> ? ZodInput<TOptions> : void;

/**
 * The context type required by a plugin's dependencies.
 * All dependencies must be explicitly registered before the plugin.
 */
export type RequiredDeps<P extends AnyPlugin> = ResolveDeps<DepPlugins<P>>;

/**
 * Type-level dependency check. Resolves to `unknown` when all deps are satisfied,
 * otherwise produces an intersection with a descriptive error type showing
 * what context properties are required.
 */
export type EnsureDeps<P extends AnyPlugin, T> = [T] extends [RequiredDeps<P>]
  ? unknown
  : { __dependencies_not_registered: RequiredDeps<P> };

/**
 * Config object passed to the `plugin()` factory when options are declared via a Zod schema.
 */
export interface PluginConfigWithOptions<
  TDecorations extends Record<string, unknown>,
  TDeps extends readonly AnyPlugin[],
  TOptions extends ZodType,
> {
  name: string;
  dependencies?: TDeps;
  options: TOptions;
  setup: (ctx: ResolveDeps<TDeps>, options: ZodInput<TOptions>) => TDecorations;
  init?: (decorations: TDecorations) => void | Promise<void>;
  dispose?: (decorations: TDecorations) => void | Promise<void>;
}

/**
 * Config object passed to the `plugin()` factory when setup takes no options.
 */
export interface PluginConfigWithoutOptions<
  TDecorations extends Record<string, unknown>,
  TDeps extends readonly AnyPlugin[],
> {
  name: string;
  dependencies?: TDeps;
  setup: (ctx: ResolveDeps<TDeps>) => TDecorations;
  init?: (decorations: TDecorations) => void | Promise<void>;
  dispose?: (decorations: TDecorations) => void | Promise<void>;
}
