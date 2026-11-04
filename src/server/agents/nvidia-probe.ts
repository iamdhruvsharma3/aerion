import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { chatGenerationOptions, modelClient, providerConfiguration } from "./providers";
import { HttpError } from "../http";

const fixture =
  "Fictional engineering test only.\nSerial: FICTIONAL-NEMOTRON-01\nNo actual aircraft or buyer.";
const schema = z.object({ serial: z.string(), quote: z.string(), fictional: z.boolean() });
/** Explicit operator-only probe. Two bounded requests, synthetic text, no database writes or business tools. */
export async function probeNvidiaModel() {
  const client = modelClient("nvidia"),
    model = providerConfiguration("nvidia").model;
  if (!model) throw new HttpError(503, "NVIDIA model configuration is missing.");
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "This is an isolated engineering test. Call read_test_fixture exactly once to obtain the synthetic text, then return the report JSON. Do not invent values. Return the serial and its exact line as quote; fictional must be true. Do not return hidden reasoning.",
    },
    {
      role: "user",
      content: "Inspect the test fixture using the tool and produce the required report.",
    },
  ];
  const parameters = {
    model,
    stream: false as const,
    tools: [
      {
        type: "function" as const,
        function: {
          name: "read_test_fixture",
          description: "Read synthetic engineering text; no business data or side effects.",
          parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
        },
      },
    ],
    ...chatGenerationOptions("nvidia", 512),
  };
  const signal = AbortSignal.timeout(120_000);
  const first = await client.chat.completions.create({ ...parameters, messages }, { signal });
  const message = first.choices[0]?.message;
  const calls = message?.tool_calls;
  if (
    !message ||
    calls?.length !== 1 ||
    calls[0].type !== "function" ||
    calls[0].function.name !== "read_test_fixture"
  )
    throw new HttpError(
      422,
      "NVIDIA did not return the required test tool call. Tool calling needs inspection before business use.",
    );
  z.object({}).strict().parse(JSON.parse(calls[0].function.arguments));
  messages.push({ role: "assistant", content: message.content, tool_calls: calls });
  messages.push({
    role: "tool",
    tool_call_id: calls[0].id,
    content: JSON.stringify({ text: fixture }),
  });
  const { tools: _tools, ...reportParameters } = parameters;
  const second = await client.chat.completions.create(
    {
      ...reportParameters,
      messages,
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: "aerion_provider_probe",
          strict: true,
          schema: zodTextFormat(schema, "aerion_provider_probe").schema,
        },
      },
    },
    { signal },
  );
  const final = second.choices[0]?.message;
  if (!final?.content || final.tool_calls?.length || second.choices[0]?.finish_reason === "length")
    throw new HttpError(422, "NVIDIA did not return a complete structured test report.");
  const report = schema.parse(JSON.parse(final.content));
  if (
    report.serial !== "FICTIONAL-NEMOTRON-01" ||
    report.quote !== "Serial: FICTIONAL-NEMOTRON-01" ||
    report.fictional !== true
  )
    throw new HttpError(422, "The structured test report did not match the synthetic evidence.");
  return {
    provider: "nvidia",
    model,
    toolCalling: "passed",
    structuredOutput: "passed",
    evidenceCheck: "passed",
    requests: 2,
    usage: {
      inputTokens: (first.usage?.prompt_tokens ?? 0) + (second.usage?.prompt_tokens ?? 0),
      outputTokens: (first.usage?.completion_tokens ?? 0) + (second.usage?.completion_tokens ?? 0),
    },
    scope: "Synthetic capability smoke test only; no business records changed.",
  };
}
