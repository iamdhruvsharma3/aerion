"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Download, FileText, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import {
  signalFields,
  signalLabels,
  signalValuesSchema,
  type SignalDecision,
  type SignalRecord,
} from "@/lib/intelligence/market-schema";
import type { SourceRecord } from "@/lib/intelligence/schema";
import { dateLabel } from "@/lib/format";
import { Badge, Field, Modal } from "./ui";
import { readRequirementTerms } from "@/lib/sourcing";
import { RequirementTermsFields } from "./requirement-terms-fields";

export function SignalReviewModal({
  signal,
  onClose,
  onDone,
}: {
  signal: SignalRecord;
  onClose: () => void;
  onDone: (id: string | null) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(signalFields.map((f) => [f, String(signal.values[f] ?? "")])),
  );
  const [note, setNote] = useState("");
  const [attested, setAttested] = useState(false);
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const terminal = signal.stage === "Confirmed requirement" || signal.stage === "Dismissed";
  const confirming = signal.stage === "Potential requirement";
  useEffect(() => {
    const controller = new AbortController();
    api<SourceRecord>(`/api/sources/${signal.sourceId}`, { signal: controller.signal })
      .then(setSource)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [signal.sourceId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") as
      | SignalDecision["action"]
      | null;
    if (!action || busy) return;
    setBusy(true);
    setError("");
    try {
      const reviewed = signalValuesSchema.parse(
        Object.fromEntries(
          signalFields
            .filter((f) => values[f].trim())
            .map((f) => [f, f === "quantity" ? Number(values[f]) : values[f].trim()]),
        ),
      );
      const decision: SignalDecision = {
        action,
        revision: signal.revision,
        values: reviewed,
        note,
        attested,
      };
      if (action === "confirm") {
        decision.requirement = {
          client: reviewed.organization ?? "",
          aircraftModel: reviewed.aircraftFamily ?? "",
          category: reviewed.market as "Commercial" | "Business",
          quantity: reviewed.quantity ?? 0,
          minYear: Number(form.get("minYear")),
          engine: String(form.get("engine") ?? ""),
          ...readRequirementTerms(form),
          deadline: form.get("deadline") ? String(form.get("deadline")) : null,
          destination: String(form.get("destination") ?? ""),
          status: "Confirmed",
          description: String(form.get("description") ?? ""),
        };
        decision.confirmation = {
          contact: String(form.get("contact") ?? ""),
          confirmedOn: String(form.get("confirmedOn") ?? ""),
          basis: String(form.get("basis") ?? ""),
        };
      }
      const result = await api<{ requirementId: string | null }>(`/api/intelligence/${signal.id}`, {
        method: "POST",
        body: JSON.stringify(decision),
      });
      await onDone(result.requirementId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The review could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const next =
    signal.stage === "Signal" ? "lead" : signal.stage === "Lead" ? "potential" : "confirm";
  return (
    <Modal
      title={terminal ? "The decision and its evidence." : "A signal deserves a closer look."}
      description="Check the source, resolve unknowns, and record why this deserves the next step."
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="modal-form signal-review-form">
        <div className="signal-review-banner">
          <span>
            <Badge tone={signal.stage === "Confirmed requirement" ? "green" : "orange"}>
              {signal.stage === "Confirmed requirement"
                ? "Founder-recorded confirmation"
                : signal.stage}
            </Badge>
            <Badge>{signal.confidence} observations</Badge>
          </span>
          <a className="text-link" href={`/api/sources/${signal.sourceId}/document`}>
            Original <Download size={14} />
          </a>
        </div>
        <div className="signal-source-caption">
          <FileText size={16} />
          <strong>{signal.sourceTitle}</strong>
          <span>Captured {dateLabel(signal.capturedAt.slice(0, 10))}</span>
        </div>
        {signal.warnings.length ? (
          <div className="signal-warnings">
            {signal.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        ) : null}
        <fieldset disabled={terminal || busy} className="signal-field-list">
          {signalFields.map((field) => {
            const observations = signal.facts.filter((f) => f.field === field);
            const changed =
              String(signal.values[field] ?? "") !== String(signal.proposed[field] ?? "");
            return (
              <div className="signal-review-row" key={field}>
                <Field label={signalLabels[field]}>
                  {field === "intent" || field === "market" ? (
                    <select
                      value={values[field]}
                      onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                    >
                      <option value="">Unknown</option>
                      {(field === "intent"
                        ? ["Demand", "Supply", "Fleet activity"]
                        : ["Commercial", "Business"]
                      ).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={
                        field === "quantity" ? "number" : field === "eventDate" ? "date" : "text"
                      }
                      min={field === "quantity" ? 1 : undefined}
                      max={field === "quantity" ? 10000 : undefined}
                      maxLength={300}
                      value={values[field]}
                      onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                      placeholder="Unknown · supply only with evidence"
                    />
                  )}
                </Field>
                <div className="signal-passages">
                  {observations.length ? (
                    observations.map((f) => (
                      <blockquote key={`${f.page}-${f.quote}-${f.value}`}>
                        <p>“{f.quote}”</p>
                        <cite>
                          PAGE {f.page} ·{" "}
                          {f.method === "headline" ? "ORDER HEADLINE RULE" : "STATED FIELD"}
                          {observations.length > 1 ? ` · ${String(f.value)}` : ""}
                        </cite>
                      </blockquote>
                    ))
                  ) : (
                    <span className="unknown-observation">
                      No extracted evidence. Added values require your supporting review note.
                    </span>
                  )}
                  {changed ? (
                    <small>
                      Reviewed value differs from the original extraction. See the decision note.
                    </small>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>
        {source ? (
          <details className="full-source">
            <summary>Read the complete retained source</summary>
            {source.pages.map((p) => (
              <div key={p.page}>
                <span className="eyebrow muted">PAGE {p.page}</span>
                <pre>{p.text}</pre>
              </div>
            ))}
            {source.sourceUrl ? (
              <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="text-link">
                Open source reference <ArrowRight size={14} />
              </a>
            ) : null}
          </details>
        ) : (
          <p className="subtle-label">Loading retained evidence…</p>
        )}
        {terminal ? (
          <div className="signal-decision-record">
            <ShieldCheck size={21} />
            <div>
              <strong>
                {signal.stage === "Confirmed requirement"
                  ? "Founder-recorded confirmation"
                  : signal.stage}{" "}
                · {dateLabel(signal.reviewedAt?.slice(0, 10) ?? null)}
              </strong>
              <p>{signal.note}</p>
              {signal.confirmation ? (
                <p>
                  Founder-recorded confirmation with {signal.confirmation.contact} on{" "}
                  {dateLabel(signal.confirmation.confirmedOn)}. {signal.confirmation.basis}
                </p>
              ) : null}
              {signal.requirementId ? (
                <Link className="text-link" href={`/matches?requirement=${signal.requirementId}`}>
                  View requirement matches <ArrowRight size={14} />
                </Link>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {confirming ? (
              <fieldset disabled={busy} className="signal-confirmation">
                <div className="eyebrow muted">COMPLETE THE BUYER BRIEF</div>
                <h3>What has the buyer confirmed?</h3>
                <p>
                  Market, quantity, organization and aircraft family above must match the confirmed
                  brief. A fleet announcement alone does not establish this.
                </p>
                <div className="form-grid">
                  <Field label="Minimum build year">
                    <input name="minYear" type="number" min={1950} max={2100} required />
                  </Field>
                  <Field label="Destination">
                    <input name="destination" maxLength={300} required />
                  </Field>
                  <Field label="Engine constraint · optional">
                    <input name="engine" maxLength={200} />
                  </Field>
                  <RequirementTermsFields />
                  <Field label="Delivery deadline · optional">
                    <input name="deadline" type="date" />
                  </Field>
                  <Field label="Buyer contact / reference">
                    <input name="contact" maxLength={300} required />
                  </Field>
                  <Field label="Confirmation date">
                    <input
                      name="confirmedOn"
                      type="date"
                      max={new Date().toISOString().slice(0, 10)}
                      required
                    />
                  </Field>
                </div>
                <Field
                  label="Confirmation basis"
                  hint="Describe the buyer conversation or mandate, its reference and the needs confirmed. At least 20 characters."
                >
                  <textarea name="basis" rows={3} required minLength={20} maxLength={2000} />
                </Field>
                <Field label="Additional brief details · optional">
                  <textarea name="description" rows={2} maxLength={5000} />
                </Field>
              </fieldset>
            ) : null}
            <Field
              label="Review note"
              hint="Explain qualification, corrections, conflicts and the evidence behind any newly supplied values. Each stage retains its decision in the activity log."
            >
              <textarea
                required
                minLength={5}
                rows={3}
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Evidence checked and reason for the next step…"
              />
            </Field>
            <label className="review-attestation">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              <span>
                {confirming
                  ? "I verified this buyer confirmation and the completed requirement."
                  : "I checked the source and reviewed this signal’s meaning and values."}
              </span>
            </label>
            {signal.stage === "Lead" && values.intent !== "Demand" ? (
              <p className="review-requirements">
                Supply and fleet activity can remain qualified leads. Only reviewed demand can
                become a potential buyer requirement.
              </p>
            ) : null}
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span className="subtle-label">
            {terminal
              ? "Decision retained with original evidence"
              : "Nothing enters matching until buyer confirmation"}
          </span>
          <div>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={onClose}
            >
              Close
            </button>
            {!terminal ? (
              <>
                <button
                  type="submit"
                  value="dismiss"
                  formNoValidate
                  className="button button-ghost"
                  disabled={busy || note.trim().length < 5}
                >
                  Dismiss
                </button>
                <button
                  type="submit"
                  value={next}
                  className="button button-primary"
                  disabled={
                    busy ||
                    !source ||
                    !attested ||
                    (signal.stage === "Lead" && values.intent !== "Demand")
                  }
                >
                  {busy
                    ? "Saving decision…"
                    : next === "lead"
                      ? "Qualify lead"
                      : next === "potential"
                        ? "Develop requirement"
                        : "Confirm buyer requirement"}
                  <ArrowRight size={15} />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </form>
    </Modal>
  );
}
