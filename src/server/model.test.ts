import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMarketWithModel, extractWithModel } from "./model";
const { parse, chat } = vi.hoisted(() => ({ parse: vi.fn(), chat: vi.fn() }));
vi.mock("./agents/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents/providers")>()),
  modelClient: () => ({ responses: { parse }, chat: { completions: { create: chat } } }),
}));
const pages = [{ page: 1, text: "Fictional contract source. Model: A319" }];
beforeEach(() => {
  parse.mockReset();
  chat.mockReset();
});
describe("Structured extraction provider contracts", () => {
  it("supports numeric lease terms and instructs providers to preserve currency and periodic units", async () => {
    parse.mockResolvedValue({
      output_parsed: {
        candidates: [
          {
            facts: [
              {
                field: "leaseRate",
                value: 200000,
                page: 1,
                quote: "Lease rate EUR per month: 200000",
              },
            ],
          },
        ],
      },
    });
    const result = await extractWithModel(
      [{ page: 1, text: "Lease rate EUR per month: 200000" }],
      "fixture-model",
    );
    expect(result.candidates[0].facts[0]).toMatchObject({ field: "leaseRate", value: 200000 });
    expect(parse.mock.calls[0][0].input[0].content).toContain("monthly/hourly rent");
    expect(parse.mock.calls[0][0].input[0].content).toContain("leaseCurrency");
  });
  it("uses bounded, non-stored Responses extraction without tools", async () => {
    parse.mockResolvedValue({ output_parsed: { candidates: [] } });
    expect(await extractWithModel(pages, "fixture-model")).toEqual({ candidates: [] });
    const request = parse.mock.calls[0][0];
    expect(request.store).toBe(false);
    expect(request.max_output_tokens).toBe(12000);
    expect(request.tools).toBeUndefined();
    expect(request.input[1].content).toContain("Fictional contract source");
  });
  it("supports local model structured aircraft and market outputs", async () => {
    chat
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"candidates":[]}' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"signals":[]}' } }] });
    expect(await extractWithModel(pages, "fixture", "ollama")).toEqual({ candidates: [] });
    expect(await extractMarketWithModel(pages, "fixture", "ollama")).toEqual({ signals: [] });
    expect(chat.mock.calls[0][0].response_format.type).toBe("json_schema");
    expect(parse).not.toHaveBeenCalled();
  });
  it("supports market Responses and refuses incomplete output without fallback", async () => {
    parse
      .mockResolvedValueOnce({ output_parsed: { signals: [] } })
      .mockResolvedValueOnce({ output_parsed: null });
    expect(await extractMarketWithModel(pages, "fixture", "openai")).toEqual({ signals: [] });
    await expect(extractWithModel(pages, "fixture")).rejects.toThrow("complete extraction");
    expect(chat).not.toHaveBeenCalled();
  });
  it("rejects malformed local provider output", async () => {
    chat.mockResolvedValue({ choices: [{ message: { content: '{"candidates":"invented"}' } }] });
    await expect(extractWithModel(pages, "fixture", "ollama")).rejects.toThrow();
  });
});

describe("NVIDIA extraction contract", () => {
  it("uses the NVIDIA token and reasoning options for aircraft and market extraction", async () => {
    chat
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"candidates":[]}' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"signals":[]}' } }] });
    expect(await extractWithModel(pages, "fixture", "nvidia")).toEqual({ candidates: [] });
    expect(await extractMarketWithModel(pages, "fixture", "nvidia")).toEqual({ signals: [] });
    expect(chat.mock.calls[0][0]).toMatchObject({
      max_tokens: 12000,
      reasoning_effort: "none",
      response_format: { type: "json_schema" },
    });
    expect(chat.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens");
  });
  it("requires numeric aircraft and quantity values without silently coercing model strings", async () => {
    chat.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                { facts: [{ field: "year", value: "2015", page: 1, quote: "Year: 2015" }] },
              ],
            }),
          },
        },
      ],
    });
    await expect(
      extractWithModel([{ page: 1, text: "Year: 2015" }], "fixture", "nvidia"),
    ).rejects.toThrow();
    chat.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              signals: [
                {
                  facts: [
                    {
                      field: "quantity",
                      value: "2",
                      page: 1,
                      quote: "Quantity: 2",
                      method: "model",
                    },
                  ],
                },
              ],
            }),
          },
        },
      ],
    });
    await expect(
      extractMarketWithModel([{ page: 1, text: "Quantity: 2" }], "fixture", "nvidia"),
    ).rejects.toThrow();
    chat.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                { facts: [{ field: "year", value: 2015, page: 1, quote: "Year: 2015" }] },
              ],
            }),
          },
        },
      ],
    });
    expect(
      (await extractWithModel([{ page: 1, text: "Year: 2015" }], "fixture", "nvidia")).candidates[0]
        .facts[0].value,
    ).toBe(2015);
  });
});
