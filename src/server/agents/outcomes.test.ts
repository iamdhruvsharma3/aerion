import { describe, it, expect } from "vitest";
import { validateActionClaim } from "./outcomes";
const report = (summary: string) => ({ summary, findings: [], limitations: [] });
describe("Agent report action ledger", () => {
  it("rejects an asserted record proposal unsupported by any staged action", () => {
    expect(() =>
      validateActionClaim(
        report("Proposed one comparable record from the retained asking observation."),
        0,
      ),
    ).toThrow("no validated proposal");
    expect(() => validateActionClaim(report("I have created a contact record."), 0)).toThrow(
      "no validated proposal",
    );
  });
  it("preserves honest analysis, missing information and actual staged actions", () => {
    expect(
      validateActionClaim(report("No comparable was proposed because currency is missing."), 0)
        .summary,
    ).toContain("No comparable");
    expect(
      validateActionClaim(report("The source states a proposed purchase. No action was staged."), 0)
        .summary,
    ).toContain("source states");
    expect(
      validateActionClaim(report("Proposed one comparable record for review."), 1).summary,
    ).toContain("Proposed");
  });
});
