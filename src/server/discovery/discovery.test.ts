import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoveryInputSchema,
  type DiscoveryInput,
  type LeadValues,
} from "../../lib/discovery/schema";
import type { ProposalAction } from "../../lib/agents/schema";
import { validateProposedFacts, leadCitationHints, validateCitations } from "../agents/evidence";
import { actionAllowed } from "../agents/repository";
import { leadIdentity } from "./identity";
import { parseSearchResults, searchWeb } from "./search";

const input: DiscoveryInput = {
  side: "Seller",
  target: "Airbus A319",
  market: "Any",
  region: "",
  method: "web",
  query: 'Airbus A319 "for sale"',
  urls: [],
  freshness: "year",
};
const values: LeadValues = {
  side: "Seller",
  basis: "Aircraft listing",
  organization: "Fictional Atlas",
  aircraftModel: "Airbus A319",
  geography: null,
  contactName: null,
  email: "fixture@example.com",
  phone: null,
  summary:
    "A fictional source describes an aircraft offered for sale; availability is unconfirmed.",
};
const action: ProposalAction = {
  type: "lead",
  sourceId: randomUUID(),
  resultId: randomUUID(),
  values,
};
const citations = [
  {
    sourceId: action.sourceId,
    page: 1,
    quote:
      "Fictional Atlas offers an Airbus A319 for sale. Contact Fictional Atlas at fixture@example.com.",
  },
];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("Discovery evidence boundaries", () => {
  it("offers exact publisher passages as diagnostics without silently correcting or accepting a proposal", () => {
    const text = `Aircraft for sale\nFalcon 2000\n${"x".repeat(600)}\nRepresented by Fictional Atlas`;
    const source = { id: action.sourceId, pages: [{ page: 1, text }] };
    const proposed: Extract<ProposalAction, { type: "lead" }> = {
      ...action,
      values: { ...values, aircraftModel: "Falcon 2000", email: null },
    };
    const hints = leadCitationHints(proposed, [source]);
    expect(hints.some((hint) => hint.quote.includes("Aircraft for sale"))).toBe(true);
    expect(hints.some((hint) => hint.quote.includes("Fictional Atlas"))).toBe(true);
    expect(() => validateCitations(hints, [source])).not.toThrow();
    expect(() =>
      validateProposedFacts(
        { ...proposed, values: { ...proposed.values, geography: "Any" } },
        hints,
      ),
    ).toThrow(/geography: Any/);
  });
  it("requires a coherent bounded search or URL request", () => {
    expect(discoveryInputSchema.safeParse(input).success).toBe(true);
    expect(discoveryInputSchema.safeParse({ ...input, query: "a ".repeat(76) }).success).toBe(
      false,
    );
    expect(
      discoveryInputSchema.safeParse({ ...input, urls: ["https://example.com"] }).success,
    ).toBe(false);
    expect(
      discoveryInputSchema.safeParse({ ...input, method: "urls", query: "", urls: [] }).success,
    ).toBe(false);
  });
  it("rejects invented contacts, unrelated contacts, snippet-only evidence and unsupported availability", () => {
    expect(() => validateProposedFacts(action, citations)).not.toThrow();
    expect(() => validateProposedFacts(action, [])).toThrow(/citations/);
    expect(() =>
      validateProposedFacts(
        {
          ...action,
          values: { ...values, organization: "Fictional Atlas (broker)", geography: "Any" },
        },
        citations,
      ),
    ).toThrow(/organization: Fictional Atlas \(broker\).*geography: Any/);
    expect(() =>
      validateProposedFacts(
        { ...action, values: { ...values, email: "guessed@example.com" } },
        citations,
      ),
    ).toThrow(/not stated/);
    expect(() =>
      validateProposedFacts(action, [
        { ...citations[0], quote: "Fictional Atlas offers an Airbus A319 for sale." },
        { ...citations[0], quote: "Other Aviation: fixture@example.com" },
      ]),
    ).toThrow(/attributed/);
    expect(() =>
      validateProposedFacts(action, [{ ...citations[0], sourceId: randomUUID() }]),
    ).toThrow(/publisher source/);
    expect(() =>
      validateProposedFacts({ ...action, values: { ...values, email: null } }, [
        { ...citations[0], quote: "Fictional Atlas previously sold an Airbus A319." },
      ]),
    ).toThrow(/availability statement/);
  });
  it.each([
    "available for immediate sale",
    "offered for outright sale",
    "available for immediate dry lease",
    "available for\nlease",
  ])("recognizes explicit availability wording: %s", (phrase) => {
    const quote = `Fictional Atlas offers an Airbus A319 ${phrase}.`;
    const proposed = { ...action, values: { ...values, email: null } };
    expect(() => validateProposedFacts(proposed, [{ ...citations[0], quote }])).not.toThrow();
    const hints = leadCitationHints(proposed, [
      { id: action.sourceId, pages: [{ page: 1, text: quote }] },
    ]);
    expect(hints.some((hint) => hint.quote.includes(phrase))).toBe(true);
  });
  it("keeps fleet activity distinct from stated demand and enforces role ownership", () => {
    const buyer: ProposalAction = {
      ...action,
      values: { ...values, side: "Buyer", basis: "Fleet activity", email: null },
    };
    expect(() =>
      validateProposedFacts(buyer, [
        { ...citations[0], quote: "Fictional Atlas purchased an Airbus A319." },
      ]),
    ).not.toThrow();
    expect(() =>
      validateProposedFacts({ ...buyer, values: { ...buyer.values, basis: "Stated demand" } }, [
        { ...citations[0], quote: "Fictional Atlas purchased an Airbus A319." },
      ]),
    ).toThrow(/procurement/);
    expect(actionAllowed("buyer-discovery", buyer)).toBe(true);
    expect(actionAllowed("aircraft-discovery", buyer)).toBe(false);
    expect(actionAllowed("crm", buyer)).toBe(false);
  });
  it("deduplicates recaptured pages without using generated summaries or tracking parameters", () => {
    const id = leadIdentity("https://example.com/listing?utm_source=search", values);
    expect(
      leadIdentity("https://example.com/listing", {
        ...values,
        basis: "Business profile",
        summary: "A different generated summary.",
      }),
    ).toBe(id);
    expect(
      leadIdentity("https://example.com/listing", { ...values, organization: "Other Company" }),
    ).not.toBe(id);
  });
});
describe("Brave Search adapter", () => {
  it("normalizes and bounds results while discarding private, credentialed and duplicate URLs", () => {
    const raw = {
      web: {
        results: [
          { url: "http://127.0.0.1/", title: "Private" },
          { url: "https://public.example.com/?api_key=secret", title: "Credential" },
          ...Array.from({ length: 10 }, (_, i) => ({
            url: `https://public.example.com/${i}`,
            title: `Result ${i}`,
            description: "Routing metadata only",
          })),
        ],
      },
    };
    expect(parseSearchResults(raw)).toHaveLength(6);
    expect(
      parseSearchResults({
        web: {
          results: [
            { url: "https://example.com/#a", title: "A" },
            { url: "https://example.com/#b", title: "B" },
          ],
        },
      }),
    ).toHaveLength(1);
    expect(parseSearchResults({ web: null })).toEqual([]);
  });
  it("pins credentials to the documented endpoint and retains exact response bytes", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fake-test-token");
    const original = JSON.stringify({
      web: { results: [{ url: "https://example.com/aircraft", title: "Aircraft" }] },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(original, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb(input, new AbortController().signal);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe("https://api.search.brave.com");
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe(input.query);
    expect(url.searchParams.get("freshness")).toBe("py");
    expect(url.searchParams.has("token")).toBe(false);
    expect(options.redirect).toBe("error");
    expect(options.headers["X-Subscription-Token"]).toBe("fake-test-token");
    expect(result.original.toString()).toBe(original);
    expect(result.results[0].url).toBe("https://example.com/aircraft");
  });
  it("does not retry or expose provider response bodies on account errors", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fake-test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("sensitive-provider-body", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchWeb(input, new AbortController().signal)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("bounds large responses and requires a separately configured search key", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fake-test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(2_000_001), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchWeb(input, new AbortController().signal)).rejects.toThrow(/2 MB/);
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    await expect(searchWeb(input, new AbortController().signal)).rejects.toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
