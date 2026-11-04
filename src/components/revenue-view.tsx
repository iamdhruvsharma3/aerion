"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileCheck2,
  FileText,
  Landmark,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { calendarDate, dateLabel, dateTimeLabel } from "@/lib/format";
import { revenueMoney, type Currency } from "@/lib/revenue/money";
import type {
  EngagementTerms,
  RevenueAction,
  RevenueCenter,
  RevenueDetail,
  RevenueTotals,
} from "@/lib/revenue/schema";
import { useWorkspace } from "./workspace-provider";
import { Badge, EmptyState, Modal } from "./ui";
import { EngagementTermsForm, RevenueActionForm, type RevenueEditor } from "./revenue-forms";

const emptyCenter: RevenueCenter = { engagements: [], totals: [], sources: [] };
type Tab = "Agreement" | "Earned fees" | "Invoices" | "Cash & expenses" | "History";
const tabs: Tab[] = ["Agreement", "Earned fees", "Invoices", "Cash & expenses", "History"];
export function RevenueView() {
  return (
    <Suspense fallback={<p className="revenue-loading">Opening engagements & revenue…</p>}>
      <RevenueDesk />
    </Suspense>
  );
}
export default RevenueView;
function RevenueDesk() {
  const { data } = useWorkspace(),
    router = useRouter(),
    params = useSearchParams();
  const selected = params.get("engagement"),
    [center, setCenter] = useState<RevenueCenter>(emptyCenter),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("All"),
    [currency, setCurrency] = useState<Currency | null>(null);
  const createKey = useRef(crypto.randomUUID());
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await api<RevenueCenter>("/api/revenue", { signal });
    if (!signal?.aborted) {
      setCenter(result);
      setCurrency((current) => current ?? result.totals[0]?.currency ?? null);
      setError("");
    }
    return result;
  }, []);
  useEffect(() => {
    const c = new AbortController();
    load(c.signal)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [load]);
  async function create(terms: EngagementTerms) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<RevenueDetail>("/api/revenue", {
        method: "POST",
        body: JSON.stringify({ terms, idempotencyKey: createKey.current }),
      });
      await load();
      setCreating(false);
      createKey.current = crypto.randomUUID();
      router.replace(`/revenue?engagement=${encodeURIComponent(result.engagement.id)}`);
    } finally {
      setBusy(false);
    }
  }
  const currencyTotals = center.totals.find((t) => t.currency === currency),
    query = search.trim().toLowerCase();
  const filtered = center.engagements.filter(
    (e) =>
      (status === "All" || e.effectiveStatus === status) &&
      (!query ||
        `${e.terms.title} ${e.parties.client.company} ${e.parties.client.name} ${e.parties.payer.company}`
          .toLowerCase()
          .includes(query)),
  );
  return (
    <div className="revenue-page">
      <header className="revenue-hero">
        <div>
          <div className="eyebrow">AERION / ENGAGEMENTS & REVENUE</div>
          <h1>
            From agreement
            <br />
            <em>to received.</em>
          </h1>
          <p>
            Keep the client, fee terms and evidence together.
            <br />
            Know what is expected, earned, billed and actually received.
          </p>
        </div>
        <div className="revenue-hero-side">
          <Landmark size={25} />
          <span>{center.engagements.filter((e) => e.status !== "Draft").length}</span>
          <p>
            reviewed engagement
            {center.engagements.filter((e) => e.status !== "Draft").length === 1 ? "" : "s"}
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={!data.contacts.length || loading}
            onClick={() => {
              createKey.current = crypto.randomUUID();
              setCreating(true);
            }}
          >
            <Plus size={14} />
            New engagement
          </button>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="revenue-overview">
        <div className="revenue-heading">
          <div>
            <span className="revenue-index">01</span>
            <h2>Your revenue record</h2>
          </div>
          <div className="revenue-controls">
            {center.totals.length ? (
              <label>
                Currency{" "}
                <select
                  aria-label="Revenue display currency"
                  value={currency ?? ""}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                >
                  {center.totals.map((t) => (
                    <option key={t.currency}>{t.currency}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh revenue records"
              onClick={() => load().catch((e) => setError(e.message))}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
        {currencyTotals ? (
          <Totals values={currencyTotals} />
        ) : (
          <div className="revenue-empty-metrics">
            <Wallet size={22} />
            <div>
              <strong>No recorded revenue yet</strong>
              <p>
                Create a Draft engagement from an actual client relationship. No expected fee or
                cash is assumed.
              </p>
            </div>
          </div>
        )}
        <p className="revenue-hint">
          Amounts stay in their recorded currency; currencies are never added together. Agreed fee
          estimates can include already-earned amounts. Cash totals include any invoice
          taxes/charges; net recorded cash is not an accounting profit or tax calculation.
        </p>
        {center.engagements.some((e) => e.estimatedMinor === null) ? (
          <p className="revenue-hint">
            {center.engagements.filter((e) => e.estimatedMinor === null).length} percentage
            engagement(s) have no estimated calculation basis. Their unknown fee amounts are
            excluded from estimated/agreed totals.
          </p>
        ) : null}
      </section>
      <section>
        <div className="revenue-heading">
          <div>
            <span className="revenue-index">02</span>
            <h2>Client engagements</h2>
          </div>
          <Link href="/sources" className="text-link">
            Import signed evidence <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="revenue-filters">
          <label>
            Find an engagement
            <input
              aria-label="Find an engagement"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Client, payer or engagement"
            />
          </label>
          <label>
            Status
            <select
              aria-label="Engagement status filter"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {["All", "Draft", "Active", "Upcoming", "Expired", "Ended"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="revenue-loading" role="status">
            Loading the recorded engagements…
          </p>
        ) : filtered.length ? (
          <div className="revenue-engagement-list">
            {filtered.map((e) => (
              <button
                type="button"
                className="revenue-engagement-row"
                key={e.id}
                onClick={() => router.replace(`/revenue?engagement=${encodeURIComponent(e.id)}`)}
              >
                <span className="revenue-row-icon">
                  <FileCheck2 size={19} />
                </span>
                <span className="revenue-row-main">
                  <strong>{e.terms.title}</strong>
                  <small>
                    {e.parties.client.company} · {e.terms.representation}
                  </small>
                  <small>
                    Payer: {e.parties.payer.company} · {e.terms.currency}
                  </small>
                </span>
                <span className="revenue-row-value">
                  <strong>{revenueMoney(e.estimatedMinor, e.terms.currency)}</strong>
                  <small>
                    {e.terms.feeType === "Percentage"
                      ? `${e.terms.percentage}% · estimated basis`
                      : "Agreed fixed amount"}
                  </small>
                </span>
                <Badge
                  tone={
                    e.effectiveStatus === "Active"
                      ? "green"
                      : e.effectiveStatus === "Draft"
                        ? "orange"
                        : "neutral"
                  }
                >
                  {e.effectiveStatus}
                </Badge>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              center.engagements.length
                ? "No matching engagements"
                : "Record your first client engagement"
            }
            detail={
              data.contacts.length
                ? "Start with the actual scope, payer, fee terms and signed document. Activation and earnings are separate reviewed records."
                : "Save the client and fee-payer contacts in Contacts, then create the engagement here."
            }
            action={
              !data.contacts.length ? (
                <Link href="/contacts" className="button button-secondary">
                  Open contacts <ArrowUpRight size={13} />
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
      {creating ? (
        <Modal
          title="Record a client engagement"
          description="Retain the relationship and actual compensation terms. This starts as a Draft and does not record income."
          onClose={() => {
            if (!busy) setCreating(false);
          }}
          wide
          className="revenue-modal"
        >
          <EngagementTermsForm
            sources={center.sources}
            busy={busy}
            onSave={create}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      ) : null}
      {selected ? (
        <EngagementWorkspace
          id={selected}
          onClose={() => router.replace("/revenue")}
          onChanged={() => load().catch((e) => setError(e.message))}
        />
      ) : null}
    </div>
  );
}
function Totals({ values, compact = false }: { values: RevenueTotals; compact?: boolean }) {
  const labels = [
    {
      key: "contractedMinor",
      label: "Agreed fee / estimates",
      hint: "Activated agreements; before receipts",
    },
    { key: "earnedMinor", label: "Recorded earned fees", hint: "Evidence-backed earning events" },
    {
      key: "outstandingMinor",
      label: "Outstanding invoices",
      hint: "Issued totals less recorded receipts",
    },
    {
      key: "receivedMinor",
      label: "Allocated invoice cash",
      hint: "Portions of retained incoming transfers",
    },
  ] as const;
  return (
    <div className={`revenue-metrics ${compact ? "revenue-metrics-compact" : ""}`}>
      {labels.map((item, index) => (
        <div key={item.key}>
          <span className="revenue-index">0{index + 1}</span>
          <p>{item.label}</p>
          <strong>{revenueMoney(values[item.key], values.currency)}</strong>
          <small>{item.hint}</small>
        </div>
      ))}
    </div>
  );
}
function EvidenceLink({ id, label = "Open evidence" }: { id: string; label?: string }) {
  return (
    <Link
      href={`/api/sources/${encodeURIComponent(id)}/document`}
      target="_blank"
      className="text-link"
    >
      {label} <ArrowUpRight size={12} />
    </Link>
  );
}

function EngagementWorkspace({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RevenueDetail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState<Tab>("Agreement"),
    [busy, setBusy] = useState(false),
    [editor, setEditor] = useState<RevenueEditor | null>(null);
  const key = useRef(crypto.randomUUID()),
    editorRef = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<RevenueDetail>(`/api/revenue/${encodeURIComponent(id)}`, { signal });
      if (!signal?.aborted) setDetail(result);
      return result;
    },
    [id],
  );
  useEffect(() => {
    const c = new AbortController();
    load(c.signal).catch((e) => {
      if (!c.signal.aborted) setError(e.message);
    });
    return () => c.abort();
  }, [load]);
  useEffect(() => {
    if (editor) editorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editor]);
  function open(value: RevenueEditor) {
    key.current = crypto.randomUUID();
    setEditor(value);
    setNotice("");
    setError("");
  }
  function changeTab(next: Tab) {
    setTab(next);
    setEditor(null);
    setError("");
  }
  async function mutate(action: RevenueAction) {
    if (!detail || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<RevenueDetail>(`/api/revenue/${id}`, {
        method: "POST",
        body: JSON.stringify({
          revision: detail.engagement.revision,
          idempotencyKey: key.current,
          action,
        }),
      });
      setDetail(result);
      setEditor(null);
      setNotice(
        action.kind === "invoice"
          ? "Invoice issued and retained locally. Review its document before sharing."
          : "Evidence-backed record saved.",
      );
      key.current = crypto.randomUUID();
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : "This revenue action was not saved.";
      setError(message);
      if (e instanceof ApiError && e.status === 409) await load().catch(() => {});
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const engagement = detail?.engagement,
    terms = engagement?.terms,
    liveEarning = detail?.earnings.find((e) => e.status === "Recorded");
  const paid =
    detail?.invoices.filter((i) => i.status === "Issued" && BigInt(i.outstandingMinor) === 0n)
      .length ?? 0;
  return (
    <Modal
      title={terms?.title ?? "Opening engagement"}
      description="Review the client agreement, earned fee, issued invoice and payment evidence as separate records."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
      className="revenue-modal"
    >
      {error ? (
        <p className="form-error revenue-message" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="revenue-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!detail || !engagement || !terms ? (
        <p className="revenue-loading">Loading the current engagement…</p>
      ) : (
        <>
          <div className="revenue-case-header">
            <div>
              <span className="eyebrow">
                {terms.representation.toUpperCase()} / CLIENT ENGAGEMENT
              </span>
              <h3>{engagement.parties.client.company}</h3>
              <p>
                Fee payer: {engagement.parties.payer.company} · {engagement.parties.payer.email}
              </p>
            </div>
            <Badge
              tone={
                engagement.effectiveStatus === "Active"
                  ? "green"
                  : engagement.status === "Draft"
                    ? "orange"
                    : "neutral"
              }
            >
              {engagement.effectiveStatus}
            </Badge>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh engagement"
              disabled={busy}
              onClick={() => load().catch((e) => setError(e.message))}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <ol className="revenue-progress" aria-label="Engagement revenue progress">
            {[
              { title: "Signed agreement", ready: engagement.status !== "Draft" },
              { title: "Earning recorded", ready: !!liveEarning },
              {
                title: "Invoice issued",
                ready: detail.invoices.some((i) => i.status === "Issued"),
              },
              {
                title: "Receipt recorded",
                ready: detail.receipts.some((r) => r.status === "Recorded"),
              },
              { title: "Invoice paid", ready: paid > 0 },
            ].map((s, index) => (
              <li key={s.title} className={s.ready ? "is-ready" : ""}>
                {s.ready ? <Check size={17} /> : <span>0{index + 1}</span>}
                <div>
                  <strong>{s.title}</strong>
                  <small>{s.ready ? "Recorded" : "Pending"}</small>
                </div>
              </li>
            ))}
          </ol>
          {detail.completionWarning ? (
            <p className="revenue-warning" role="status">
              {detail.completionWarning}
            </p>
          ) : null}
          <div className="revenue-tabs" role="tablist" aria-label="Engagement records">
            {tabs.map((t, index) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls={`revenue-panel-${index}`}
                id={`revenue-tab-${index}`}
                key={t}
                onClick={() => changeTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div
            className="revenue-case-panel"
            role="tabpanel"
            aria-labelledby={`revenue-tab-${tabs.indexOf(tab)}`}
            id={`revenue-panel-${tabs.indexOf(tab)}`}
          >
            {tab === "Agreement" ? (
              <>
                <div className="revenue-case-grid">
                  <section className="revenue-card">
                    <div className="revenue-card-heading">
                      <FileCheck2 size={18} />
                      <h3>Agreed work & fee</h3>
                    </div>
                    <p className="revenue-body">{terms.scope}</p>
                    <dl className="revenue-facts">
                      <div>
                        <dt>Fee method</dt>
                        <dd>
                          {terms.feeType}
                          {terms.percentage ? ` · ${terms.percentage}%` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>Fee / estimate</dt>
                        <dd>{revenueMoney(engagement.estimatedMinor, terms.currency)}</dd>
                      </div>
                      <div>
                        <dt>Term starts</dt>
                        <dd>{dateLabel(terms.startsOn)}</dd>
                      </div>
                      <div>
                        <dt>Term ends</dt>
                        <dd>{dateLabel(terms.endsOn)}</dd>
                      </div>
                    </dl>
                    <p className="revenue-hint">{terms.basisDescription}</p>
                    {engagement.status === "Draft" ? (
                      <div className="revenue-buttons">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy}
                          onClick={() => open({ kind: "edit" })}
                        >
                          Edit Draft terms
                        </button>
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={busy}
                          onClick={() => open({ kind: "activate" })}
                        >
                          Review & activate
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="revenue-hint">
                          Activation review: {engagement.activationNote}
                        </p>
                        {engagement.status === "Active" ? (
                          <button
                            type="button"
                            className="text-link"
                            disabled={busy}
                            onClick={() => open({ kind: "end" })}
                          >
                            Record engagement ending
                          </button>
                        ) : (
                          <p className="revenue-hint">
                            Ended {dateLabel(engagement.endedOn)} · {engagement.endedNote}
                          </p>
                        )}
                      </>
                    )}
                  </section>
                  <section className="revenue-card">
                    <h3>Earning & payment conditions</h3>
                    <span className="revenue-label">Agreed trigger · {terms.earningTrigger}</span>
                    <p className="revenue-body">{terms.earningTerms}</p>
                    <span className="revenue-label">Payment terms</span>
                    <p className="revenue-body">{terms.paymentTerms}</p>
                    {terms.signedSourceId ? (
                      <div className="revenue-evidence">
                        <EvidenceLink
                          id={terms.signedSourceId}
                          label="Retained signed engagement"
                        />
                        <p className="revenue-hint">
                          Signatory: {terms.signatory || "Not recorded"}
                          <br />
                          Signed: {dateLabel(terms.signedOn)}
                        </p>
                      </div>
                    ) : (
                      <p className="revenue-warning">
                        Attach the signed engagement and record its signatory/date before
                        activation.
                      </p>
                    )}
                    {terms.dealId ? (
                      <Link
                        href={`/deals?deal=${encodeURIComponent(terms.dealId)}`}
                        className="text-link"
                      >
                        Linked opportunity <ArrowUpRight size={12} />
                      </Link>
                    ) : null}
                    {terms.requirementId ? (
                      <p>
                        <Link
                          href={`/execution?requirement=${encodeURIComponent(terms.requirementId)}`}
                          className="text-link"
                        >
                          Buyer execution desk <ArrowUpRight size={12} />
                        </Link>
                      </p>
                    ) : null}
                  </section>
                </div>
                <Totals values={engagement.totals} compact />
              </>
            ) : null}
            {tab === "Earned fees" ? (
              <>
                <div className="revenue-heading">
                  <div>
                    <h3>Recorded earning events</h3>
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy || engagement.status === "Draft" || !!liveEarning}
                    onClick={() => open({ kind: "earn" })}
                  >
                    <Plus size={13} />
                    Record earned fee
                  </button>
                </div>
                <p className="revenue-hint">
                  A fee becomes recorded as earned only after your review of its contractual trigger
                  and retained evidence. The recorded amount is distinct from an invoice or payment.
                </p>
                {detail.earnings.length ? (
                  detail.earnings.map((earning) => {
                    const remaining =
                      BigInt(earning.amountMinor) -
                      detail.invoices
                        .filter((i) => i.earningId === earning.id && i.status === "Issued")
                        .reduce((n, i) => n + BigInt(i.subtotalMinor), 0n);
                    return (
                      <article className="revenue-card" key={earning.id}>
                        <div className="revenue-card-heading">
                          <h3>{revenueMoney(earning.amountMinor, terms.currency)}</h3>
                          <Badge tone={earning.status === "Recorded" ? "green" : "neutral"}>
                            {earning.status}
                          </Badge>
                        </div>
                        <p className="revenue-body">
                          Earned {dateLabel(earning.earnedOn)}
                          {earning.basisMinor
                            ? ` · actual basis ${revenueMoney(earning.basisMinor, terms.currency)} × ${terms.percentage}%`
                            : ""}
                        </p>
                        <p className="revenue-hint">{earning.note}</p>
                        {earning.transactionSnapshot ? (
                          <p className="revenue-hint">
                            Closing cycle {earning.transactionSnapshot.cycle} · completed{" "}
                            {dateLabel(earning.transactionSnapshot.completedOn)}
                          </p>
                        ) : null}
                        <EvidenceLink id={earning.sourceId} />
                        {earning.status === "Recorded" ? (
                          <div className="revenue-buttons">
                            <button
                              type="button"
                              className="button button-primary"
                              disabled={busy || remaining <= 0n}
                              onClick={() => open({ kind: "invoice", targetId: earning.id })}
                            >
                              Issue invoice <ArrowRight size={13} />
                            </button>
                            <span className="revenue-hint">
                              Unbilled fee: {revenueMoney(remaining, terms.currency)}
                            </span>
                            <button
                              type="button"
                              className="text-link"
                              disabled={busy}
                              onClick={() => open({ kind: "void-earning", targetId: earning.id })}
                            >
                              Void with evidence
                            </button>
                          </div>
                        ) : (
                          <p className="revenue-hint">Void record: {earning.voidNote}</p>
                        )}
                      </article>
                    );
                  })
                ) : (
                  <div className="revenue-inline-empty">
                    {engagement.status === "Draft"
                      ? "Review and activate the signed client engagement first."
                      : "No earned fee is recorded yet. Obtain evidence that the actual agreed earning event occurred."}
                  </div>
                )}
              </>
            ) : null}
            {tab === "Invoices" ? (
              <>
                <div className="revenue-heading">
                  <div>
                    <h3>Issued invoice documents</h3>
                  </div>
                </div>
                <p className="revenue-hint">
                  Issue from a recorded earned fee. Each invoice preserves its issuer, payer,
                  currency, description and amounts; corrections use a retained void/reissue
                  history.
                </p>
                {detail.invoices.length ? (
                  detail.invoices.map((invoice) => (
                    <article className="revenue-card" key={invoice.id}>
                      <div className="revenue-card-heading">
                        <FileText size={17} />
                        <h3>{invoice.number}</h3>
                        <Badge
                          tone={
                            invoice.status === "Voided"
                              ? "neutral"
                              : BigInt(invoice.outstandingMinor) === 0n
                                ? "green"
                                : invoice.dueOn < calendarDate()
                                  ? "orange"
                                  : "neutral"
                          }
                        >
                          {invoice.status === "Voided"
                            ? "Voided"
                            : BigInt(invoice.outstandingMinor) === 0n
                              ? "Paid"
                              : BigInt(invoice.receivedMinor) > 0n
                                ? "Part paid"
                                : invoice.dueOn < calendarDate()
                                  ? "Overdue"
                                  : "Issued"}
                        </Badge>
                      </div>
                      <dl className="revenue-facts">
                        <div>
                          <dt>Total</dt>
                          <dd>{revenueMoney(invoice.totalMinor, invoice.currency)}</dd>
                        </div>
                        <div>
                          <dt>Outstanding</dt>
                          <dd>{revenueMoney(invoice.outstandingMinor, invoice.currency)}</dd>
                        </div>
                        <div>
                          <dt>Issued</dt>
                          <dd>{dateLabel(invoice.issuedOn)}</dd>
                        </div>
                        <div>
                          <dt>Due</dt>
                          <dd>{dateLabel(invoice.dueOn)}</dd>
                        </div>
                      </dl>
                      <p className="revenue-hint">
                        Bill to {invoice.snapshot.billTo.company} · {invoice.snapshot.billTo.email}
                      </p>
                      <div className="revenue-buttons">
                        <Link
                          href={`/api/revenue/invoices/${invoice.id}/document`}
                          target="_blank"
                          className="button button-secondary"
                        >
                          Open / print invoice <ArrowUpRight size={13} />
                        </Link>
                        <a
                          href={`/api/revenue/invoices/${invoice.id}/document?download=1`}
                          className="text-link"
                        >
                          Download document
                        </a>
                        {invoice.status === "Issued" && BigInt(invoice.outstandingMinor) > 0n ? (
                          <button
                            type="button"
                            className="button button-primary"
                            disabled={busy}
                            onClick={() => open({ kind: "receipt", targetId: invoice.id })}
                          >
                            Record receipt
                          </button>
                        ) : null}
                        {invoice.status === "Issued" ? (
                          <button
                            type="button"
                            className="text-link"
                            disabled={busy || BigInt(invoice.receivedMinor) > 0n}
                            onClick={() => open({ kind: "void-invoice", targetId: invoice.id })}
                          >
                            Void invoice
                          </button>
                        ) : null}
                      </div>
                      {invoice.voidNote ? (
                        <p className="revenue-hint">Voided: {invoice.voidNote}</p>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <div className="revenue-inline-empty">
                    Open Earned fees to issue an invoice for an evidence-backed earned amount.
                  </div>
                )}
              </>
            ) : null}
            {tab === "Cash & expenses" ? (
              <>
                <div className="revenue-cash-summary">
                  <div>
                    <span>Allocated invoice cash</span>
                    <strong>{revenueMoney(engagement.totals.receivedMinor, terms.currency)}</strong>
                  </div>
                  <div>
                    <span>Paid expenses recorded</span>
                    <strong>{revenueMoney(engagement.totals.expensesMinor, terms.currency)}</strong>
                  </div>
                  <div>
                    <span>Net recorded cash</span>
                    <strong>{revenueMoney(engagement.totals.netCashMinor, terms.currency)}</strong>
                  </div>
                </div>
                <p className="revenue-hint">
                  Net recorded cash is allocated invoice receipts less the expenses entered here. It
                  includes any invoice taxes/charges and excludes unrecorded costs and tax
                  liabilities; it is not profit. Unallocated portions of retained transfers are
                  shown separately below.
                </p>
                <section className="revenue-card">
                  <h3>Recorded incoming transfers for this payer</h3>
                  <p className="revenue-hint">
                    Each original transfer has one retained total, unique reference, date and
                    evidence. Allocate it from an issued invoice. Reversing an allocation restores
                    its unallocated amount; voiding a record does not transfer or refund money.
                  </p>
                  {detail.payments.length ? (
                    detail.payments.map((payment) => (
                      <div className="revenue-ledger-row" key={payment.id}>
                        <div>
                          <strong>
                            {payment.reference} ·{" "}
                            {revenueMoney(payment.amountMinor, payment.currency)}
                          </strong>
                          <p>
                            Allocated across all invoices:{" "}
                            {revenueMoney(payment.allocatedMinor, payment.currency)}
                            <br />
                            Unallocated: {revenueMoney(payment.unallocatedMinor, payment.currency)}
                          </p>
                          <small>
                            {dateLabel(payment.receivedOn)} · {payment.payer.company}
                          </small>
                          {payment.legacyAmount ? (
                            <p className="revenue-hint">
                              Legacy allocation retained at its recorded amount. To correct the full
                              transfer total, reverse allocations and void the old record with
                              evidence, then record its corrected original details.
                            </p>
                          ) : null}
                          <p>
                            <EvidenceLink
                              id={payment.sourceId}
                              label="Original transfer evidence"
                            />
                          </p>
                          {payment.voidNote ? <small>Void record: {payment.voidNote}</small> : null}
                        </div>
                        <div>
                          <Badge tone={payment.status === "Recorded" ? "green" : "neutral"}>
                            {payment.status}
                          </Badge>
                          {payment.status === "Recorded" ? (
                            <button
                              type="button"
                              className="text-link"
                              disabled={busy || BigInt(payment.allocatedMinor) > 0n}
                              onClick={() => open({ kind: "void-payment", targetId: payment.id })}
                            >
                              Void incorrect record
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="revenue-hint">
                      No incoming transfer is recorded for this fee payer.
                    </p>
                  )}
                </section>
                <section className="revenue-card">
                  <h3>Invoice receipt allocations</h3>
                  <p className="revenue-hint">
                    Open an issued invoice to allocate an actual received payment. Partial receipts
                    remain separate and reduce only that invoice’s balance.
                  </p>
                  {detail.receipts.length ? (
                    detail.receipts.map((receipt) => (
                      <div className="revenue-ledger-row" key={receipt.id}>
                        <div>
                          <strong>{revenueMoney(receipt.amountMinor, terms.currency)}</strong>
                          <p>
                            {receipt.reference} · {dateLabel(receipt.receivedOn)}
                          </p>
                          <small>{receipt.note}</small>
                          <p>
                            <EvidenceLink id={receipt.sourceId} />
                          </p>
                          {receipt.reversalNote ? (
                            <small>Reversal: {receipt.reversalNote}</small>
                          ) : null}
                        </div>
                        <div>
                          <Badge tone={receipt.status === "Recorded" ? "green" : "neutral"}>
                            {receipt.status}
                          </Badge>
                          {receipt.status === "Recorded" ? (
                            <button
                              type="button"
                              className="text-link"
                              disabled={busy}
                              onClick={() =>
                                open({ kind: "reverse-receipt", targetId: receipt.id })
                              }
                            >
                              Record reversal
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="revenue-hint">No payment receipts are recorded.</p>
                  )}
                </section>
                <section className="revenue-card">
                  <div className="revenue-card-heading">
                    <h3>Paid engagement expenses</h3>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => open({ kind: "expense" })}
                    >
                      <Plus size={13} />
                      Record expense
                    </button>
                  </div>
                  {detail.expenses.length ? (
                    detail.expenses.map((expense) => (
                      <div className="revenue-ledger-row" key={expense.id}>
                        <div>
                          <strong>
                            {revenueMoney(expense.amountMinor, terms.currency)} · {expense.category}
                          </strong>
                          <p>{expense.description}</p>
                          <small>
                            {expense.reference} · {dateLabel(expense.incurredOn)}
                          </small>
                          <p>
                            <EvidenceLink id={expense.sourceId} />
                          </p>
                          {expense.reversalNote ? (
                            <small>Reversal: {expense.reversalNote}</small>
                          ) : null}
                        </div>
                        <div>
                          <Badge tone={expense.status === "Recorded" ? "neutral" : "orange"}>
                            {expense.status}
                          </Badge>
                          {expense.status === "Recorded" ? (
                            <button
                              type="button"
                              className="text-link"
                              disabled={busy}
                              onClick={() =>
                                open({ kind: "reverse-expense", targetId: expense.id })
                              }
                            >
                              Record reversal
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="revenue-hint">No paid expenses are recorded.</p>
                  )}
                </section>
              </>
            ) : null}
            {tab === "History" ? (
              <section className="revenue-card">
                <h3>Evidence & decision history</h3>
                {detail.activity.map((item) => (
                  <div className="revenue-history-row" key={item.id}>
                    <strong>{item.action.replace("revenue.", "").replace(/-/g, " ")}</strong>
                    <small>{dateTimeLabel(item.createdAt)}</small>
                    {typeof item.detail.note === "string" ? <p>{item.detail.note}</p> : null}
                  </div>
                ))}
              </section>
            ) : null}
            <div ref={editorRef}>
              {editor?.kind === "edit" ? (
                <section className="revenue-editor">
                  <h3>Edit Draft agreement terms</h3>
                  <EngagementTermsForm
                    initial={terms}
                    sources={detail.sources}
                    busy={busy}
                    onSave={(terms) => mutate({ kind: "edit", terms })}
                    onCancel={() => setEditor(null)}
                  />
                </section>
              ) : editor ? (
                <RevenueActionForm
                  key={`${editor.kind}-${editor.targetId ?? ""}`}
                  editor={editor}
                  detail={detail}
                  busy={busy}
                  onSave={mutate}
                  onCancel={() => setEditor(null)}
                />
              ) : null}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
