import { extractLocally } from "../intelligence/extract";
import { validateEvidence } from "../intelligence/schema";
import { extractMarketLocally, validateMarketEvidence } from "../intelligence/market-extract";
import { publicMarketFixtures } from "../intelligence/market-fixtures";
import { workflowFixtures, workflowSource, edgeFixtures } from "./fixtures";
export function evaluateCorpus() {
  const cases = [
    ...workflowFixtures.map((f, i) => ({
      name: `Fictional ${f.category}: ${f.model}`,
      text: workflowSource(f, `EVAL-${i + 1}`),
      expected: {
        manufacturer: f.manufacturer,
        model: f.model,
        serial: `EVAL-${i + 1}`,
        category: f.category,
        year: f.year,
        engine: f.engine,
        price: f.price,
        location: "Fictional location",
        country: "Fictional country",
        availableDate: "2027-03-01",
      } as Record<string, string | number>,
      conflict: false,
      abstain: false,
    })),
    ...edgeFixtures,
  ];
  const results = cases.map((f) => {
    const pages = [{ page: 1, text: f.text }];
    let values: Record<string, unknown> = {},
      evidence = 0,
      facts = 0,
      conflict = false,
      abstained = false;
    try {
      const parsed = validateEvidence(extractLocally(pages, "text"), pages);
      values = Object.assign({}, ...parsed.map((p) => p.values));
      conflict = parsed.some((p) => p.warnings.some((w) => w.includes("conflicting values")));
      const retained = parsed.flatMap((p) => p.facts);
      facts = retained.length;
      evidence = retained.filter((p) =>
        pages.some((page) => page.page === p.page && page.text.includes(p.quote)),
      ).length;
    } catch {
      abstained = true;
    }
    const correct = Object.entries(values).filter(
      ([key, value]) => f.expected[key as keyof typeof f.expected] === value,
    ).length;
    const expected = Object.keys(f.expected).length,
      extracted = Object.keys(values).length;
    return {
      name: f.name,
      expected,
      extracted,
      correct,
      facts,
      evidence,
      passed:
        correct === expected &&
        extracted === expected &&
        conflict === Boolean(f.conflict) &&
        abstained === Boolean(f.abstain),
      abstained,
    };
  });
  const publicResults = publicMarketFixtures.map((f) => {
    const pages = [{ page: 1, text: f.excerpt }];
    try {
      const parsed = validateMarketEvidence(extractMarketLocally(pages, "text"), pages);
      const values = parsed[0]?.values;
      const passed =
        Boolean(f.expected) &&
        JSON.stringify(Object.entries(values ?? {}).sort()) ===
          JSON.stringify(Object.entries(f.expected ?? {}).sort()) &&
        parsed.every((s) => s.facts.every((fact) => f.excerpt.includes(fact.quote)));
      return { name: f.title, passed, abstained: false };
    } catch {
      return { name: f.title, passed: f.expected === null, abstained: true };
    }
  });
  const sum = (key: "correct" | "extracted" | "expected" | "facts" | "evidence") =>
    results.reduce((n, r) => n + r[key], 0);
  return {
    scope:
      "Engineering fixtures: 18 synthetic cases + 4 short attributed public headlines. Not a market validation or a general extraction benchmark.",
    synthetic: {
      cases: results.length,
      passed: results.filter((r) => r.passed).length,
      correctFields: sum("correct"),
      extractedFields: sum("extracted"),
      expectedFields: sum("expected"),
      precision: sum("correct") / sum("extracted"),
      recall: sum("correct") / sum("expected"),
      passageCoverage: sum("evidence") / sum("facts"),
      abstentions: results.filter((r) => r.abstained).length,
    },
    publicHeadlines: {
      cases: publicResults.length,
      passed: publicResults.filter((r) => r.passed).length,
      abstentions: publicResults.filter((r) => r.abstained).length,
    },
    results,
    publicResults,
  };
}
