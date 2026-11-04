import type { PoolClient } from "pg";
import type { Scope } from "../db";
import { HttpError } from "../http";
import { requirementNeedsRequalification } from "./context";
/** Recheck in both queue approval and SMTP preflight transactions. */
export async function assertCommunicationDelivery(
  db: PoolClient,
  scope: Scope,
  recipient: string,
  requirementId: string | null,
) {
  if (
    (
      await db.query(
        "select email from aerion.communication_suppressions where workspace_id=$1 and email=$2 and active",
        [scope.workspaceId, recipient.trim().toLowerCase()],
      )
    ).rows.length
  )
    throw new HttpError(
      422,
      "This recipient has an active contact restriction. Review it in Communications before sending.",
    );
  if (requirementId && (await requirementNeedsRequalification(db, scope, requirementId)))
    throw new HttpError(
      422,
      "This buyer brief was superseded or its reply assignment was corrected. Confirm a freshly reviewed brief and prepare a new offer; prior opportunities remain historical.",
    );
}
