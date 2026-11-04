import { describe, expect, it } from "vitest";
import { boundedMessageIds, parseEmail } from "../agents/email-parser";
import { correlateReply } from "./service";

describe("Reply routing preserves uncertainty", () => {
  it("extracts bounded exact message identifiers and retains reply headers as source statements", async () => {
    const raw = Buffer.from(
      "From: buyer@example.com\r\nTo: founder@example.com\r\nSubject: Fixture reply\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: <sent@example.com>\r\nReferences: <older@example.com>\r\n <sent@example.com>\r\n\r\nFictional current requirement, not a real mandate.",
    );
    const parsed = await parseEmail(raw);
    expect(parsed.messageId).toBe("<reply@example.com>");
    expect(parsed.inReplyTo).toEqual(["<sent@example.com>"]);
    expect(parsed.references).toEqual(["<older@example.com>", "<sent@example.com>"]);
    expect(parsed.direction).toBeNull();
    expect(parsed.text).toContain("In-Reply-To: <sent@example.com>");
    expect(
      boundedMessageIds(
        Array.from({ length: 100 }, (_, i) => `<fixture-${i}@example.com>`).join(" "),
      ),
    ).toHaveLength(80);
  });
  it("only suggests a unique lead when exact reply IDs and both address directions agree", () => {
    const parsed = {
      inReplyTo: ["<sent@example.com>"],
      references: [],
      from: "BUYER@example.com",
      recipients: ["founder@example.com"],
      classification: "Message" as const,
    };
    const deliveries = [
      {
        id: "delivery",
        messageId: "<sent@example.com>",
        sender: "founder@example.com",
        recipient: "buyer@example.com",
        leadId: "lead-a",
      },
    ];
    expect(correlateReply(parsed, deliveries)).toMatchObject({
      state: "Suggested",
      suggestedLeadIds: ["lead-a"],
    });
    expect(correlateReply({ ...parsed, from: "spoof@example.com" }, deliveries)).toMatchObject({
      state: "Unassigned",
      suggestedLeadIds: [],
    });
    expect(
      correlateReply({ ...parsed, recipients: ["unrelated@example.com"] }, deliveries).state,
    ).toBe("Unassigned");
    expect(correlateReply({ ...parsed, classification: "Auto reply" }, deliveries).state).toBe(
      "Unassigned",
    );
    expect(
      correlateReply(parsed, [...deliveries, { ...deliveries[0], leadId: "lead-b" }]),
    ).toMatchObject({ state: "Ambiguous", suggestedLeadIds: ["lead-a", "lead-b"] });
  });
  it("classifies automated responses and delivery reports without turning them into buyer statements", async () => {
    const reply = await parseEmail(
      Buffer.from(
        "From: desk@example.com\r\nTo: founder@example.com\r\nSubject: Automatic reply\r\nAuto-Submitted: auto-replied\r\n\r\nOut of office.",
      ),
    );
    expect(reply.classification).toBe("Auto reply");
    const report = await parseEmail(
      Buffer.from(
        "From: postmaster@example.com\r\nTo: founder@example.com\r\nSubject: Delivery status\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nFictional failure.\r\n--fixture--",
      ),
    );
    expect(report.classification).toBe("Delivery report");
  });
});
