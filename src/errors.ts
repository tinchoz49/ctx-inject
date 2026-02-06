export class CircularDependencyError extends Error {
  constructor(public readonly chain: string[]) {
    super(`Circular dependency detected: ${chain.join(' → ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class PluginSetupError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly cause: unknown,
  ) {
    super(
      `Plugin "${pluginName}" setup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PluginSetupError';
  }
}
