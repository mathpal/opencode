import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { localPluginDirectories } from "../src/plugin/discovery"

// mathpal fork: OPENCODE_DISABLE_PROJECT_PLUGINS for TUI plugin discovery.

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const layout = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tui-plugin-discovery-"))
  roots.push(root)
  const config = path.join(root, "config")
  const project = path.join(root, "repo")
  await mkdir(path.join(project, ".git"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "plugins"), { recursive: true })
  await mkdir(config, { recursive: true })
  return { config, project }
}

test("includes project plugin directories by default", async () => {
  const { config, project } = await layout()
  expect(await localPluginDirectories(project, config, {})).toEqual([
    path.join(config, "plugins"),
    path.join(project, ".opencode", "plugins"),
  ])
})

test("returns only the global plugin directory when project plugins are disabled", async () => {
  const { config, project } = await layout()
  expect(await localPluginDirectories(project, config, { OPENCODE_DISABLE_PROJECT_PLUGINS: "1" })).toEqual([
    path.join(config, "plugins"),
  ])
})
