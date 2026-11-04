import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { suggestedQuery } from "../../lib/discovery/schema";
import { proposalActionSchema, runInputSchema } from "../../lib/agents/schema";
import { validateProposedFacts } from "../agents/evidence";
import { connectorText } from "../agents/collector";
import { validateLeadAction } from "./guards";

describe("Buyer qualification boundaries", () => {
  it("targets wanted pages without disguising fleet signals as open demand", async () => {
    expect(suggestedQuery("Buyer", "Challenger 350", "")).toContain('"Challenger 350" "wanted" OR "Challenger 350" "acquisition mandates"');
    expect(suggestedQuery("Buyer", "Airbus A320", "", "Fleet")).toContain("fleet expansion");
    const input = runInputSchema.parse({
      agentId: "buyer-discovery",
      provider: "rules",
      sourceIds: [],
      connectorIds: [],
      requirementId: null,
      aircraftId: null,
      contactId: null,
      objective: "Fixture",
      allowExternalSources: true,
      allowModelData: false,
      idempotencyKey: randomUUID(),
      discovery: {
        side: "Buyer",
        target: "Airbus A319",
        market: "Any",
        region: "",
        method: "web",
        query: "Airbus A319 wanted",
        urls: [],
        freshness: "any",
        buyerIntent: "Demand",
      },
    });
    const action = proposalActionSchema.parse({
      type: "lead",
      resultId: randomUUID(),
      sourceId: randomUUID(),
      values: {
        side: "Buyer",
        basis: "Fleet activity",
        organization: "Fictional Buyer",
        aircraftModel: "Airbus A319",
        geography: null,
        contactName: null,
        email: null,
        phone: null,
        summary: "Fictional fleet activity is not an open acquisition requirement.",
      },
    });
    await expect(
      validateLeadAction(
        {} as PoolClient,
        { actorId: randomUUID(), workspaceId: randomUUID() },
        randomUUID(),
        input,
        action,
      ),
    ).rejects.toThrow(/Stated demand/);
  });
  it("requires an attributed exact business contact instead of a guessed or publisher email", () => {
    const sourceId = randomUUID();
    const action = proposalActionSchema.parse({
      type: "lead-enrichment",
      leadId: randomUUID(),
      resultId: randomUUID(),
      sourceId,
      values: {
        organization: "Fictional Buyer",
        contactName: "Acquisitions Desk",
        email: "fixture@example.com",
        phone: null,
        geography: "India",
        summary: "Published business desk; relationship and address control remain unverified.",
      },
    });
    const quote = "Fictional Buyer · Acquisitions Desk · India · fixture@example.com";
    expect(() => validateProposedFacts(action, [{ sourceId, page: 1, quote }])).not.toThrow();
    expect(() =>
      validateProposedFacts(action, [
        { sourceId, page: 1, quote: "Fictional Buyer · Acquisitions Desk · India" },
        { sourceId, page: 1, quote: "Publisher support fixture@example.com" },
      ]),
    ).toThrow(/together/);
    expect(() =>
      validateProposedFacts(action, [{ sourceId: randomUUID(), page: 1, quote }]),
    ).toThrow(/inspected/);
  });
  it("retains published contact-link attributes and company identity in contact-page mode", () => {
    const html = Buffer.from(
      '<html><head><title>Fictional Buyer · Contact</title></head><body><header>Fictional Buyer</header><main><h1>Business enquiries</h1></main><footer>Fictional Buyer Acquisitions Desk <a href="mailto:fixture%40example.com?subject=Test">Email us</a><a href="tel:+15555550123">Call</a></footer><script>secret()</script></body></html>',
    );
    const text = connectorText(html, "page", "text/html", { businessContacts: true });
    expect(text).toContain("Publisher page title: Fictional Buyer · Contact");
    expect(text).toContain("fixture@example.com");
    expect(text).toContain("+15555550123");
    expect(text).not.toContain("secret()");
    expect(connectorText(html, "page", "text/html")).not.toContain("fixture@example.com");
  });
});
