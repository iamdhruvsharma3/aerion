import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo-data";
import { importAircraft, parseCsv, sampleCsv } from "./import";

describe("structured inventory import", () => {
  it("accepts a valid template and preserves numeric fields", () => {
    const [aircraft] = importAircraft(sampleCsv, [], "2026-10-23");
    expect(aircraft.price).toBe(21_500_000);
    expect(aircraft.source).toBe("CSV import");
  });
  it("handles quoted commas, escaped quotes and newlines", () => {
    expect(parseCsv('name,note\r\n"Acme, Ltd","Says ""hello""\nand goodbye"')).toEqual([
      ["name", "note"],
      ["Acme, Ltd", 'Says "hello"\nand goodbye'],
    ]);
  });
  it("rejects malformed CSV before creating records", () => {
    expect(() => parseCsv('a,b\n"unclosed,b')).toThrow("not closed");
    expect(() => importAircraft("manufacturer,year\nAirbus,2015", [], "2026-10-23")).toThrow(
      "Missing required column",
    );
  });
  it("rejects duplicate identities across the whole import", () => {
    const imported = importAircraft(sampleCsv, [], "2026-10-23");
    expect(() => importAircraft(sampleCsv, imported, "2026-10-23")).toThrow("already exists");
    expect(demoWorkspace.aircraft).toHaveLength(8);
  });
  it("keeps a blank price unknown", () => {
    expect(importAircraft(sampleCsv.replace("21500000", ""), [], "2026-10-23")[0].price).toBeNull();
  });
  it("rejects impossible dates and negative prices", () => {
    expect(() =>
      importAircraft(sampleCsv.replace("2027-03-01", "2027-02-31"), [], "2026-10-23"),
    ).toThrow();
    expect(() => importAircraft(sampleCsv.replace("21500000", "-1"), [], "2026-10-23")).toThrow();
  });
});
