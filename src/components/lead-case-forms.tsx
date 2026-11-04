"use client";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { LeadCase, LeadCaseAction } from "@/lib/leads/schema";
import type { AgentProvider } from "@/lib/agents/schema";
import { calendarDate } from "@/lib/format";
import { Field } from "./ui";
import { api } from "@/lib/api";
import { readRequirementTerms } from "@/lib/sourcing";
import { RequirementTermsFields } from "./requirement-terms-fields";

const text = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
export type LeadEditor =
  | "contact"
  | "link-contact"
  | "requirement"
  | "link-requirement"
  | "confirm"
  | "source"
  | "status"
  | { aircraftId: string };
export function LeadRecordForm({
  editor,
  detail,
  contacts,
  requirements,
  busy,
  onSave,
  onCancel,
}: {
  editor: LeadEditor;
  detail: LeadCase;
  contacts: { id: string; name: string; company: string }[];
  requirements: { id: string; client: string; aircraftModel: string }[];
  busy: boolean;
  onSave: (action: LeadCaseAction) => Promise<boolean>;
  onCancel: () => void;
}) {
  const evidence = detail.enrichments[0]?.values ?? detail.lead.values;
  const titles = {
    contact: "Record a business contact",
    "link-contact": "Connect an existing contact",
    requirement: "Record a draft buyer brief",
    "link-requirement": "Connect an existing buyer brief",
    confirm: "Confirm the current buyer requirement",
    source: "Attach a retained document",
    status: "Set the next action",
  };
  const title =
    typeof editor === "string" ? titles[editor] : "Create an opportunity and buyer offer draft";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      note = text(form, "note");
    let action: LeadCaseAction;
    if (typeof editor === "object")
      action = {
        kind: "opportunity",
        aircraftId: editor.aircraftId,
        dueOn: text(form, "dueOn"),
        note,
        attested: true,
      };
    else if (editor === "contact")
      action = {
        kind: "create-contact",
        values: {
          name: text(form, "name"),
          company: text(form, "company"),
          email: text(form, "email"),
          role: text(form, "role"),
          location: text(form, "location"),
          type: text(form, "type") as "Buyer" | "Seller" | "Broker" | "Specialist",
          notes: note,
        },
        note,
        attested: true,
      };
    else if (editor === "link-contact")
      action = { kind: "link-contact", contactId: text(form, "contactId"), note };
    else if (editor === "requirement")
      action = {
        kind: "create-requirement",
        values: {
          client: text(form, "client"),
          aircraftModel: text(form, "aircraftModel"),
          category: text(form, "category") as "Commercial" | "Business",
          quantity: Number(text(form, "quantity")),
          minYear: Number(text(form, "minYear")),
          engine: text(form, "engine"),
          ...readRequirementTerms(form),
          deadline: text(form, "deadline") || null,
          destination: text(form, "destination"),
          description: note,
        },
        note,
        attested: true,
      };
    else if (editor === "link-requirement")
      action = { kind: "link-requirement", requirementId: text(form, "requirementId"), note };
    else if (editor === "confirm")
      action = {
        kind: "confirm",
        confirmation: {
          contact: text(form, "confirmationContact"),
          confirmedOn: text(form, "confirmedOn"),
          basis: note,
        },
        note,
        attested: true,
      };
    else if (editor === "source")
      action = {
        kind: "attach-source",
        sourceId: text(form, "sourceId"),
        purpose: detail.lead.values.side === "Buyer" ? "Buyer brief" : "Other",
        note,
      };
    else
      action = {
        kind: "update",
        status: text(form, "status") as "Research" | "Qualifying" | "Dismissed",
        nextAction: text(form, "nextAction"),
        dueOn: text(form, "dueOn") || null,
      };
    if (await onSave(action)) onCancel();
  }
  const record =
    typeof editor === "object" || ["contact", "requirement", "confirm"].includes(editor);
  return (
    <section className="qualification-editor">
      <h3>{title}</h3>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {editor === "contact" ? (
            <>
              <p className="qualification-hint">
                Approved research can prefill published details. Complete missing fields from your
                own records and explain their basis below.
              </p>
              <div className="qualification-fields">
                <Field label="Contact name / business desk">
                  <input
                    name="name"
                    required
                    maxLength={300}
                    defaultValue={evidence.contactName ?? ""}
                  />
                </Field>
                <Field label="Organization">
                  <input
                    name="company"
                    required
                    maxLength={300}
                    defaultValue={evidence.organization ?? ""}
                  />
                </Field>
                <Field label="Published business email">
                  <input name="email" type="email" required defaultValue={evidence.email ?? ""} />
                </Field>
                <Field label="Role / department">
                  <input
                    name="role"
                    required
                    maxLength={300}
                    placeholder="Use the stated role or your recorded relationship"
                  />
                </Field>
                <Field label="Location">
                  <input
                    name="location"
                    required
                    maxLength={300}
                    defaultValue={evidence.geography ?? ""}
                  />
                </Field>
                <Field label="Contact type">
                  <select name="type" defaultValue={detail.lead.values.side}>
                    <option>Buyer</option>
                    <option>Seller</option>
                    <option>Broker</option>
                    <option>Specialist</option>
                  </select>
                </Field>
              </div>
            </>
          ) : editor === "link-contact" ? (
            <Field label="Saved contact">
              <select name="contactId" required defaultValue="">
                <option value="" disabled>
                  Select a contact
                </option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.company}
                  </option>
                ))}
              </select>
            </Field>
          ) : editor === "requirement" ? (
            <>
              <p className="qualification-hint">
                Unknown matching constraints need a buyer response. Values below are
                founder-recorded; the brief starts as Draft.
              </p>
              <div className="qualification-fields">
                <Field label="Buyer / represented organization">
                  <input
                    name="client"
                    required
                    maxLength={300}
                    defaultValue={detail.lead.values.organization ?? ""}
                  />
                </Field>
                <Field label="Requested aircraft family">
                  <input
                    name="aircraftModel"
                    required
                    maxLength={300}
                    defaultValue={detail.lead.values.aircraftModel ?? ""}
                  />
                </Field>
                <Field label="Aircraft market">
                  <select name="category" required defaultValue="">
                    <option value="" disabled>
                      Select the stated market
                    </option>
                    <option>Commercial</option>
                    <option>Business</option>
                  </select>
                </Field>
                <Field label="Quantity">
                  <input name="quantity" type="number" required min={1} max={50} />
                </Field>
                <Field label="Minimum build year">
                  <input name="minYear" type="number" required min={1950} max={2100} />
                </Field>
                <Field label="Engine constraint (optional)">
                  <input name="engine" maxLength={200} />
                </Field>
                <RequirementTermsFields />
                <Field label="Delivery deadline (optional)">
                  <input name="deadline" type="date" />
                </Field>
                <Field label="Destination">
                  <input name="destination" required maxLength={300} />
                </Field>
              </div>
            </>
          ) : editor === "link-requirement" ? (
            <Field label="Saved buyer brief">
              <select name="requirementId" required defaultValue="">
                <option value="" disabled>
                  Select a brief
                </option>
                {requirements.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.client} · {r.aircraftModel}
                  </option>
                ))}
              </select>
            </Field>
          ) : editor === "confirm" ? (
            <div className="qualification-fields">
              <Field label="Who confirmed the requirement?">
                <input
                  name="confirmationContact"
                  required
                  maxLength={300}
                  defaultValue={detail.contact?.name ?? ""}
                />
              </Field>
              <Field label="Confirmation date">
                <input
                  name="confirmedOn"
                  type="date"
                  required
                  max={calendarDate()}
                  defaultValue={calendarDate()}
                />
              </Field>
            </div>
          ) : editor === "source" ? (
            <>
              <Field label="Retained buyer reply / supporting document">
                <select name="sourceId" required defaultValue="">
                  <option value="" disabled>
                    Select from the source library
                  </option>
                  {detail.availableSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="qualification-hint">
                Import email, text or a PDF in the Source library first. A reference URL alone is
                not a retained buyer reply.
              </p>
            </>
          ) : editor === "status" ? (
            <>
              <div className="qualification-fields">
                <Field label="Working status">
                  <select name="status" defaultValue={detail.status}>
                    <option>Research</option>
                    <option>Qualifying</option>
                    <option>Dismissed</option>
                  </select>
                </Field>
                <Field label="Follow-up date">
                  <input name="dueOn" type="date" defaultValue={detail.dueOn ?? ""} />
                </Field>
              </div>
              <Field label="Next action">
                <textarea name="nextAction" maxLength={500} defaultValue={detail.nextAction} />
              </Field>
            </>
          ) : (
            <>
              <p className="qualification-hint">
                This saves the eligible aircraft to the shortlist, connects the selected recipient,
                prepares an evidence-backed buyer offer draft and opens a Sourcing opportunity.
              </p>
              <Field label="Next-action due date">
                <input name="dueOn" type="date" required defaultValue={calendarDate()} />
              </Field>
            </>
          )}
          {editor !== "status" ? (
            <ReviewNote
              label={
                editor === "confirm"
                  ? "Confirmation basis and retained communication"
                  : typeof editor === "object"
                    ? "Selection reason and next action"
                    : "Review note / source of these details"
              }
            />
          ) : null}
          {record ? (
            <Attestation>I reviewed these details and their supporting evidence.</Attestation>
          ) : null}
          <div className="qualification-form-actions">
            <button type="button" className="button button-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="button button-primary">
              {busy ? "Saving…" : "Save & continue"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
export function ReviewNote({ label = "Review note" }: { label?: string }) {
  return (
    <Field label={label}>
      <textarea
        name="note"
        required
        minLength={20}
        maxLength={2000}
        rows={3}
        placeholder="Record what you reviewed and the basis for this action."
      />
    </Field>
  );
}
export function Attestation({ children }: { children: ReactNode }) {
  return (
    <label className="qualification-consent">
      <input name="attested" type="checkbox" required />
      {children}
    </label>
  );
}
export function LeadResearchForm({
  detail,
  providers,
  kind,
  busy,
  onRun,
  onCancel,
}: {
  detail: LeadCase;
  providers: { id: string; ready: boolean; model: string | null }[];
  kind: "contacts" | "brief" | "aircraft";
  busy: boolean;
  onRun: (id: string | null) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(
      providers.find((p) => p.id === "nvidia" && p.ready)?.id ??
        providers.find((p) => p.ready)?.id ??
        "rules",
    ),
    [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const f = new FormData(e.currentTarget);
    setSubmitting(true);
    setError("");
    try {
      const result = await api<{ id?: string; extractionId?: string }>(
        `/api/leads/${detail.lead.id}/research`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: detail.revision,
            kind,
            provider: provider as AgentProvider,
            allowExternalSources: f.get("external") === "on",
            allowModelData: f.get("model") === "on",
            urls:
              kind === "contacts"
                ? text(f, "urls")
                    .split(/\r?\n/)
                    .map((v) => v.trim())
                    .filter(Boolean)
                : [],
            idempotencyKey: key.current,
            sourceIds: kind === "brief" ? f.getAll("sourceId").map(String) : [],
          }),
        },
      );
      onRun(result.id ?? null);
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Research could not start.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="qualification-editor">
      <h3>
        {kind === "contacts"
          ? "Research published business contacts"
          : kind === "brief"
            ? "Analyze the attached buyer brief"
            : "Extract aircraft evidence"}
      </h3>
      <form onSubmit={submit}>
        <fieldset disabled={busy || submitting}>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {kind === "brief" ? (
            <fieldset className="qualification-document-choice">
              <legend>Buyer briefs for this run</legend>
              {detail.sources
                .filter((s) => s.purpose === "Buyer brief" && !s.retired)
                .map((s, i) => (
                  <label className="qualification-consent" key={s.id}>
                    <input type="checkbox" name="sourceId" value={s.id} defaultChecked={i < 20} />
                    {s.title}
                  </label>
                ))}
              <p className="qualification-hint">
                Up to 20 selected documents. The queued source selection stays fixed.
              </p>
            </fieldset>
          ) : null}
          <Field label="Agent provider">
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.ready}>
                  {p.id === "rules" ? "Local rules / collection" : p.id}
                  {p.ready ? "" : " · not configured"}
                </option>
              ))}
            </select>
          </Field>
          {kind === "contacts" ? (
            <>
              <Field
                label="Official contact page URLs (optional)"
                hint="Leave empty to search Brave for the selected organization's public business contact pages. Up to three HTTPS URLs."
              >
                <textarea name="urls" rows={3} maxLength={6002} placeholder="https://…" />
              </Field>
              <label className="qualification-consent">
                <input type="checkbox" name="external" required />
                Allow this run to search Brave and fetch public contact pages.
              </label>
            </>
          ) : null}
          {provider !== "rules" ? (
            <label className="qualification-consent">
              <input type="checkbox" name="model" required />
              Allow the selected lead context and{" "}
              {kind === "brief" ? "attached buyer brief" : "retained source text"} to be sent to{" "}
              {provider}.
            </label>
          ) : (
            <p className="qualification-hint">
              Local rules recognize explicit labels. Public prose and contact extraction may need a
              connected AI model.
            </p>
          )}
          <div className="qualification-form-actions">
            <button className="button button-secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="button button-primary" type="submit">
              {submitting ? "Starting…" : "Start research"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
