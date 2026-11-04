import type { Claim, DraftInput } from "./schema";
import { leaseTerms } from "../sourcing";
const oneLine = (value: string | number) => String(value).replace(/\s+/g, " ").trim();
/** Local templates only. Free-form notes and document instructions never enter the message. */
export function composeDraft(input: DraftInput) {
  const { aircraft, requirement, contact, claims, audience } = input;
  const kind = requirement.transactionKind ?? "Sale",
    offering = aircraft.offering ?? "Sale";
  if (
    kind === "Not supplied" ||
    offering === "Not supplied" ||
    (offering !== "Sale or lease" && offering !== kind)
  )
    throw new Error(
      "Clarify and confirm matching sale or lease terms before preparing a sourcing draft.",
    );
  if (!claims.length || claims.some((c) => !c.href || !c.quote))
    throw new Error("Every draft claim needs retained evidence.");
  const label = (c: Claim) => {
    if (c.field === "aircraft.leaseRate" && typeof c.value === "number")
      return `${oneLine(c.label)}: ${leaseTerms(c.value, aircraft.leaseCurrency, aircraft.leaseBasis)} per aircraft`;
    if (c.field === "requirement.leaseBudget" && typeof c.value === "number")
      return `${oneLine(c.label)}: ${leaseTerms(c.value, requirement.leaseCurrency, requirement.leaseBasis)} per aircraft`;
    return `${oneLine(c.label)}: ${oneLine(c.value)}${["aircraft.price", "requirement.budget"].includes(c.field) ? " USD per aircraft (purchase)" : ""}`;
  };
  const buyerClaims = claims.filter(
    (c) =>
      c.field.startsWith("requirement.") && !(kind === "Lease" && c.field === "requirement.budget"),
  );
  const aircraftClaims = claims.filter(
    (c) => c.field.startsWith("aircraft.") && !(kind === "Lease" && c.field === "aircraft.price"),
  );
  const subject = oneLine(
    audience === "Buyer"
      ? `${kind} sourcing candidate for your ${requirement.aircraftModel} brief`
      : `Request for current information: ${aircraft.manufacturer} ${aircraft.model}, ${aircraft.serial}`,
  );
  const body = [
    `Hello ${oneLine(contact.name)},`,
    "",
    audience === "Buyer"
      ? "For the buyer brief recorded by the founder:"
      : "We are reviewing a candidate against this buyer brief recorded by the founder:",
    ...buyerClaims.map((c) => `- ${label(c)}`),
    "",
    "The retained aircraft specification and its founder review record report:",
    ...aircraftClaims.map((c) => `- ${label(c)}`),
    "",
    audience === "Buyer"
      ? "Would you like to discuss this candidate and any additional constraints?"
      : "Could you confirm current availability, asking terms, authority to represent the aircraft, and which supporting records can be shared?",
    "Current availability, seller authority, condition and transaction suitability still require confirmation.",
    "",
    "Regards,",
    "Aerion",
  ].join("\n");
  return { subject, body };
}
