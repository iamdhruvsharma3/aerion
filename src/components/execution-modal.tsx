"use client";

import { calendarDate } from "@/lib/format";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  executionActionSchema,
  readinessDefinitions,
  readinessStatuses,
  type ExecutionAction,
  type ExecutionContext,
} from "@/lib/execution/schema";
import { Field, Modal } from "./ui";
export type ExecutionModalState =
  | { kind: "decision"; aircraftId: string }
  | { kind: "draft" }
  | { kind: "contact" }
  | { kind: "confirm" }
  | { kind: "action" }
  | { kind: "readiness"; key: (typeof readinessDefinitions)[number]["key"] }
  | { kind: "review"; draftId: string; status: "Reviewed" | "Archived" };
export function ExecutionModal({
  modal,
  desk,
  onClose,
  onSave,
  busy,
}: {
  modal: ExecutionModalState;
  desk: ExecutionContext;
  onClose: () => void;
  onSave: (action: ExecutionAction) => Promise<boolean>;
  busy: boolean;
}) {
  const [error, setError] = useState("");
  const prior = modal.kind === "readiness" ? desk.readiness.find((i) => i.key === modal.key) : null;
  const [status, setStatus] = useState<string>(prior?.status ?? "Received");
  const [kind, setKind] = useState("Follow-up");
  const shortlist = desk.matches.filter(
    (m) =>
      m.state === "eligible" &&
      desk.decisions.some((d) => d.aircraftId === m.aircraft.id && d.decision === "Shortlisted"),
  );
  const titles = {
    decision: "Record a shortlist decision",
    draft: "Prepare an outreach draft",
    contact: "Link a contact",
    confirm: "Record brief confirmation",
    action: "Set the next action",
    readiness: "Update readiness evidence",
    review: "Record your draft review",
  };
  const descriptions = {
    decision: "Your decision and reason are retained separately from the match evaluation.",
    draft:
      "Local templates use retained evidence. Review every claim before approving a current draft for email delivery.",
    contact: "Choose a saved contact. Linking does not establish authority or a relationship.",
    confirm:
      "Record who confirmed this brief, when, and on what basis. This is a founder-recorded assertion.",
    action: "Due items appear in this desk. Email and calendar notifications are not connected.",
    readiness:
      "Receipt, review and verification are distinct steps. Record the person and basis behind any verification.",
    review: "The original message and claim evidence remain retained with this review.",
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const f = new FormData(event.currentTarget),
      get = (key: string) => String(f.get(key) ?? ""),
      attested = f.get("attested") === "on";
    let raw: unknown;
    switch (modal.kind) {
      case "decision":
        raw = {
          type: "shortlist",
          aircraftId: modal.aircraftId,
          decision: get("decision"),
          reason: get("note"),
        };
        break;
      case "draft":
        raw = {
          type: "prepare-draft",
          aircraftId: get("aircraftId"),
          contactId: get("contactId"),
          audience: get("audience"),
        };
        break;
      case "contact":
        raw = { type: "link-contact", contactId: get("contactId") };
        break;
      case "confirm":
        raw = {
          type: "confirm-brief",
          confirmation: {
            contact: get("contact"),
            confirmedOn: get("confirmedOn"),
            basis: get("basis"),
          },
          attested,
        };
        break;
      case "action":
        raw = {
          type: "add-action",
          kind: get("kind"),
          title: get("title"),
          detail: get("detail"),
          dueDate: get("dueDate") || null,
        };
        break;
      case "readiness":
        raw = {
          type: "readiness",
          key: modal.key,
          status: get("status"),
          sourceId: get("sourceId"),
          note: get("note"),
          verifiedBy: get("verifiedBy") || undefined,
          verifiedOn: get("verifiedOn") || undefined,
          attested,
        };
        break;
      case "review":
        raw = {
          type: "review-draft",
          draftId: modal.draftId,
          status: modal.status,
          note: get("note"),
          attested,
        };
        break;
    }
    const parsed = executionActionSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    try {
      if (await onSave(parsed.data)) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this change.");
    }
  }
  const decision =
    modal.kind === "decision"
      ? desk.decisions.find((d) => d.aircraftId === modal.aircraftId)
      : null;
  return (
    <Modal title={titles[modal.kind]} description={descriptions[modal.kind]} onClose={onClose}>
      <form className="modal-form execution-form" onSubmit={submit}>
        {modal.kind === "decision" ? (
          <>
            <Field label="Decision">
              <select name="decision" defaultValue={decision?.decision ?? "Shortlisted"}>
                <option>Shortlisted</option>
                <option>Rejected</option>
                <option>Undecided</option>
              </select>
            </Field>
            <Field label="Reason">
              <textarea
                name="note"
                required
                minLength={5}
                maxLength={2000}
                defaultValue={decision?.reason}
                placeholder="Explain the fit, unresolved concern, or rejection."
              />
            </Field>
          </>
        ) : modal.kind === "draft" ? (
          <>
            <Field label="Shortlisted aircraft">
              <select name="aircraftId" required defaultValue="">
                <option value="" disabled>
                  Select an eligible aircraft
                </option>
                {shortlist.map(({ aircraft: a }) => (
                  <option key={a.id} value={a.id}>
                    {a.manufacturer} {a.model} · {a.serial}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Audience">
              <select name="audience">
                <option>Buyer</option>
                <option>Seller</option>
              </select>
            </Field>
            <Field
              label="Linked recipient"
              hint="Buyer drafts require a Buyer or Broker; seller drafts require a Seller or Broker."
            >
              <select name="contactId" required defaultValue="">
                <option value="" disabled>
                  Select a linked contact
                </option>
                {desk.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.type} · {c.email}
                  </option>
                ))}
              </select>
            </Field>
            <p className="execution-caption">
              Only supported fields enter the message. Identical inputs reuse the retained draft.
            </p>
          </>
        ) : modal.kind === "contact" ? (
          <Field label="Saved contact">
            <select name="contactId" required defaultValue="">
              <option value="" disabled>
                Select a contact
              </option>
              {desk.availableContacts
                .filter((c) => !desk.contacts.some((l) => l.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.type} · {c.company}
                  </option>
                ))}
            </select>
          </Field>
        ) : modal.kind === "confirm" ? (
          <>
            <Field label="Confirming contact">
              <input name="contact" required maxLength={300} placeholder="Name and organization" />
            </Field>
            <Field label="Confirmation date">
              <input name="confirmedOn" type="date" required max={calendarDate()} />
            </Field>
            <Field label="Basis for this confirmation">
              <textarea
                name="basis"
                required
                minLength={20}
                maxLength={2000}
                placeholder="Describe the actual discussion or retained communication supporting the brief."
              />
            </Field>
            <label className="execution-attest">
              <input name="attested" type="checkbox" required />I reviewed the brief and am
              recording this confirmation myself.
            </label>
          </>
        ) : modal.kind === "action" ? (
          <>
            <Field label="Action type">
              <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option>Follow-up</option>
                <option>Question</option>
              </select>
            </Field>
            <Field label="Title">
              <input
                name="title"
                required
                maxLength={300}
                placeholder="The next concrete step or open question"
              />
            </Field>
            <Field label="Context">
              <textarea
                name="detail"
                maxLength={2000}
                placeholder="What needs to be resolved, and by whom?"
              />
            </Field>
            <Field label={kind === "Follow-up" ? "Due date" : "Due date (optional)"}>
              <input name="dueDate" type="date" required={kind === "Follow-up"} />
            </Field>
          </>
        ) : modal.kind === "readiness" ? (
          <>
            <p className="execution-item-title">
              {readinessDefinitions.find((d) => d.key === modal.key)?.title}
            </p>
            <Field label="Evidence status">
              <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {readinessStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s === "Verified" ? "Verification recorded" : s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Retained source" hint="New or replacement evidence starts at Received.">
              <select name="sourceId" required defaultValue={prior?.sourceId ?? ""}>
                <option value="" disabled>
                  Select a document
                </option>
                {desk.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Review or verification basis">
              <textarea
                name="note"
                required
                minLength={status === "Verified" ? 20 : 5}
                maxLength={2000}
                defaultValue={prior?.note}
                placeholder="Explain what this evidence establishes and what remains unresolved."
              />
            </Field>
            {status === "Verified" ? (
              <div className="form-grid">
                <Field label="Verifier and role / reference">
                  <input
                    name="verifiedBy"
                    required
                    maxLength={300}
                    defaultValue={prior?.verifiedBy ?? ""}
                  />
                </Field>
                <Field label="Verification date">
                  <input
                    name="verifiedOn"
                    type="date"
                    required
                    max={calendarDate()}
                    defaultValue={prior?.verifiedOn ?? ""}
                  />
                </Field>
              </div>
            ) : null}
            {["Reviewed", "Verified"].includes(status) ? (
              <label className="execution-attest">
                <input name="attested" type="checkbox" required />I reviewed the attached source and
                the recorded basis for this status.
              </label>
            ) : null}
          </>
        ) : (
          <>
            <Field label="Review note">
              <textarea
                name="note"
                required
                minLength={5}
                maxLength={2000}
                placeholder="Record your review or reason for archiving."
              />
            </Field>
            {modal.kind === "review" && modal.status === "Reviewed" ? (
              <label className="execution-attest">
                <input name="attested" type="checkbox" required />I checked the recipient, message
                and evidence for every claim.
              </label>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        {modal.kind === "contact" &&
        !desk.availableContacts.some((c) => !desk.contacts.some((l) => l.id === c.id)) ? (
          <p className="execution-caption">
            No unlinked contacts are available.{" "}
            <Link className="text-link" href="/contacts">
              Add a contact in Contacts
            </Link>
            , then return to this requirement.
          </p>
        ) : null}
        {modal.kind === "readiness" && !desk.sources.length ? (
          <p className="execution-caption">
            Retain a supporting document in the{" "}
            <Link className="text-link" href="/sources">
              source library
            </Link>{" "}
            before recording receipt.
          </p>
        ) : null}
        <div className="modal-actions">
          <span className="form-inline-note">Saved with actor and history</span>
          <button className="button button-primary" disabled={busy} type="submit">
            {busy ? "Saving…" : modal.kind === "draft" ? "Prepare local draft" : "Save record"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
