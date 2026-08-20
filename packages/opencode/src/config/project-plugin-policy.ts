export function stripProjectPluginDeclaration<T extends object>(
  config: T,
  disabled: boolean,
): { config: T | Omit<T, "plugin">; suppressed: boolean } {
  if (!disabled || !("plugin" in config) || config.plugin === undefined) {
    return { config, suppressed: false }
  }

  const { plugin: _plugin, ...copy } = config
  return { config: copy, suppressed: true }
}

export function shouldLoadProjectPluginDirectory(
  disabled: boolean,
  projectScoped: boolean,
): boolean {
  return !disabled || !projectScoped
}
