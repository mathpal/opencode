import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart } from "../../src/index.js"
import { AmazonBedrock } from "../../src/providers.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

// mathpal fork: pins upstream #52528 for the Bedrock GPT IDs our agents use. Bedrock Converse returns HTTP 400
// "This model doesn't support the image field for user messages" when an image stays inside toolResult.content.

describe("Bedrock GPT tool-result images", () => {
  for (const id of ["global.openai.gpt-6.1-sol", "global.openai.gpt-6-astra"]) {
    it.effect(`hoists tool-result images beside the result for ${id}`, () =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(
          LLM.request({
            model: AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", apiKey: "test-bearer" }).model(id),
            messages: [
              Message.assistant([ToolCallPart.make({ id: "tool_1", name: "read", input: {} })]),
              Message.tool({
                id: "tool_1",
                name: "read",
                result: {
                  type: "content",
                  value: [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }],
                },
              }),
            ],
            cache: "none",
          }),
        )
        expect(prepared.body.messages[1]).toEqual({
          role: "user",
          content: [
            { toolResult: { toolUseId: "tool_1", content: [{ text: "See attached image." }], status: "success" } },
            { image: { format: "png", source: { bytes: "AAAA" } } },
          ],
        })
      }),
    )
  }
})
