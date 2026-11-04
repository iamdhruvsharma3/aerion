import { describe, expect, it } from "vitest";
import { publicAddress, connectorUrl, connectorText } from "./collector";
import {
  fingerprint,
  reportRepairPassages,
  validateCitations,
  validateProposedFacts,
} from "./evidence";
import { agentCatalog, agentIds } from "../../lib/agents/catalog";
import { actionAllowed } from "./repository";
import { reportSchema } from "../../lib/agents/schema";
const sourceId = "10000000-0000-4000-8000-000000000001";
describe("Agent evidence and tool boundaries", () => {
  it("defines twelve unique roles with bounded grants", () => {
    expect(agentCatalog.map((a) => a.id)).toEqual([...agentIds]);
    expect(new Set(agentCatalog.map((a) => a.id)).size).toBe(12);
    for (const a of agentCatalog) {
      expect(a.tools).toContain("workspace_context");
      expect(a.tools).not.toContain("send_email");
    }
  });
  it("canonicalizes object order without changing array order or meaning", () => {
    expect(fingerprint({ b: 2, a: { c: 3, d: 4 } })).toBe(fingerprint({ a: { d: 4, c: 3 }, b: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });
  it("rejects citations outside retained passages and incorrect page numbers", () => {
    const sources = [
      { id: sourceId, pages: [{ page: 1, text: "Year: 2015\nPrice USD: 21500000" }] },
    ];
    expect(() =>
      validateCitations([{ sourceId, page: 1, quote: "Year: 2015" }], sources),
    ).not.toThrow();
    expect(() => validateCitations([{ sourceId, page: 2, quote: "Year: 2015" }], sources)).toThrow(
      "citation",
    );
    expect(() => validateCitations([{ sourceId, page: 1, quote: "Year: 2020" }], sources)).toThrow(
      "citation",
    );
  });
  it("repairs the actual misquoted authorized page beyond the first five sources without accepting the bad quote", () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      pages: [{ page: 2, text: `Original source ${index}: named title review is pending.` }],
    }));
    const citation = {
      sourceId: sources[7].id,
      page: 2,
      quote: "Invented metadata summary appended to the original.",
    };
    const report = reportSchema.parse({
      summary: "Fictional diagnostic regression",
      findings: [
        { title: "Title", detail: "Review pending", severity: "review", citations: [citation] },
      ],
      limitations: [],
    });
    expect(() => validateCitations([citation], sources)).toThrow("citation");
    const hints = reportRepairPassages(report, sources);
    expect(hints).toEqual([
      {
        sourceId: sources[7].id,
        page: 2,
        quote: sources[7].pages[0].text,
        more: false,
        totalCharacters: sources[7].pages[0].text.length,
      },
    ]);
    expect(() => validateCitations(hints, sources)).not.toThrow();
    expect(() => validateCitations([citation], sources)).toThrow("citation");
  });
  it("does not substitute unrelated pages for missing, foreign or already valid report citations", () => {
    const sources = [{ id: sourceId, pages: [{ page: 1, text: "Original supported passage" }] }];
    const report = reportSchema.parse({
      summary: "Fictional diagnostic regression",
      findings: [
        {
          title: "Scoped evidence",
          detail: "Review",
          severity: "review",
          citations: [
            { sourceId, page: 1, quote: "Original supported passage" },
            { sourceId, page: 2, quote: "Absent page" },
            { sourceId: "20000000-0000-4000-8000-000000000001", page: 1, quote: "Foreign source" },
          ],
        },
      ],
      limitations: [],
    });
    expect(reportRepairPassages(report, sources)).toEqual([]);
  });
  it("bounds diagnostic passages and deduplicates a repeated misquoted page", () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      pages: [{ page: 1, text: "Actual retained text. ".repeat(100) }],
    }));
    const citations = sources.map((source) => ({
      sourceId: source.id,
      page: 1,
      quote: "Invalid quoted text",
    }));
    const report = reportSchema.parse({
      summary: "Fictional bounded diagnostic",
      findings: [
        {
          title: "Evidence",
          detail: "Review",
          severity: "review",
          citations: [citations[0], ...citations],
        },
      ],
      limitations: [],
    });
    const hints = reportRepairPassages(report, sources);
    expect(hints).toHaveLength(5);
    expect(new Set(hints.map((item) => item.sourceId)).size).toBe(5);
    expect(
      hints.every((item) => item.quote.length === 1500 && item.more && item.totalCharacters > 1500),
    ).toBe(true);
    expect(reportRepairPassages(null, sources)).toHaveLength(5);
  });
  it("does not treat a mentioned number as a different numeric value", () => {
    expect(() =>
      validateProposedFacts(
        {
          type: "comparable",
          sourceId,
          manufacturer: "Airbus",
          model: "A319",
          year: 2015,
          amountUsd: 21500000,
          basis: "Asking price",
          reportedOn: "2026-01-01",
          notes: "",
        },
        [
          {
            sourceId,
            page: 1,
            quote: "Airbus A319 · 2015 · Asking price USD 121500000 · 2026-01-01",
          },
        ],
      ),
    ).toThrow("not stated");
  });
  it("restricts role actions and never grants confirmation or verification", () => {
    const action = {
      type: "execution" as const,
      requirementId: "r",
      action: {
        type: "prepare-draft" as const,
        aircraftId: "a",
        contactId: "c",
        audience: "Buyer" as const,
      },
    };
    expect(actionAllowed("outreach", action)).toBe(true);
    expect(actionAllowed("matching", action)).toBe(false);
  });
  it("keeps reports structured with bounded evidence", () => {
    expect(
      reportSchema.safeParse({
        summary: "Run",
        findings: [
          { title: "Question", detail: "Who has authority?", severity: "missing", citations: [] },
        ],
        limitations: [],
      }).success,
    ).toBe(true);
  });
});
describe("Public source collection", () => {
  it("rejects private/reserved IPv4, IPv6 and IPv4-mapped ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "192.0.2.1",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(publicAddress(address), address).toBe(false);
    }
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("permits public HTTPS URLs only, without credentials or custom ports", () => {
    for (const url of [
      "http://example.com",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://metadata.internal/",
      "https://example.com:8443/",
      "https://user:secret@example.com/",
      "https://example.com/feed?api_key=dummy-fixture",
    ]) {
      expect(() => connectorUrl(url), url).toThrow();
    }
    expect(connectorUrl("https://example.com/article#fragment").href).toBe(
      "https://example.com/article",
    );
  });
  it("extracts public page text without running scripts or retaining navigation as claims", () => {
    const text = connectorText(
      Buffer.from(
        "<html><body><nav>Not a listing</nav><main><h1>Specification</h1><p>Model: A319</p><p>Year: 2015</p><script>steal()</script></main></body></html>",
      ),
      "page",
      "text/html",
    );
    expect(text).toContain("Model: A319");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("Not a listing");
  });
  it("retains RSS/Atom item text and rejects oversized or binary results", () => {
    const text = connectorText(
      Buffer.from(
        "<rss><channel><item><title>Fictional Company orders 2 A319 aircraft</title><description>&lt;p&gt;Fictional fixture&lt;/p&gt;</description><link>https://example.com/article</link></item></channel></rss>",
      ),
      "feed",
      "application/rss+xml",
    );
    expect(text).toContain("Fictional Company orders 2 A319 aircraft");
    expect(text).toContain("Source URL: https://example.com/article");
    expect(() => connectorText(Buffer.from([0]), "text", "text/plain")).toThrow("binary");
    expect(() => connectorText(Buffer.from("x".repeat(200001)), "text", "text/plain")).toThrow(
      "200,000",
    );
  });
});
