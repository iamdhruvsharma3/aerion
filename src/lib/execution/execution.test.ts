import { describe, expect, it } from "vitest";
import { evaluateCorpus } from "./evaluate";
import { calendarDate } from "../format";
import { dueState } from "./schema";

describe("Execution quality checks", () => {
  it("measures retained passages, expected fields, conflict flags and abstentions on the declared corpus", () => {
    const report = evaluateCorpus();
    expect(report.synthetic.cases).toBe(18);
    expect(report.synthetic.passed).toBe(18);
    expect(report.synthetic.precision).toBe(1);
    expect(report.synthetic.recall).toBe(1);
    expect(report.synthetic.passageCoverage).toBe(1);
    expect(report.publicHeadlines).toEqual({ cases: 4, passed: 4, abstentions: 2 });
  });
  it("compares due dates as calendar dates without timezone shifts", () => {
    const action = {
      id: "x",
      kind: "Follow-up" as const,
      title: "test",
      detail: "",
      dueDate: "2026-10-26",
      status: "Open" as const,
      seedKey: null,
    };
    expect(dueState(action, "2026-10-27")).toBe("Overdue");
    expect(dueState(action, "2026-10-26")).toBe("Due today");
    expect(dueState(action, "2026-10-25")).toBe("Upcoming");
    expect(dueState({ ...action, status: "Done" }, "2026-10-27")).toBe("Done");
    expect(dueState({ ...action, dueDate: null }, "2026-10-27")).toBe("No due date");
  });
  it("uses the founder workspace timezone across UTC date boundaries", () => {
    expect(calendarDate(new Date("2026-10-25T18:31:00Z"))).toBe("2026-10-26");
    expect(calendarDate(new Date("2026-10-26T18:29:00Z"))).toBe("2026-10-26");
  });
});
