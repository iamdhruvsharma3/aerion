import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Aircraft, Contact, Requirement } from "../lib/schema";
import { factSchema } from "../lib/intelligence/schema";
import { confirmationSchema } from "../lib/intelligence/market-schema";
import type { BriefConfirmation, Claim } from "../lib/execution/schema";
import { composeDraft } from "../lib/execution/drafts";
import type { Scope } from "./db";
import { HttpError } from "./http";

export async function resolveConfirmation(
  db: PoolClient,
  scope: Scope,
  requirement: Requirement,
  recorded: unknown,
): Promise<BriefConfirmation | null> {
  if (requirement.intelligence) {
    const { rows } = await db.query(
      "select confirmation from aerion.signals where id=$1 and workspace_id=$2 and requirement_id=$3 and stage='Confirmed requirement'",
      [requirement.intelligence.signalId, scope.workspaceId, requirement.id],
    );
    if (rows[0]?.confirmation)
      return {
        ...confirmationSchema.parse(rows[0].confirmation),
        origin: "signal",
        href: `/intelligence?signal=${requirement.intelligence.signalId}`,
      };
  }
  const result = confirmationSchema.safeParse(recorded);
  return result.success
    ? {
        ...result.data,
        origin: "execution",
        href: `/execution?requirement=${encodeURIComponent(requirement.id)}`,
      }
    : null;
}
export async function draftMaterial(
  db: PoolClient,
  scope: Scope,
  aircraft: Aircraft,
  requirement: Requirement,
  contact: Contact,
  confirmation: BriefConfirmation,
  audience: "Buyer" | "Seller",
) {
  const kind = requirement.transactionKind ?? "Sale",
    offering = aircraft.offering ?? "Sale";
  if (
    kind === "Not supplied" ||
    offering === "Not supplied" ||
    (offering !== "Sale or lease" && offering !== kind)
  )
    throw new HttpError(
      422,
      "Clarify and confirm matching sale or lease terms before preparing a sourcing draft.",
    );
  if (kind === "Lease" && requirement.budget !== null)
    throw new HttpError(
      422,
      "Requalify the lease brief with lease-only budget terms; a purchase budget cannot serve as its lease ceiling.",
    );
  if (
    kind === "Lease" &&
    (!requirement.leaseCurrency ||
      !requirement.leaseBasis ||
      !aircraft.leaseCurrency ||
      !aircraft.leaseBasis)
  )
    throw new HttpError(
      422,
      "Confirm the buyer's lease currency and rate basis and the aircraft's asking lease terms before drafting.",
    );
  if (!aircraft.evidence)
    throw new HttpError(
      422,
      "This aircraft needs an approved source review before a draft can be prepared.",
    );
  const { rows } = await db.query(
    "select * from aerion.reviews where id=$1 and workspace_id=$2 and aircraft_id=$3 and source_id=$4 and extraction_id=$5 and status='approved'",
    [
      aircraft.evidence.reviewId,
      scope.workspaceId,
      aircraft.id,
      aircraft.evidence.sourceId,
      aircraft.evidence.extractionId,
    ],
  );
  const review = rows[0];
  if (!review) throw new HttpError(422, "The aircraft's approved evidence could not be resolved.");
  const facts = z.array(factSchema).parse(review.facts);
  const claims: Claim[] = [];
  const labels = {
    manufacturer: "Manufacturer",
    model: "Model",
    serial: "Serial",
    year: "Build year",
    engine: "Engine",
    price: "Reported asking purchase price",
    offering: "Recorded aircraft offering",
    leaseRate: "Reported asking lease rate",
    leaseCurrency: "Recorded lease currency",
    leaseBasis: "Recorded lease rate basis",
    availableDate: "Reported availability date",
    location: "Location",
    country: "Country",
  } as const;
  for (const field of Object.keys(labels) as (keyof typeof labels)[]) {
    if ((kind === "Lease" && field === "price") || (kind !== "Lease" && field.startsWith("lease")))
      continue;
    const value = aircraft[field];
    if (value == null || value === "Not supplied") continue;
    const fact = facts.find((f) => f.field === field && f.value === value);
    if (!fact && !review.note) continue;
    claims.push({
      field: `aircraft.${field}`,
      label: labels[field],
      value,
      attribution: fact ? "Source-reported" : "Founder-reviewed correction",
      href: `/sources?review=${aircraft.evidence.reviewId}`,
      sourceId: aircraft.evidence.sourceId,
      quote: fact?.quote ?? review.note,
      page: fact?.page ?? null,
    });
  }
  if (
    !["manufacturer", "model", "serial", "year"].every((field) =>
      claims.some((c) => c.field === `aircraft.${field}`),
    )
  )
    throw new HttpError(
      422,
      "Aircraft identity and year need source passages or an explained founder correction before drafting.",
    );
  const briefFields = {
    client: "Buyer / organization",
    aircraftModel: "Aircraft family",
    quantity: "Quantity",
    minYear: "Minimum build year",
    engine: "Engine constraint",
    budget: "Purchase budget ceiling",
    transactionKind: "Transaction type",
    leaseBudget: "Lease budget ceiling",
    leaseCurrency: "Lease budget currency",
    leaseBasis: "Lease budget rate basis",
    deadline: "Delivery deadline",
    destination: "Destination",
  } as const;
  for (const field of Object.keys(briefFields) as (keyof typeof briefFields)[]) {
    if ((kind === "Lease" && field === "budget") || (kind !== "Lease" && field.startsWith("lease")))
      continue;
    const value = requirement[field];
    if (value == null || value === "") continue;
    claims.push({
      field: `requirement.${field}`,
      label: briefFields[field],
      value,
      attribution: "Founder-recorded brief",
      href: confirmation.href,
      sourceId: requirement.intelligence?.sourceId ?? null,
      quote: `${confirmation.confirmedOn} · ${confirmation.contact}: ${confirmation.basis}`,
      page: null,
    });
  }
  for (const field of ["name", "email"] as const)
    claims.push({
      field: `contact.${field}`,
      label: field === "name" ? "Recipient" : "Recipient email",
      value: contact[field],
      attribution: "Founder-recorded contact",
      href: "/contacts",
      sourceId: null,
      quote:
        "Saved founder contact record; relationship and delivery address require founder review.",
      page: null,
    });
  const contextHash = createHash("sha256")
    .update(
      JSON.stringify({
        aircraft,
        requirement,
        contact,
        confirmation,
        claims,
        audience,
        template: "local-outreach-v1",
      }),
    )
    .digest("hex");
  return {
    ...composeDraft({ aircraft, requirement, contact, confirmation, claims, audience }),
    claims,
    contextHash,
  };
}
