import { money } from "./format";
import type { Aircraft, Requirement } from "./schema";

const number = (amount: number) => {
  const value = String(amount);
  if (/e/i.test(value)) return value;
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
};

export function leaseTerms(
  amount: number | null | undefined,
  currency: string | null | undefined,
  basis: Aircraft["leaseBasis"],
) {
  const unit =
    basis === "Monthly rent"
      ? "month"
      : basis === "Hourly rate"
        ? "flight hour"
        : "basis unconfirmed";
  return `${amount == null ? "Rate not supplied" : number(amount)} ${currency ?? "currency unconfirmed"} / ${unit}`;
}

export function aircraftTerms(aircraft: Aircraft) {
  const offering = aircraft.offering ?? "Sale";
  if (offering === "Not supplied") return "Sale / lease terms unconfirmed";
  const sale =
    aircraft.price == null
      ? "Purchase price not supplied"
      : `${money(aircraft.price)} USD purchase price`;
  const lease = leaseTerms(aircraft.leaseRate, aircraft.leaseCurrency, aircraft.leaseBasis);
  return offering === "Sale" ? sale : offering === "Lease" ? lease : `${sale} · Lease: ${lease}`;
}

export function requirementTerms(requirement: Requirement) {
  const kind = requirement.transactionKind ?? "Sale";
  if (kind === "Not supplied") return "Sale / lease requirement unconfirmed";
  if (kind === "Lease")
    return `Lease ceiling: ${leaseTerms(requirement.leaseBudget, requirement.leaseCurrency, requirement.leaseBasis)} per aircraft`;
  return requirement.budget == null
    ? "Purchase budget not supplied"
    : `${money(requirement.budget)} USD purchase ceiling per aircraft`;
}

/** Each form submits only the amount fields for its selected commercial basis. */
export function readRequirementTerms(form: Pick<FormData, "get">) {
  const transactionKind = String(form.get("transactionKind") ?? "Not supplied") as NonNullable<
    Requirement["transactionKind"]
  >;
  const amount = (field: string) => (form.get(field) ? Number(form.get(field)) : null);
  return {
    transactionKind,
    budget: transactionKind === "Sale" ? amount("budget") : null,
    leaseBudget: transactionKind === "Lease" ? amount("leaseBudget") : null,
    leaseCurrency:
      transactionKind === "Lease"
        ? String(form.get("leaseCurrency") ?? "")
            .trim()
            .toUpperCase() || null
        : null,
    leaseBasis:
      transactionKind === "Lease"
        ? (String(form.get("leaseBasis") ?? "") as NonNullable<Requirement["leaseBasis"]>) || null
        : null,
  };
}
