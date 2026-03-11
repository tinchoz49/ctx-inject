export class CircularDependencyError extends Error {
  constructor(public readonly chain: string[]) {
    super(`Circular dependency detected: ${chain.join(' → ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class ReservedKeyError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly key: string,
  ) {
    super(`Plugin "${pluginName}" tried to add key "${key}" which is a reserved context method`);
    this.name = 'ReservedKeyError';
  }
}

export class PluginBuildError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly cause: unknown,
  ) {
    super(
      `Plugin "${pluginName}" build failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PluginBuildError';
  }
}

export class PluginInitError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly cause: unknown,
  ) {
    super(
      `Plugin "${pluginName}" init failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PluginInitError';
  }
}
