export * as ProjectPlugins from "./project-plugins.js"

/**
 * `OPENCODE_DISABLE_PROJECT_PLUGINS` (mathpal fork). The launcher sets it so
 * repositories cannot add, load, or remove plugins. Shared by core plugin
 * discovery (`ConfigPluginSource`) and TUI plugin discovery.
 */
export function disabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.OPENCODE_DISABLE_PROJECT_PLUGINS
  return value === "1" || value?.toLowerCase() === "true"
}
