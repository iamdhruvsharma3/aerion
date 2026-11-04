"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  Flag,
  History,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { calendarDate, dateLabel, dateTimeLabel } from "@/lib/format";
import {
  milestoneKeys,
  transactionStages,
  transactionGaps,
  nextTransactionStage,
  isTerminal,
  type TransactionAction,
  type TransactionDetail,
  type TransactionEvidence,
  type TransactionFinding,
  type TransactionOffer,
  type TransactionStage,
} from "@/lib/transactions/schema";
import { Badge, Field, Modal } from "./ui";
import { useWorkspace } from "./workspace-provider";

type Editor =
  | "configure"
  | "offer"
  | "evidence"
  | "finding"
  | "transition"
  | "reopen"
  | { offer: TransactionOffer }
  | { evidence: TransactionEvidence }
  | { finding: TransactionFinding };
const text = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
export default function TransactionWorkspace({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { refresh } = useWorkspace();
  const [detail, setDetail] = useState<TransactionDetail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("Milestones"),
    [editor, setEditor] = useState<Editor | null>(null),
    [historical, setHistorical] = useState(false);
  const formKey = useRef(crypto.randomUUID()),
    formRef = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = await api<TransactionDetail>(`/api/transactions/${encodeURIComponent(id)}`, {
        signal,
      });
      if (!signal?.aborted) setDetail(current);
    },
    [id],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (editor) {
      formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      formRef.current
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,select,textarea",
        )
        ?.focus();
    }
  }, [editor]);
  const open = (value: Editor) => {
    setEditor(value);
    setNotice("");
    setError("");
    formKey.current = crypto.randomUUID();
  };
  async function mutate(action: TransactionAction) {
    if (!detail || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ detail: TransactionDetail; reused: boolean }>(
        `/api/transactions/${encodeURIComponent(id)}`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: detail.revision,
            idempotencyKey: formKey.current,
            action,
          }),
        },
      );
      setDetail(result.detail);
      setNotice(
        result.reused
          ? "This action was already saved; the current transaction is shown."
          : "Transaction record saved with its review history.",
      );
      setEditor(null);
      formKey.current = crypto.randomUUID();
      await refresh();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The transaction action was not saved.");
      if (e instanceof ApiError && e.status === 409) await load().catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }
  const next = detail ? nextTransactionStage(detail.status) : null,
    gaps = detail && next ? transactionGaps(detail, next) : [],
    terminal = detail ? isTerminal(detail.status) : false;
  const visibleOffers = detail?.offers.filter((o) => historical || o.cycle === detail.cycle) ?? [],
    visibleEvidence = detail?.evidence.filter((e) => historical || e.cycle === detail.cycle) ?? [],
    visibleFindings = detail?.findings.filter((f) => historical || f.cycle === detail.cycle) ?? [];
  return (
    <Modal
      title={detail ? `${detail.deal.title} · transaction` : "Opening transaction"}
      description="Record counterparties, commercial terms, milestone evidence and the actual outcome."
      onClose={onClose}
      wide
      className="transaction-modal"
    >
      {!detail ? (
        <p className="transaction-loading">{error || "Loading the saved transaction…"}</p>
      ) : (
        <div className="transaction-workspace">
          <header className="transaction-header">
            <div>
              <div className="eyebrow">DEAL EXECUTION / CYCLE {detail.cycle}</div>
              <h3>
                {detail.aircraft
                  ? `${detail.aircraft.manufacturer} ${detail.aircraft.model}`
                  : "Linked aircraft unavailable"}
              </h3>
              <p>
                {detail.requirement?.client ?? "Linked buyer unavailable"} ·{" "}
                {detail.aircraft?.serial ?? "No serial"} ·{" "}
                {detail.commercialScopeIssue
                  ? "Commercial clarification required"
                  : detail.transactionKind}
              </p>
            </div>
            <Badge tone={detail.status === "Completed" ? "green" : terminal ? "red" : "orange"}>
              {detail.status}
            </Badge>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh transaction"
              onClick={() => load().catch((e) => setError(e.message))}
            >
              <RefreshCw size={15} />
            </button>
          </header>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="transaction-notice">
              {notice}
            </p>
          ) : null}
          {detail.contextChanged ? (
            <p className="transaction-warning">
              {detail.supersededRequirement
                ? "Reviewed correspondence superseded this buyer brief or corrected its source assignment. These transaction records remain historical. Use a newly reviewed and confirmed brief for a new opportunity; an active old case may be recorded as Lost or Cancelled."
                : detail.singleAircraftScopeInvalid
                  ? "This historical offer records more than one aircraft against a single saved serial. Its completion cannot support a new fee or invoice. Requalify the offer for this aircraft and reopen a single-aircraft cycle; create separate serial-specific opportunities for other aircraft."
                  : detail.commercialScopeIssue
                    ? detail.commercialScopeIssue
                    : "The linked opportunity changed. Review the current references and reopen a cycle before continuing."}
            </p>
          ) : null}
          <ol className="transaction-progress">
            {transactionStages.slice(0, 7).map((stage, index) => (
              <li
                key={stage}
                className={
                  stage === detail.status
                    ? "current"
                    : transactionStages.indexOf(detail.status) > index &&
                        (detail.status === "Completed" || !terminal)
                      ? "done"
                      : ""
                }
              >
                <span>
                  {stage === detail.status ? (
                    <ChevronRight size={12} />
                  ) : transactionStages.indexOf(detail.status) > index &&
                    (detail.status === "Completed" || !terminal) ? (
                    <Check size={12} />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
                {stage}
              </li>
            ))}
          </ol>
          <div className="transaction-actionbar">
            <div>
              <strong>{detail.nextAction || "Record the next concrete action"}</strong>
              <span>{detail.dueOn ? `Due ${dateLabel(detail.dueOn)}` : "No next-action date"}</span>
            </div>
            <div className="transaction-buttons">
              <button
                type="button"
                className="text-link"
                onClick={() => open("configure")}
                disabled={terminal || busy || detail.supersededRequirement}
              >
                Edit next action
              </button>
              {next ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || detail.contextChanged}
                  onClick={() => open("transition")}
                >
                  Advance to {next}
                  <ArrowRight size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className="button button-secondary"
                onClick={() => open(terminal ? "reopen" : "transition")}
                disabled={busy || (terminal && detail.supersededRequirement)}
              >
                {terminal ? "Reopen a new cycle" : "Record outcome"}
              </button>
            </div>
          </div>
          <div className="transaction-tabs" role="tablist" aria-label="Transaction workspace">
            {["Milestones", "Offers", "Findings", "History"].map((t) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === t}
                id={`transaction-tab-${t}`}
                aria-controls={`transaction-panel-${t}`}
                key={t}
                onClick={() => {
                  setTab(t);
                  setEditor(null);
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div
            className="transaction-panel"
            role="tabpanel"
            id={`transaction-panel-${tab}`}
            aria-labelledby={`transaction-tab-${tab}`}
          >
            <div className="transaction-toolbar">
              <p>Current cycle {detail.cycle}. Prior cycles remain in the record.</p>
              <label>
                <input
                  type="checkbox"
                  checked={historical}
                  onChange={(e) => setHistorical(e.target.checked)}
                />{" "}
                Show earlier cycles
              </label>
            </div>
            {tab === "Milestones" ? (
              <>
                <section className="transaction-card">
                  <div className="transaction-card-heading">
                    <ShieldCheck size={16} />
                    <h3>Evidence and accountable review</h3>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy || terminal || detail.supersededRequirement}
                      onClick={() => open("evidence")}
                    >
                      <Plus size={13} />
                      Attach milestone evidence
                    </button>
                  </div>
                  <p>
                    Attach a retained document, review that exact version, then record who verified
                    it and on what basis. Aerion retains your attribution; it does not perform
                    technical or legal certification.
                  </p>
                  <Link className="text-link" href="/sources">
                    Import a document in the Source library <ArrowRight size={12} />
                  </Link>
                </section>
                {next && gaps.length ? (
                  <section className="transaction-gap-list">
                    <h3>Before {next}</h3>
                    <ul>
                      {gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </section>
                ) : terminal ? (
                  <section className="transaction-card">
                    <h3>
                      {detail.status === "Completed" ? "Completion recorded" : "Outcome recorded"}
                    </h3>
                    <p>
                      {detail.completedOn
                        ? `Completed on ${detail.completedOn}. Commission earning and payment remain separate revenue records.`
                        : "Reopening starts a new sourcing cycle and preserves this cycle's evidence and outcome."}
                    </p>
                    {detail.completionSourceId ? (
                      <SourceLink id={detail.completionSourceId}>
                        Completion acceptance source
                      </SourceLink>
                    ) : null}
                  </section>
                ) : null}
                <div className="transaction-evidence-grid">
                  {milestoneKeys.map((key) => {
                    const record = visibleEvidence.find(
                      (e) => e.key === key && e.cycle === detail.cycle && e.current,
                    );
                    return (
                      <section className="transaction-card" key={key}>
                        <div className="transaction-card-heading">
                          <h3>{key}</h3>
                          <Badge
                            tone={
                              record?.state === "Verification recorded"
                                ? "green"
                                : record?.state === "Waiver recorded"
                                  ? "orange"
                                  : "neutral"
                            }
                          >
                            {record?.state ?? "Missing"}
                          </Badge>
                        </div>
                        {record ? (
                          <>
                            <p>{record.detail}</p>
                            <p className="transaction-attribution">
                              Source party: {record.party}
                              <br />
                              Event date: {record.occurredOn}
                            </p>
                            <SourceLink id={record.sourceId}>{record.sourceTitle}</SourceLink>
                            {record.reviewer ? (
                              <p className="transaction-attribution">
                                {record.state} by {record.reviewer} · {record.reviewedOn}
                                <br />
                                {record.reviewNote}
                              </p>
                            ) : null}
                            <div className="transaction-buttons">
                              <button
                                type="button"
                                className="text-link"
                                disabled={
                                  terminal ||
                                  busy ||
                                  detail.supersededRequirement ||
                                  !["Received", "Reviewed"].includes(record.state)
                                }
                                onClick={() => open({ evidence: record })}
                              >
                                {record.state === "Received"
                                  ? "Review current version"
                                  : "Record named verification"}
                              </button>
                            </div>
                          </>
                        ) : (
                          <p>Retained evidence and a review are needed for this milestone.</p>
                        )}
                      </section>
                    );
                  })}
                </div>
                {historical ? (
                  <details className="transaction-card">
                    <summary>All retained evidence versions ({visibleEvidence.length})</summary>
                    {visibleEvidence.map((e) => (
                      <div className="transaction-history-row" key={e.id}>
                        <strong>
                          Cycle {e.cycle} · {e.key} · {e.state}
                          {e.current ? " · latest" : " · superseded"}
                        </strong>
                        <SourceLink id={e.sourceId}>{e.sourceTitle}</SourceLink>
                        <p>{e.detail}</p>
                        <p className="transaction-attribution">
                          {e.party} · event {e.occurredOn}
                          {e.reviewer ? ` · ${e.reviewer} · ${e.reviewedOn}` : ""}
                          <br />
                          {e.reviewNote}
                        </p>
                      </div>
                    ))}
                  </details>
                ) : null}
              </>
            ) : tab === "Offers" ? (
              <>
                <section className="transaction-card">
                  <div className="transaction-card-heading">
                    <h3>Commercial offer register</h3>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={
                        busy ||
                        terminal ||
                        detail.supersededRequirement ||
                        !["Sourcing", "Offer"].includes(detail.status)
                      }
                      onClick={() => open("offer")}
                    >
                      <Plus size={13} />
                      Record offer version
                    </button>
                  </div>
                  <p>
                    Record an offer that already exists in retained communication. Nothing here
                    sends an offer or accepts terms on anyone's behalf. Price is per aircraft and
                    uses the recorded purchase/rent basis. This opportunity covers one saved serial;
                    a larger buyer brief needs a separate opportunity for each aircraft.
                  </p>
                </section>
                {visibleOffers.map((offer) => (
                  <section className="transaction-card" key={offer.id}>
                    <div className="transaction-card-heading">
                      <h3>
                        {offer.side} {offer.offerKind.toLowerCase()} · cycle {offer.cycle}
                      </h3>
                      <Badge
                        tone={
                          offer.status === "Accepted"
                            ? "green"
                            : offer.status === "Recorded"
                              ? "neutral"
                              : "orange"
                        }
                      >
                        {offer.status}
                      </Badge>
                    </div>
                    <div className="transaction-offer-value">
                      {offer.amount}{" "}
                      <span>
                        {offer.currency} · {offer.basis.toLowerCase()} per aircraft ·{" "}
                        {offer.quantity} aircraft
                      </span>
                    </div>
                    <p>
                      {offer.contactName} · {offer.contactEmail}
                      <br />
                      Offered {offer.offeredOn}
                      {offer.expiresOn ? ` · expires ${offer.expiresOn}` : " · expiry not supplied"}
                    </p>
                    <p className="transaction-prewrap">{offer.terms}</p>
                    {offer.parentId ? (
                      <p className="transaction-attribution">
                        Responds to retained offer version {offer.parentId}
                      </p>
                    ) : null}
                    <SourceLink id={offer.sourceId}>Original offer source</SourceLink>
                    {offer.decisionNote ? (
                      <p className="transaction-attribution">
                        {offer.status} · {offer.recordedBy} · {offer.decidedOn}
                        <br />
                        {offer.decisionNote}
                      </p>
                    ) : null}
                    {offer.decisionSourceId ? (
                      <SourceLink id={offer.decisionSourceId}>Decision evidence</SourceLink>
                    ) : null}
                    <div className="transaction-buttons">
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={
                          busy ||
                          terminal ||
                          offer.cycle !== detail.cycle ||
                          detail.supersededRequirement ||
                          !["Sourcing", "Offer"].includes(detail.status)
                        }
                        onClick={() => open({ offer })}
                      >
                        Record acceptance / outcome
                      </button>
                    </div>
                  </section>
                ))}
                {!visibleOffers.length ? (
                  <p className="transaction-empty">
                    No commercial offer version has been recorded.
                  </p>
                ) : null}
              </>
            ) : tab === "Findings" ? (
              <>
                <section className="transaction-card">
                  <div className="transaction-card-heading">
                    <Flag size={15} />
                    <h3>Findings and conditions</h3>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={terminal || busy || detail.supersededRequirement}
                      onClick={() => open("finding")}
                    >
                      <Plus size={13} />
                      Record finding
                    </button>
                  </div>
                  <p>
                    Open blocking findings prevent closing. Record a resolution with its retained
                    source, date and named person before advancing.
                  </p>
                </section>
                {visibleFindings.map((f) => (
                  <section className="transaction-card" key={f.id}>
                    <div className="transaction-card-heading">
                      <h3>{f.title}</h3>
                      <Badge
                        tone={
                          f.status === "Resolved"
                            ? "green"
                            : f.severity === "Blocking"
                              ? "red"
                              : "orange"
                        }
                      >
                        {f.status} · {f.severity}
                      </Badge>
                    </div>
                    <p>
                      {f.category} · cycle {f.cycle}
                      {f.dueOn ? ` · due ${f.dueOn}` : ""}
                    </p>
                    <p>{f.detail}</p>
                    {f.sourceId ? <SourceLink id={f.sourceId}>Finding source</SourceLink> : null}
                    {f.status === "Resolved" ? (
                      <>
                        <p className="transaction-attribution">
                          {f.resolution} · {f.resolvedBy} · {f.resolvedOn}
                          <br />
                          {f.resolutionNote}
                        </p>
                        {f.resolutionSourceId ? (
                          <SourceLink id={f.resolutionSourceId}>Resolution evidence</SourceLink>
                        ) : null}
                      </>
                    ) : (
                      <div className="transaction-buttons">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={
                            terminal ||
                            busy ||
                            detail.supersededRequirement ||
                            f.cycle !== detail.cycle
                          }
                          onClick={() => open({ finding: f })}
                        >
                          Record resolution
                        </button>
                      </div>
                    )}
                  </section>
                ))}
                {!visibleFindings.length ? (
                  <p className="transaction-empty">
                    No findings have been recorded. This does not establish that the aircraft or
                    transaction has no issues.
                  </p>
                ) : null}
              </>
            ) : (
              <section className="transaction-card">
                <div className="transaction-card-heading">
                  <History size={15} />
                  <h3>Recorded decisions</h3>
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy || detail.supersededRequirement}
                    onClick={() => open("reopen")}
                  >
                    Reopen a new cycle
                  </button>
                </div>
                <p>
                  Reopening clears the current completion state and starts new evidence and offers.
                  Earlier cycles remain in this history; historical commission events are never
                  automatically rewritten.
                </p>
                {detail.activity.map((a) => (
                  <div className="transaction-history-row" key={a.id}>
                    <strong>{a.action.replace("transaction.", "").replaceAll("-", " ")}</strong>
                    <span>{dateTimeLabel(a.createdAt)}</span>
                    <p>
                      Cycle {String(a.detail.cycle ?? "—")}
                      {typeof a.detail.from === "string" && typeof a.detail.to === "string"
                        ? ` · ${a.detail.from} → ${a.detail.to}`
                        : ""}
                      {typeof a.detail.occurredOn === "string"
                        ? ` · actual event ${a.detail.occurredOn}`
                        : ""}
                    </p>
                    <p>{typeof a.detail.note === "string" ? a.detail.note : ""}</p>
                    {typeof a.detail.recordedBy === "string" ? (
                      <p>Recorded attribution: {a.detail.recordedBy}</p>
                    ) : null}
                    {typeof a.detail.sourceId === "string" ? (
                      <SourceLink id={a.detail.sourceId}>Supporting source</SourceLink>
                    ) : null}
                  </div>
                ))}
                {!detail.activity.length ? <p>No transaction decisions yet.</p> : null}
              </section>
            )}
            <div ref={formRef}>
              {editor ? (
                <TransactionForm
                  key={typeof editor === "string" ? editor : JSON.stringify(editor)}
                  editor={editor}
                  detail={detail}
                  busy={busy}
                  onSave={mutate}
                  onCancel={() => setEditor(null)}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
function SourceLink({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Link
      className="transaction-source"
      href={`/api/sources/${encodeURIComponent(id)}/document`}
      target="_blank"
    >
      <FileText size={12} />
      {children}
    </Link>
  );
}
function SourceSelect({
  detail,
  label = "Retained supporting source",
  optional = false,
  defaultValue = "",
}: {
  detail: TransactionDetail;
  label?: string;
  optional?: boolean;
  defaultValue?: string;
}) {
  return (
    <Field label={label}>
      <select name="sourceId" required={!optional} defaultValue={defaultValue}>
        <option value="">
          {optional
            ? "No retained source for this observation"
            : "Choose a document from your source library"}
        </option>
        {detail.sources.map((s) => (
          <option value={s.id} key={s.id}>
            {s.title}
          </option>
        ))}
      </select>
    </Field>
  );
}
function TransactionForm({
  editor,
  detail,
  busy,
  onSave,
  onCancel,
}: {
  editor: Editor;
  detail: TransactionDetail;
  busy: boolean;
  onSave: (action: TransactionAction) => Promise<boolean>;
  onCancel: () => void;
}) {
  const kind =
    typeof editor === "string"
      ? editor
      : "offer" in editor
        ? "offer-decision"
        : "evidence" in editor
          ? "evidence-decision"
          : "resolve-finding";
  const titles: Record<string, string> = {
    configure: "Next action and transaction basis",
    offer: "Record an existing offer or counteroffer",
    evidence: "Attach a milestone evidence version",
    finding: "Record a condition or finding",
    transition: "Record the next milestone or end outcome",
    reopen: "Reopen a new transaction cycle",
    "offer-decision": "Record the counterparty's decision",
    "evidence-decision": "Review the current evidence version",
    "resolve-finding": "Record a finding's resolution",
  };
  const [offerSide, setOfferSide] = useState("Buyer"),
    [offerKind, setOfferKind] = useState("Offer"),
    [target, setTarget] = useState<TransactionStage>(nextTransactionStage(detail.status) ?? "Lost");
  const selectedEvidence =
    typeof editor === "object" && "evidence" in editor ? editor.evidence : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      note = text(f, "note"),
      sourceId = text(f, "sourceId"),
      occurredOn = text(f, "occurredOn");
    let action: TransactionAction;
    if (kind === "configure")
      action = {
        kind: "configure",
        transactionKind: text(f, "transactionKind") as "Sale" | "Lease",
        nextAction: text(f, "nextAction"),
        dueOn: text(f, "dueOn") || null,
        note,
      };
    else if (kind === "offer")
      action = {
        kind: "offer",
        side: offerSide as "Buyer" | "Seller",
        contactId: text(f, "contactId"),
        offerKind: offerKind as "Offer" | "Counteroffer",
        parentId: text(f, "parentId") || null,
        amount: text(f, "amount"),
        currency: text(f, "currency").toUpperCase(),
        basis: text(f, "basis") as "Purchase price" | "Monthly rent" | "Hourly rate",
        quantity: Number(text(f, "quantity")),
        offeredOn: text(f, "offeredOn"),
        expiresOn: text(f, "expiresOn") || null,
        terms: text(f, "terms"),
        sourceId,
        note,
        attested: true,
      };
    else if (kind === "evidence")
      action = {
        kind: "evidence",
        key: text(f, "key") as (typeof milestoneKeys)[number],
        sourceId,
        occurredOn,
        party: text(f, "party"),
        detail: text(f, "detail"),
        note,
        attested: true,
      };
    else if (kind === "finding")
      action = {
        kind: "finding",
        category: text(f, "category") as "Technical" | "Title" | "Commercial" | "Other",
        severity: text(f, "severity") as "Blocking" | "Question",
        title: text(f, "title"),
        detail: text(f, "detail"),
        sourceId: sourceId || null,
        dueOn: text(f, "dueOn") || null,
        note,
        attested: true,
      };
    else if (kind === "transition")
      action = {
        kind: "transition",
        status: target,
        occurredOn,
        sourceId: sourceId || null,
        note,
        attested: true,
      };
    else if (kind === "reopen")
      action = {
        kind: "reopen",
        occurredOn,
        sourceId,
        nextAction: text(f, "nextAction"),
        note,
        attested: true,
      };
    else if (typeof editor === "object" && "offer" in editor)
      action = {
        kind: "offer-decision",
        offerId: editor.offer.id,
        decision: text(f, "decision") as "Accepted" | "Rejected" | "Withdrawn",
        sourceId,
        decidedOn: occurredOn,
        recordedBy: text(f, "recordedBy"),
        note,
        attested: true,
      };
    else if (selectedEvidence)
      action = {
        kind: "evidence-decision",
        evidenceId: selectedEvidence.id,
        state: text(f, "state") as "Reviewed" | "Verification recorded" | "Waiver recorded",
        recordedBy: text(f, "recordedBy"),
        occurredOn,
        note,
        attested: true,
      };
    else if (typeof editor === "object" && "finding" in editor)
      action = {
        kind: "resolve-finding",
        findingId: editor.finding.id,
        resolution: text(f, "resolution") as "Remedied" | "Accepted" | "Waived",
        sourceId,
        recordedBy: text(f, "recordedBy"),
        occurredOn,
        note,
        attested: true,
      };
    else return;
    await onSave(action);
  }
  const gaps = kind === "transition" ? transactionGaps(detail, target) : [];
  return (
    <section className="transaction-editor">
      <h3>{titles[kind]}</h3>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {kind === "configure" ? (
            <>
              <div className="transaction-fields">
                <Field label="Transaction type">
                  <select name="transactionKind" defaultValue={detail.transactionKind}>
                    <option disabled={detail.requirement?.transactionKind === "Lease"}>Sale</option>
                    <option disabled={detail.requirement?.transactionKind === "Sale"}>Lease</option>
                  </select>
                </Field>
                <Field label="Follow-up due date">
                  <input type="date" name="dueOn" defaultValue={detail.dueOn ?? ""} />
                </Field>
              </div>
              <Field label="Next action">
                <textarea
                  name="nextAction"
                  required
                  minLength={2}
                  maxLength={300}
                  defaultValue={detail.nextAction}
                />
              </Field>
            </>
          ) : null}
          {kind === "offer" ? (
            <>
              <div className="transaction-fields">
                <Field label="Offering side">
                  <select value={offerSide} onChange={(e) => setOfferSide(e.target.value)}>
                    <option>Buyer</option>
                    <option>Seller</option>
                  </select>
                </Field>
                <Field label="Record type">
                  <select value={offerKind} onChange={(e) => setOfferKind(e.target.value)}>
                    <option>Offer</option>
                    <option>Counteroffer</option>
                  </select>
                </Field>
                <Field label="Counterparty contact">
                  <select name="contactId" required defaultValue="">
                    <option value="" disabled>
                      Select a saved contact
                    </option>
                    {detail.contacts
                      .filter((c) => [offerSide, "Broker"].includes(c.type))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.company}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Amount per aircraft">
                  <input
                    name="amount"
                    required
                    inputMode="decimal"
                    placeholder="Plain decimal, e.g. 21500000.00"
                    pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?"
                  />
                </Field>
                <Field label="Currency">
                  <input
                    name="currency"
                    required
                    minLength={3}
                    maxLength={3}
                    placeholder="USD, EUR, INR…"
                    pattern="[A-Za-z]{3}"
                    defaultValue={
                      detail.transactionKind === "Lease"
                        ? (detail.requirement?.leaseCurrency ?? "")
                        : "USD"
                    }
                  />
                </Field>
                <Field label="Price basis">
                  <select
                    name="basis"
                    defaultValue={
                      detail.transactionKind === "Sale"
                        ? "Purchase price"
                        : (detail.requirement?.leaseBasis ?? "Monthly rent")
                    }
                  >
                    {detail.transactionKind === "Sale" ? (
                      <option>Purchase price</option>
                    ) : (
                      <>
                        <option>Monthly rent</option>
                        <option>Hourly rate</option>
                      </>
                    )}
                  </select>
                </Field>
                <Field
                  label={`Aircraft quantity · ${detail.aircraft?.serial ?? "one saved serial"}`}
                >
                  <input
                    type="number"
                    name="quantity"
                    min={1}
                    max={1}
                    required
                    value={1}
                    readOnly
                  />
                </Field>
                <Field label="Offer date">
                  <input type="date" name="offeredOn" required max={calendarDate()} />
                </Field>
                <Field label="Expiry date (if stated)">
                  <input type="date" name="expiresOn" />
                </Field>
              </div>
              {offerKind === "Counteroffer" ? (
                <Field label="Responds to offer version">
                  <select name="parentId" required defaultValue="">
                    <option value="" disabled>
                      Select a current-cycle offer
                    </option>
                    {detail.offers
                      .filter((o) => o.cycle === detail.cycle)
                      .map((o) => (
                        <option value={o.id} key={o.id}>
                          {o.side} · {o.amount} {o.currency} · {o.offeredOn}
                        </option>
                      ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Stated terms and conditions">
                <textarea name="terms" required minLength={20} maxLength={3000} rows={4} />
              </Field>
            </>
          ) : null}
          {kind === "evidence" ? (
            <>
              <Field label="Milestone">
                <select name="key">
                  {milestoneKeys.map((key) => (
                    <option key={key}>{key}</option>
                  ))}
                </select>
              </Field>
              <Field label="Source party / responsible organization">
                <input name="party" required minLength={2} maxLength={300} />
              </Field>
              <Field label="What the retained record establishes">
                <textarea name="detail" required minLength={20} maxLength={3000} rows={3} />
              </Field>
              <p>
                Every new evidence version starts as Received. Replacing a previously reviewed
                document requires a new review and verification.
              </p>
            </>
          ) : null}
          {kind === "finding" ? (
            <>
              <div className="transaction-fields">
                <Field label="Finding category">
                  <select name="category">
                    {["Technical", "Title", "Commercial", "Other"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Severity">
                  <select name="severity">
                    <option>Blocking</option>
                    <option>Question</option>
                  </select>
                </Field>
                <Field label="Resolution due date">
                  <input name="dueOn" type="date" />
                </Field>
              </div>
              <Field label="Finding title">
                <input name="title" required minLength={2} maxLength={300} />
              </Field>
              <Field label="Finding details and acceptance conditions">
                <textarea name="detail" required minLength={20} maxLength={3000} rows={3} />
              </Field>
            </>
          ) : null}
          {kind === "transition" ? (
            <>
              <Field label="Next stage / actual outcome">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value as TransactionStage)}
                >
                  {nextTransactionStage(detail.status) ? (
                    <option>{nextTransactionStage(detail.status)}</option>
                  ) : null}
                  <option>Lost</option>
                  <option>Cancelled</option>
                </select>
              </Field>
              {gaps.length ? (
                <div className="transaction-warning">
                  <strong>Still required</strong>
                  <ul>
                    {gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>
                  The recorded prerequisites support this transition. Confirm the actual event and
                  basis below.
                </p>
              )}
            </>
          ) : null}
          {kind === "reopen" ? (
            <>
              <p>
                This starts cycle {detail.cycle + 1} in Sourcing. Previous evidence, offers and
                outcome history stay in the record. Current completion evidence is cleared; old
                revenue records remain historical.
              </p>
              <Field label="Next action for the new cycle">
                <textarea name="nextAction" required minLength={2} maxLength={300} />
              </Field>
            </>
          ) : null}
          {kind === "offer-decision" ? (
            <Field label="Counterparty decision">
              <select name="decision">
                <option>Accepted</option>
                <option>Rejected</option>
                <option>Withdrawn</option>
              </select>
            </Field>
          ) : null}
          {selectedEvidence ? (
            <>
              <SourceLink id={selectedEvidence.sourceId}>{selectedEvidence.sourceTitle}</SourceLink>
              <Field label="Review decision">
                <select
                  name="state"
                  defaultValue={
                    selectedEvidence.state === "Received" ? "Reviewed" : "Verification recorded"
                  }
                >
                  {selectedEvidence.state === "Received" ? (
                    <option>Reviewed</option>
                  ) : (
                    <>
                      <option>Verification recorded</option>
                      {["Letter of intent", "Pre-purchase inspection"].includes(
                        selectedEvidence.key,
                      ) ? (
                        <option>Waiver recorded</option>
                      ) : null}
                    </>
                  )}
                </select>
              </Field>
              <p>
                Named verification or a written waiver is a founder-recorded attribution. Supply the
                responsible person's name and the exact basis in the retained document.
              </p>
            </>
          ) : null}
          {kind === "resolve-finding" ? (
            <Field label="Recorded resolution">
              <select name="resolution">
                <option>Remedied</option>
                <option>Accepted</option>
                <option>Waived</option>
              </select>
            </Field>
          ) : null}
          {["offer-decision", "evidence-decision", "resolve-finding"].includes(kind) ? (
            <Field label="Responsible person / verifier">
              <input
                name="recordedBy"
                required
                minLength={2}
                maxLength={300}
                placeholder="Named person who made the decision or performed the verification"
              />
            </Field>
          ) : null}
          {!["configure", "offer", "finding"].includes(kind) ? (
            <Field label="Actual event / review date">
              <input name="occurredOn" type="date" required max={calendarDate()} />
            </Field>
          ) : null}
          {!["configure", "evidence-decision"].includes(kind) ? (
            <SourceSelect
              detail={detail}
              optional={kind === "finding" || (kind === "transition" && !isTerminal(target))}
              defaultValue={
                kind === "transition" && target === "Completed"
                  ? (detail.evidence.find(
                      (e) =>
                        e.cycle === detail.cycle && e.current && e.key === "Delivery acceptance",
                    )?.sourceId ?? "")
                  : ""
              }
            />
          ) : null}
          <Field label="Review note and basis">
            <textarea
              name="note"
              required
              minLength={20}
              maxLength={3000}
              rows={3}
              placeholder="Describe the reviewed evidence, who supplied it, and the basis for this record."
            />
          </Field>
          {kind !== "configure" ? (
            <label className="transaction-consent">
              <input name="attested" type="checkbox" required />I reviewed the retained evidence,
              named attribution and current transaction context.
            </label>
          ) : null}
          <div className="transaction-form-actions">
            <button type="button" className="button button-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || gaps.length > 0}
            >
              {busy ? "Saving…" : "Save reviewed record"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
