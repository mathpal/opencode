import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import {
  shouldLoadProjectPluginDirectory,
  stripProjectPluginDeclaration,
} from "@/config/project-plugin-policy"

const ENV_NAME = "OPENCODE_DISABLE_PROJECT_PLUGINS"
const originalValue = process.env[ENV_NAME]

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_NAME]
    return
  }
  process.env[ENV_NAME] = originalValue
})

describe("project plugin policy", () => {
  test("removes only the plugin declaration when suppression is enabled", () => {
    const input = {
      plugin: ["oh-my-opencode"],
      model: "test/model",
      instructions: ["AGENTS.md"],
    }

    const result = stripProjectPluginDeclaration(input, true)

    expect(result).toEqual({
      config: {
        model: "test/model",
        instructions: ["AGENTS.md"],
      },
      suppressed: true,
    })
    expect(input.plugin).toEqual(["oh-my-opencode"])
  })

  test("preserves the original config when suppression is disabled", () => {
    const input = { plugin: ["project-plugin"], model: "test/model" }

    expect(stripProjectPluginDeclaration(input, false)).toEqual({
      config: input,
      suppressed: false,
    })
  })

  test("reports no suppression when the config declares no plugins", () => {
    const input = { model: "test/model" }

    expect(stripProjectPluginDeclaration(input, true)).toEqual({
      config: input,
      suppressed: false,
    })
  })

  test("skips plugin discovery only for project-scoped directories", () => {
    expect(shouldLoadProjectPluginDirectory(true, true)).toBe(false)
    expect(shouldLoadProjectPluginDirectory(true, false)).toBe(true)
    expect(shouldLoadProjectPluginDirectory(false, true)).toBe(true)
  })

  test("reads the suppression flag dynamically", () => {
    process.env[ENV_NAME] = "1"
    expect(Flag.OPENCODE_DISABLE_PROJECT_PLUGINS).toBe(true)

    process.env[ENV_NAME] = "false"
    expect(Flag.OPENCODE_DISABLE_PROJECT_PLUGINS).toBe(false)
  })
})
