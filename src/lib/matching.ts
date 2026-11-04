import type { Aircraft, Requirement } from "./schema";

type Result = "pass" | "fail" | "unknown";
export type MatchCheck = { label: string; detail: string; result: Result };
export type AircraftMatch = {
  aircraft: Aircraft;
  requirement: Requirement;
  checks: MatchCheck[];
  state: "eligible" | "needs-review" | "excluded";
  score: number | null;
};
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const designation = (value: string) =>
  value
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

function aircraftFamily(aircraft: Aircraft, requirement: Requirement): Result {
  if (aircraft.category !== requirement.category) return "fail";

  const maker = designation(aircraft.manufacturer);
  // Strip only this recorded manufacturer's complete prefix. A buyer's explicit
  // different manufacturer must remain part of the comparison and fail.
  const withoutMaker = (value: string) =>
    value.startsWith(`${maker} `) ? value.slice(maker.length + 1) : value;
  const model = withoutMaker(designation(aircraft.model));
  const requested = withoutMaker(designation(requirement.aircraftModel));
  if (!model || !requested || requested === maker || model === maker) return "unknown";
  if (/[/|,]/.test(requested) || /\bor\b/.test(requested)) return "unknown";
  if (model === requested) return "pass";

  // Expand a complete literal family across an explicit numeric variant boundary,
  // including shorter codes such as ATR 72. The entire left side must match.
  const variant = /^([a-z]*\d+)-\d+$/.exec(model);
  if (variant?.[1] === requested) return "pass";
  // Named sourcing families such as Falcon or Challenger retain a complete word
  // boundary. This is literal text, not an inferred marketing or ceo/neo alias.
  if (/^[a-z]{3,}(?: [a-z]{3,})*$/.test(requested) && model.startsWith(`${requested} `))
    return "pass";

  // A32, G28 or an incomplete variant can be a truncated brief, never a match.
  return model.startsWith(requested) ? "unknown" : "fail";
}

/** A transparent sourcing filter, not a technical suitability assessment. */
export function evaluateMatch(aircraft: Aircraft, requirement: Requirement): AircraftMatch {
  const checks: MatchCheck[] = [];
  const add = (label: string, result: Result, detail: string) =>
    checks.push({ label, result, detail });
  add(
    "Aircraft family",
    aircraftFamily(aircraft, requirement),
    `${aircraft.manufacturer} ${aircraft.model}`,
  );
  add(
    "Year",
    aircraft.year >= requirement.minYear ? "pass" : "fail",
    `${aircraft.year} · minimum ${requirement.minYear}`,
  );
  const transactionKind = requirement.transactionKind ?? "Sale";
  const offering = aircraft.offering ?? "Sale";
  add(
    "Transaction offering",
    transactionKind === "Not supplied" || offering === "Not supplied"
      ? "unknown"
      : offering === "Sale or lease" || offering === transactionKind
        ? "pass"
        : "fail",
    `Required: ${transactionKind}${requirement.transactionKind === undefined ? " (legacy sale)" : ""} · offered: ${offering}${aircraft.offering === undefined ? " (legacy sale)" : ""}`,
  );
  if (requirement.engine)
    add(
      "Engine",
      aircraft.engine === "Not supplied"
        ? "unknown"
        : normalize(aircraft.engine).startsWith(normalize(requirement.engine))
          ? "pass"
          : "fail",
      `${aircraft.engine} · requires ${requirement.engine}`,
    );
  let comparedAmount: number | null = null;
  let comparedBudget: number | null = null;
  if (transactionKind === "Lease") {
    if (requirement.budget !== null)
      add(
        "Purchase budget on lease brief",
        "unknown",
        "The USD purchase budget cannot establish a lease ceiling. Clarify the purchase field and retain the separate lease amount, currency and rate basis.",
      );
    const rate = aircraft.leaseRate ?? null;
    const ceiling = requirement.leaseBudget ?? null;
    const offeredCurrency = aircraft.leaseCurrency;
    const requiredCurrency = requirement.leaseCurrency;
    const offeredBasis = aircraft.leaseBasis;
    const requiredBasis = requirement.leaseBasis;
    const detail = `Offered rent: ${offeredCurrency ?? "currency not supplied"} ${rate ?? "amount not supplied"} · ${offeredBasis ?? "basis not supplied"}. Lease ceiling: ${requiredCurrency ?? "currency not supplied"} ${ceiling ?? "amount not supplied"} · ${requiredBasis ?? "basis not supplied"}.`;
    if (
      rate === null ||
      ceiling === null ||
      !offeredCurrency ||
      !requiredCurrency ||
      !offeredBasis ||
      !requiredBasis
    )
      add(
        "Lease budget per aircraft",
        "unknown",
        `${detail} Explicit rent, ceiling, currency and rate basis need confirmation.`,
      );
    else if (offeredCurrency !== requiredCurrency || offeredBasis !== requiredBasis)
      add(
        "Lease budget per aircraft",
        "unknown",
        `${detail} Currency and rate basis must match; no conversion is inferred.`,
      );
    else {
      comparedAmount = rate;
      comparedBudget = ceiling;
      add("Lease budget per aircraft", rate <= ceiling ? "pass" : "fail", detail);
    }
  } else if (transactionKind === "Sale" && requirement.budget !== null) {
    comparedAmount = aircraft.price;
    comparedBudget = requirement.budget;
    add(
      "Budget per aircraft",
      aircraft.price === null ? "unknown" : aircraft.price <= requirement.budget ? "pass" : "fail",
      aircraft.price === null
        ? "USD purchase asking price needs confirmation"
        : `USD purchase price $${(aircraft.price / 1e6).toFixed(2)}M · ceiling $${(requirement.budget / 1e6).toFixed(2)}M`,
    );
  }
  if (requirement.deadline !== null)
    add(
      "Delivery window",
      aircraft.availableDate === null
        ? "unknown"
        : aircraft.availableDate <= requirement.deadline
          ? "pass"
          : "fail",
      aircraft.availableDate === null
        ? "Availability date not supplied"
        : `${aircraft.availableDate} · required by ${requirement.deadline}`,
    );
  if (aircraft.availability === "Stale")
    add("Availability freshness", "unknown", "Reconfirm availability before shortlisting");
  if (requirement.status === "Draft")
    add("Buyer requirement", "unknown", "Draft brief needs buyer confirmation");
  const state = checks.some((c) => c.result === "fail")
    ? "excluded"
    : checks.some((c) => c.result === "unknown")
      ? "needs-review"
      : "eligible";
  const agePreference = Math.min(12, Math.max(0, aircraft.year - requirement.minYear) * 2);
  const budgetPreference =
    comparedBudget !== null && comparedAmount !== null
      ? Math.min(8, Math.max(0, ((comparedBudget - comparedAmount) / comparedBudget) * 40))
      : 0;
  return {
    aircraft,
    requirement,
    checks,
    state,
    score: state === "eligible" ? Math.round(80 + agePreference + budgetPreference) : null,
  };
}

export function getMatches(aircraft: Aircraft[], requirements: Requirement[]) {
  const unique = new Map(
    aircraft.map((item) => [`${normalize(item.manufacturer)}:${normalize(item.serial)}`, item]),
  );
  const order = { eligible: 0, "needs-review": 1, excluded: 2 };
  return [...unique.values()]
    .flatMap((item) => requirements.map((requirement) => evaluateMatch(item, requirement)))
    .sort((a, b) => order[a.state] - order[b.state] || (b.score ?? 0) - (a.score ?? 0));
}
