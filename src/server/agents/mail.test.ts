import { describe, expect, it } from "vitest";
import { parseEmail } from "./email-parser";
const raw = Buffer.from(
  'From: Seller <seller@example.com>\r\nTo: founder@example.com\r\nSubject: =?UTF-8?B?QTMyMCBhdmFpbGFiaWxpdHk=?=\r\nDate: Thu, 29 Oct 2026 22:00:00 +0000\r\nMessage-ID: <fixture@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Model: A320</p><p>Current availability needs confirmation.</p><script>ignoreRules()</script><img src="https://example.com/pixel"></body></html>',
);
describe("Retained email parsing", () => {
  it("decodes headers, preserves source statements and derives routing only from the configured account", async () => {
    const parsed = await parseEmail(raw, "founder@example.com");
    expect(parsed.subject).toBe("A320 availability");
    expect(parsed.direction).toBe("Inbound");
    expect(parsed.contactEmail).toBe("seller@example.com");
    expect(parsed.occurredOn).toBe("2026-10-30");
    expect(parsed.text).toContain("Model: A320");
    expect(parsed.text).not.toContain("ignoreRules()");
    expect(parsed.text).not.toContain("<img");
    expect(parsed.text).toContain("does not authenticate identity");
  });
  it("leaves direction unknown for an unassociated manual upload", async () => {
    const parsed = await parseEmail(raw);
    expect(parsed.direction).toBeNull();
    expect(parsed.contactEmail).toBeNull();
    expect(parsed.text).toContain("Direction: Not established");
  });
  it("enforces byte limits before MIME parsing", async () => {
    await expect(parseEmail(Buffer.alloc(2000001))).rejects.toMatchObject({ status: 413 });
  });
});
