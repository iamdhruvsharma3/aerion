import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTools } from "./tools";
import { runModel } from "./model";
import type { AgentRun } from "../../lib/agents/schema";
const { responses, chat } = vi.hoisted(() => ({ responses: vi.fn(), chat: vi.fn() }));
vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  modelClient: () => ({
    responses: { create: responses },
    chat: { completions: { create: chat } },
  }),
}));
const report = {
  summary: "Fictional model contract result",
  findings: [
    {
      title: "Need a current source",
      detail: "Current availability needs confirmation.",
      severity: "missing",
      citations: [],
    },
  ],
  limitations: ["Fictional contract test, not live inference."],
};
function session(provider: "openai" | "ollama" | "nvidia" = "openai") {
  const run = {
    id: "10000000-0000-4000-8000-000000000001",
    agentId: "matching",
    provider,
    model: "test-model",
    status: "running",
    attempts: 1,
    revision: 1,
    report: null,
    error: null,
    usage: null,
    createdAt: "2026-10-30T00:00:00Z",
    finishedAt: null,
    input: {
      agentId: "matching",
      provider,
      requirementId: "r",
      aircraftId: null,
      contactId: null,
      sourceIds: [],
      connectorIds: [],
      objective: "Fictional test",
      allowExternalSources: false,
      allowModelData: true,
      allowMailbox: false,
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
    },
  } satisfies AgentRun;
  return new AgentTools(
    { actorId: "actor", workspaceId: "workspace" },
    run,
    new AbortController().signal,
    async () => {},
    async () => {},
  );
}
beforeEach(() => {
  responses.mockReset();
  chat.mockReset();
});
describe("Model-driven tool loop contract", () => {
  it("uses strict SDK-compatible discriminated schemas for every granted function", () => {
    const tools = session(),
      definitions = tools.definitions();
    const proposal = definitions.find((t) => t.name === "propose_action");
    expect(proposal).toBeDefined();
    expect(JSON.stringify(proposal?.parameters)).not.toContain('"oneOf"');
    expect(definitions.every((t) => t.strict === true)).toBe(true);
  });
  it("requires an explicit commercial kind for new model proposals in both generic and selected-lead tools", () => {
    const tools = session("nvidia");
    const requirement = expect.objectContaining({
      properties: expect.objectContaining({
        type: expect.objectContaining({ const: "requirement" }),
        values: expect.objectContaining({
          properties: expect.objectContaining({
            transactionKind: expect.objectContaining({ enum: ["Sale", "Lease", "Not supplied"] }),
          }),
          required: expect.arrayContaining([
            "transactionKind",
            "leaseBudget",
            "leaseCurrency",
            "leaseBasis",
          ]),
        }),
      }),
    });
    expect(
      tools.definitions().find((tool) => tool.name === "propose_action")?.parameters,
    ).toMatchObject({
      properties: { action: { anyOf: expect.arrayContaining([requirement]) } },
    });
    tools.run.agentId = "buyer-requirements";
    tools.run.input.agentId = "buyer-requirements";
    tools.run.input.leadId = "10000000-0000-4000-8000-000000000003";
    expect(
      tools.definitions().find((tool) => tool.name === "propose_action")?.parameters,
    ).toMatchObject({
      properties: { action: requirement },
    });
  });
  it("executes a Responses tool call, supplies its result and records actual response usage", async () => {
    const tools = session();
    const call = vi.spyOn(tools, "invoke").mockResolvedValue({ counts: { eligible: 1 } });
    responses
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "match_aircraft",
            arguments: "{}",
            call_id: "call-1",
            id: "fc-1",
          },
        ],
        output_text: "",
        usage: { input_tokens: 20, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: JSON.stringify(report),
        usage: { input_tokens: 30, output_tokens: 15 },
      });
    const result = await runModel(tools);
    expect(call).toHaveBeenCalledWith("match_aircraft", {});
    expect(result.report).toEqual(report);
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20, requests: 2 });
    expect(responses.mock.calls[1][0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ counts: { eligible: 1 } }),
    });
    expect(responses.mock.calls[0][0].store).toBe(false);
  });
  it("supports a local model tool call with the same report and action contract", async () => {
    const tools = session("ollama");
    vi.spyOn(tools, "invoke").mockResolvedValue({
      missing: "Selected requirement needs confirmation",
    });
    chat
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "local-1",
                  type: "function",
                  function: { name: "case_context", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: JSON.stringify(report) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });
    const result = await runModel(tools);
    expect(result.report.summary).toBe(report.summary);
    expect(result.usage.requests).toBe(2);
  });
  it("stops on a missing report rather than substituting a deterministic result", async () => {
    responses.mockResolvedValue({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot complete" }] }],
      output_text: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(runModel(session())).rejects.toThrow("no report");
  });
  it("bounds repeated tool failures to six model requests and retains usage for the caller", async () => {
    const tools = session();
    vi.spyOn(tools, "invoke").mockRejectedValue(new Error("Unsupported tool"));
    responses.mockResolvedValue({
      output: [
        { type: "function_call", name: "send_email", arguments: "{}", call_id: "forbidden" },
      ],
      output_text: "",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
    await expect(runModel(tools, usage)).rejects.toThrow("six-request");
    expect(responses).toHaveBeenCalledTimes(6);
    expect(usage).toEqual({ inputTokens: 60, outputTokens: 12, requests: 6 });
  });
  it("reserves the final NVIDIA request for a report after successful business tools", async () => {
    const tools = session("nvidia");
    vi.spyOn(tools, "sources").mockResolvedValue([]);
    vi.spyOn(tools, "invoke").mockResolvedValue({ retained: true });
    for (let turn = 0; turn < 5; turn++)
      chat.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `tool-${turn}`,
                  type: "function",
                  function: { name: "workspace_context", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    chat.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "final",
                type: "function",
                function: { name: "finish_report", arguments: JSON.stringify(report) },
              },
            ],
          },
        },
      ],
    });
    expect((await runModel(tools)).report).toEqual(report);
    expect(
      chat.mock.calls[5][0].tools.map((tool: { function: { name: string } }) => tool.function.name),
    ).toEqual(["finish_report"]);
    expect(chat).toHaveBeenCalledTimes(6);
  });
  it("lets NVIDIA repair a non-verbatim report citation without accepting the invalid report", async () => {
    const tools = session("nvidia");
    vi.spyOn(tools, "sources").mockResolvedValue([]);
    const bad = {
      ...report,
      findings: [
        {
          ...report.findings[0],
          citations: [
            {
              sourceId: "10000000-0000-4000-8000-000000000003",
              page: 1,
              quote: "Invented publisher passage",
            },
          ],
        },
      ],
    };
    for (const [index, value] of [bad, report].entries())
      chat.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `final-${index}`,
                  type: "function",
                  function: { name: "finish_report", arguments: JSON.stringify(value) },
                },
              ],
            },
          },
        ],
      });
    expect((await runModel(tools)).report).toEqual(report);
    expect(chat.mock.calls[1][0].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "final-0",
        content: expect.stringContaining("does not resolve"),
      }),
    );
  });
  it("returns bounded field-level schema feedback so NVIDIA can repair an invalid commercial report", async () => {
    const tools = session("nvidia");
    tools.run.agentId = "deal-coordination";
    tools.run.input.agentId = "deal-coordination";
    vi.spyOn(tools, "sources").mockResolvedValue([]);
    const trace = vi.spyOn(tools, "trace").mockResolvedValue(undefined);
    const bad = {
      ...report,
      summary: "x".repeat(4001),
      findings: [{ ...report.findings[0], severity: "warning" }],
    };
    for (const [index, value] of [bad, report].entries())
      chat.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `schema-${index}`,
                  type: "function",
                  function: { name: "finish_report", arguments: JSON.stringify(value) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    expect((await runModel(tools)).report).toEqual(report);
    expect(chat).toHaveBeenCalledTimes(2);
    const repair = trace.mock.calls[0][2] as { schemaIssues: { path: string; message: string }[] };
    expect(repair.schemaIssues.map((issue) => issue.path)).toEqual([
      "summary",
      "findings.0.severity",
    ]);
    expect(repair.schemaIssues.every((issue) => issue.message.length <= 240)).toBe(true);
    expect(JSON.stringify(chat.mock.calls[0][0].messages)).toContain("3–6 focused findings");
    expect(JSON.stringify(chat.mock.calls[1][0].messages)).toContain("schemaIssues");
  });
});
