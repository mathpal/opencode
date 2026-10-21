// mathpal fork: end-to-end test for ConfigPluginSource.layer under OPENCODE_DISABLE_PROJECT_PLUGINS.
// Exercises the REAL layer's scan() — not just the pure partition() on hand-built entries.

import { describe, test, expect } from "bun:test"
import fsNative from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Directory, Document, Info } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Global } from "@opencode/util/global"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "../fixture/tmpdir"
import { location as makeLocationValue } from "../fixture/location"

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

async function setupDirs() {
  const tmp = await tmpdir()
  const globalDir = path.join(tmp.path, "global")
  const projectDir = path.join(tmp.path, "project")

  // Global config: one trusted plugin file under plugins/.
  await fsNative.mkdir(path.join(globalDir, "plugins"), { recursive: true })
  await fsNative.writeFile(
    path.join(globalDir, "plugins", "trusted-plugin.ts"),
    "// mathpal fork: trusted fixture plugin\nexport default { id: 'trusted-plugin' }",
  )

  // Project: one evil plugin under .opencode/plugins/ (should be suppressed when flag set).
  await fsNative.mkdir(path.join(projectDir, ".opencode", "plugins"), { recursive: true })
  await fsNative.writeFile(
    path.join(projectDir, ".opencode", "plugins", "evil.ts"),
    "// mathpal fork: evil fixture plugin\nexport default { id: 'evil' }",
  )

  return { tmp, globalDir, projectDir }
}

// Config entries that mirror what real Config discovery would produce for this fixture layout:
//   • global directory → discovers plugins/trusted-plugin.ts
//   • project .opencode directory → discovers .opencode/plugins/evil.ts  (suppressed when flag set)
//   • project opencode.json with plugins ["-*", "evil-npm-pkg"]           (suppressed when flag set)
function buildEntries(globalDir: string, projectDir: string) {
  return [
    new Directory({ type: "directory", path: AbsolutePath.make(globalDir) }),
    new Directory({ type: "directory", path: AbsolutePath.make(path.join(projectDir, ".opencode")) }),
    new Document({
      type: "document",
      path: AbsolutePath.make(path.join(projectDir, "opencode.json")),
      info: new Info({ plugins: ["-*", "evil-npm-pkg"] }),
    }),
  ]
}

// Build the real ConfigPluginSource.layer wired to in-memory config entries and a
// real (temp) filesystem so PluginSourceDirectory.discover can read directories.
function buildSourceLayer(globalDir: string, projectDir: string, entries: ReturnType<typeof buildEntries>) {
  const locationValue = makeLocationValue({ directory: AbsolutePath.make(projectDir) })
  const locationLayer = Layer.succeed(Location.Service, Location.Service.of(locationValue))

  return LayerNode.compile(ConfigPluginSource.node, {
    replacements: [
      Config.node.replace(Config.testLayer(entries)),
      Global.node.replace(
        Global.layerWith({
          config: globalDir,
          home: globalDir,
          data: path.join(globalDir, "data"),
          cache: path.join(globalDir, "cache"),
          state: path.join(globalDir, "state"),
          tmp: path.join(globalDir, "tmp"),
          bin: path.join(globalDir, "cache", "bin"),
          log: path.join(globalDir, "data", "log"),
          repos: path.join(globalDir, "data", "repos"),
        }),
      ),
      Watcher.node.replace(Watcher.testLayer),
      Location.node.replace(locationLayer),
    ],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigPluginSource.layer end-to-end suppression", () => {
  test("with OPENCODE_DISABLE_PROJECT_PLUGINS=1: global plugin present, project ops absent, logs emitted", async () => {
    const { tmp, globalDir, projectDir } = await setupDirs()
    const savedEnv = process.env.OPENCODE_DISABLE_PROJECT_PLUGINS
    process.env.OPENCODE_DISABLE_PROJECT_PLUGINS = "1"
    try {
      const entries = buildEntries(globalDir, projectDir)

      // Capture "suppressed project plugins" log messages from inside the layer.
      const logs: Array<[string, Record<string, unknown>]> = []
      const captureLogger = Logger.map(Logger.formatStructured, (entry) => {
        const msg = entry.message
        if (Array.isArray(msg) && msg[0] === "suppressed project plugins") {
          logs.push(msg as [string, Record<string, unknown>])
        }
      })

      const ops = await Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return yield* source.operations()
        }).pipe(
          Effect.provide(buildSourceLayer(globalDir, projectDir, entries)),
          Effect.provide(Logger.layer([captureLogger])),
          Effect.scoped,
        ),
      )

      const trustedPlugin = path.join(globalDir, "plugins", "trusted-plugin.ts")
      const evilTs = path.join(projectDir, ".opencode", "plugins", "evil.ts")

      // Global plugin must be discovered and returned.
      expect(ops.some((op) => op.type === "add" && op.target === trustedPlugin)).toBe(true)

      // Project-scoped additions and removals must be absent.
      expect(ops.some((op) => op.type === "add" && op.target === evilTs)).toBe(false)
      expect(ops.some((op) => op.type === "remove" && op.target === "*")).toBe(false)
      expect(ops.some((op) => op.type === "add" && op.target === "evil-npm-pkg")).toBe(false)

      // "suppressed project plugins" must be logged for the .opencode directory
      // (which contains evil.ts) and for the project opencode.json (which carries -* and evil-npm-pkg).
      expect(logs.some((l) => l[1]?.source === path.join(projectDir, ".opencode"))).toBe(true)
      expect(logs.some((l) => l[1]?.source === path.join(projectDir, "opencode.json"))).toBe(true)
    } finally {
      if (savedEnv === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_PLUGINS
      else process.env.OPENCODE_DISABLE_PROJECT_PLUGINS = savedEnv
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("with flag unset: project plugin add and removals all present", async () => {
    const { tmp, globalDir, projectDir } = await setupDirs()
    const savedEnv = process.env.OPENCODE_DISABLE_PROJECT_PLUGINS
    delete process.env.OPENCODE_DISABLE_PROJECT_PLUGINS
    try {
      const entries = buildEntries(globalDir, projectDir)

      const ops = await Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return yield* source.operations()
        }).pipe(
          Effect.provide(buildSourceLayer(globalDir, projectDir, entries)),
          Effect.scoped,
        ),
      )

      const evilTs = path.join(projectDir, ".opencode", "plugins", "evil.ts")

      // With no suppression, project plugin dir content must be present.
      expect(ops.some((op) => op.type === "add" && op.target === evilTs)).toBe(true)

      // Project-level removal and npm addition must also be present.
      expect(ops.some((op) => op.type === "remove" && op.target === "*")).toBe(true)
      expect(ops.some((op) => op.type === "add" && op.target === "evil-npm-pkg")).toBe(true)
    } finally {
      if (savedEnv === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_PLUGINS
      else process.env.OPENCODE_DISABLE_PROJECT_PLUGINS = savedEnv
      await tmp[Symbol.asyncDispose]()
    }
  })
})
