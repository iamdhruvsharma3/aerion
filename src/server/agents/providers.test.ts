import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../../lib/agents/schema";
import { nemotronUltraModel } from "../../lib/agents/providers";
import { modelClient, providerConfiguration } from "./providers";
import { AgentTools } from "./tools";
import { runModel } from "./model";
import { probeNvidiaModel } from "./nvidia-probe";
const report = {
  summary: "Fictional NVIDIA transport contract",
  findings: [],
  limitations: ["Mocked HTTP; no live inference"],
};
beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "fixture-nvidia-key");
  vi.stubEnv("NVIDIA_MODEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function transport(messages: object[]) {
  const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      const message = messages.shift();
      if (!message) throw new Error("Unexpected extra model request");
      return Response.json({
        id: "fixture-response",
        object: "chat.completion",
        created: 1,
        model: nemotronUltraModel,
        choices: [{ index: 0, finish_reason: "stop", message }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }),
  );
  return requests;
}
function session() {
  const run: AgentRun = {
    id: "10000000-0000-4000-8000-000000000001",
    agentId: "matching",
    provider: "nvidia",
    model: nemotronUltraModel,
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
      provider: "nvidia",
      requirementId: null,
      aircraftId: null,
      contactId: null,
      sourceIds: [],
      connectorIds: [],
      objective: "Synthetic provider test",
      allowExternalSources: false,
      allowModelData: true,
      allowMailbox: false,
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
    },
  };
  return new AgentTools(
    { actorId: "fixture", workspaceId: "fixture" },
    run,
    new AbortController().signal,
    async () => {},
    async () => {},
  );
}
function tool(name: string) {
  return {
    role: "assistant",
    content: null,
    reasoning_content: "Private provider reasoning fixture",
    tool_calls: [{ id: "test-call", type: "function", function: { name, arguments: "{}" } }],
  };
}
describe("NVIDIA provider and actual SDK transport", () => {
  it("preserves the requested model and requires a server-side key", () => {
    vi.stubEnv("NVIDIA_API_KEY", " ");
    expect(providerConfiguration("nvidia")).toMatchObject({
      ready: false,
      model: nemotronUltraModel,
    });
    expect(() => modelClient("nvidia")).toThrow("NVIDIA_API_KEY");
    expect(JSON.stringify(providerConfiguration("nvidia"))).not.toContain("fixture-nvidia-key");
  });
  it("pins credentials to the NVIDIA endpoint with bounded timeout and no retries", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://untrusted.invalid/v1");
    const client = modelClient("nvidia");
    expect(client.baseURL).toBe("https://integrate.api.nvidia.com/v1");
    expect(client.timeout).toBe(90000);
    expect(client.maxRetries).toBe(0);
  });
  it("executes a tool round trip through the real SDK with NVIDIA request options", async () => {
    const requests = transport([
      tool("workspace_context"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "final-report",
            type: "function",
            function: { name: "finish_report", arguments: JSON.stringify(report) },
          },
        ],
      },
    ]);
    const tools = session(),
      invoke = vi.spyOn(tools, "invoke").mockResolvedValue({ fixture: true });
    expect((await runModel(tools)).usage).toEqual({
      requests: 2,
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(invoke).toHaveBeenCalledWith("workspace_context", {});
    expect(requests[0].url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(requests[0].authorization).toBe("Bearer fixture-nvidia-key");
    expect(requests[0].body).toMatchObject({
      model: nemotronUltraModel,
      max_tokens: 3500,
      reasoning_effort: "none",
      stream: false,
    });
    expect(requests[0].body).not.toHaveProperty("max_completion_tokens");
    expect(requests[0].body).not.toHaveProperty("response_format");
    expect(requests[0].body.tools).toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: "finish_report" }) }),
    );
    expect(JSON.stringify(requests[1].body.messages)).not.toContain("Private provider reasoning");
    expect(requests[1].body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "test-call",
      content: '{"fixture":true}',
    });
  });
  it("validates both live-probe capabilities against synthetic evidence", async () => {
    const requests = transport([
      tool("read_test_fixture"),
      {
        role: "assistant",
        content: JSON.stringify({
          serial: "FICTIONAL-NEMOTRON-01",
          quote: "Serial: FICTIONAL-NEMOTRON-01",
          fictional: true,
        }),
      },
    ]);
    expect(await probeNvidiaModel()).toMatchObject({
      requests: 2,
      toolCalling: "passed",
      structuredOutput: "passed",
      evidenceCheck: "passed",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].body).not.toHaveProperty("response_format");
    expect(requests[1].body).not.toHaveProperty("tools");
    expect(requests[1].body).toMatchObject({ response_format: { type: "json_schema" } });
    expect(JSON.stringify(requests[1].body.messages)).not.toContain("Private provider reasoning");
  });
  it("does not pass the probe when the model avoids tools or invents evidence", async () => {
    transport([{ role: "assistant", content: JSON.stringify(report) }]);
    await expect(probeNvidiaModel()).rejects.toThrow("required test tool call");
    transport([
      tool("read_test_fixture"),
      {
        role: "assistant",
        content: JSON.stringify({
          serial: "ACTUAL-UNSUPPORTED",
          quote: "invented",
          fictional: true,
        }),
      },
    ]);
    await expect(probeNvidiaModel()).rejects.toThrow("synthetic evidence");
  });
  it("rejects a final report mixed with business tools before executing either call", async () => {
    const mixed = tool("workspace_context");
    mixed.tool_calls.push({
      id: "mixed-final",
      type: "function",
      function: { name: "finish_report", arguments: JSON.stringify(report) },
    });
    transport([mixed]);
    const tools = session(),
      invoke = vi.spyOn(tools, "invoke");
    await expect(runModel(tools)).rejects.toThrow("submitted separately");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("rejects malformed NVIDIA final reports instead of accepting a partial result", async () => {
    transport([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "invalid-final",
            type: "function",
            function: { name: "finish_report", arguments: '{"summary":"Incomplete"}' },
          },
        ],
      },
    ]);
    await expect(runModel(session())).rejects.toThrow();
  });
});
