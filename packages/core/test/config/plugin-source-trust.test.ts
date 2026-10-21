import { describe, expect, test } from "bun:test"
import { Directory, Document, Info } from "@opencode/schema/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { AbsolutePath } from "@opencode/core/schema"

// mathpal fork: OPENCODE_DISABLE_PROJECT_PLUGINS trust partitioning.

const directory = (value: string) => new Directory({ type: "directory", path: AbsolutePath.make(value) })
const document = (value: string | undefined, plugins: readonly string[]) =>
  new Document({
    type: "document",
    ...(value === undefined ? {} : { path: AbsolutePath.make(value) }),
    info: new Info({ plugins: [...plugins] }),
  })

const trust = {
  roots: ["/home/u/.config/opencode", "/etc/opencode"],
  files: ["/home/u/extra/opencode.json"],
}

describe("ConfigPluginSource.partition", () => {
  test("keeps every entry when project plugins are allowed", () => {
    const entries = [directory("/repo/.opencode"), document("/repo/opencode.json", ["-*"])]
    expect(ConfigPluginSource.partition(entries, undefined)).toEqual({ kept: entries, suppressed: [] })
  })

  test("keeps global, system, explicit, and path-less sources and suppresses project ones", () => {
    const global = directory("/home/u/.config/opencode")
    const globalFile = document("/home/u/.config/opencode/opencode.json", ["/opt/plugins/shipyard"])
    const system = directory("/etc/opencode")
    const explicit = document("/home/u/extra/opencode.json", ["explicit-plugin"])
    const content = document(undefined, ["content-plugin"])
    const project = directory("/repo/.opencode")
    const projectFile = document("/repo/.opencode/opencode.json", ["evil-npm-plugin"])
    const ancestor = document("/repo/opencode.json", ["-*"])
    const result = ConfigPluginSource.partition(
      [global, globalFile, system, explicit, content, project, projectFile, ancestor],
      trust,
    )
    expect(result.kept).toEqual([global, globalFile, system, explicit, content])
    expect(result.suppressed).toEqual([project, projectFile, ancestor])
  })

  test("does not trust a sibling directory that shares the global prefix", () => {
    const sibling = directory("/home/u/.config/opencode-evil")
    expect(ConfigPluginSource.partition([sibling], trust).suppressed).toEqual([sibling])
  })
})

describe("ConfigPluginSource.projectPluginsDisabled", () => {
  test("accepts 1 and true, case-insensitively", () => {
    expect(ConfigPluginSource.projectPluginsDisabled({ OPENCODE_DISABLE_PROJECT_PLUGINS: "1" })).toBe(true)
    expect(ConfigPluginSource.projectPluginsDisabled({ OPENCODE_DISABLE_PROJECT_PLUGINS: "TRUE" })).toBe(true)
    expect(ConfigPluginSource.projectPluginsDisabled({ OPENCODE_DISABLE_PROJECT_PLUGINS: "0" })).toBe(false)
    expect(ConfigPluginSource.projectPluginsDisabled({})).toBe(false)
  })
})
