"use client";

import { useState } from "react";
import type { Requirement } from "@/lib/schema";
import { Field } from "./ui";

export function RequirementTermsFields() {
  const [kind, setKind] = useState<NonNullable<Requirement["transactionKind"]>>("Not supplied");
  return (
    <>
      <Field
        label="Transaction kind"
        hint="Choose the buyer's stated need. Unknown terms keep matches in review."
      >
        <select
          name="transactionKind"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option>Not supplied</option>
          <option>Sale</option>
          <option>Lease</option>
        </select>
      </Field>
      {kind === "Sale" ? (
        <Field label="Purchase budget per aircraft · USD · optional">
          <input name="budget" type="number" min="0" step="any" placeholder="Purchase ceiling" />
        </Field>
      ) : kind === "Lease" ? (
        <>
          <Field label="Lease budget per aircraft · optional">
            <input name="leaseBudget" type="number" min="0" step="any" placeholder="Rate ceiling" />
          </Field>
          <Field
            label="Lease currency · optional"
            hint="Three-letter code from the brief, e.g. USD or EUR."
          >
            <input
              name="leaseCurrency"
              pattern="[A-Za-z]{3}"
              maxLength={3}
              placeholder="USD"
              autoCapitalize="characters"
            />
          </Field>
          <Field label="Lease rate basis · optional">
            <select name="leaseBasis" defaultValue="">
              <option value="">Not supplied</option>
              <option>Monthly rent</option>
              <option>Hourly rate</option>
            </select>
          </Field>
        </>
      ) : null}
    </>
  );
}
