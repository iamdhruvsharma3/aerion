"use client";
import { dateTimeLabel } from "@/lib/format";
import { requirementTerms } from "@/lib/sourcing";

import { calendarDate } from "@/lib/format";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  ClipboardList,
  FileText,
  Flag,
  Link2,
  Mail,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateLabel, downloadText } from "@/lib/format";
import {
  dueState,
  readinessDefinitions,
  type ExecutionAction,
  type ExecutionContext,
  type OutreachDraft,
} from "@/lib/execution/schema";
import { useWorkspace } from "./workspace-provider";
import { Badge, EmptyState, Modal } from "./ui";
import { MailDeliveryPanel } from "./mail-delivery-panel";
import { ExecutionModal, type ExecutionModalState } from "./execution-modal";

const tabNames = ["Candidates", "Drafts", "Actions & questions", "Readiness"] as const;
export function ExecutionView() {
  const { data, ready } = useWorkspace();
  const search = useSearchParams(),
    router = useRouter();
  const requested = search.get("requirement");
  const selected = requested ?? data.requirements[0]?.id;
  if (!ready) return <p role="status">Opening your execution desk…</p>;
  return (
    <>
      <div className="page-heading execution-heading">
        <div>
          <div className="eyebrow muted">EXECUTION DESK</div>
          <h1>From a brief to the next move.</h1>
          <p>One place for your decisions, evidence, drafts, and follow-through.</p>
        </div>
        <span className="execution-mode">
          <span className="tiny-dot orange" />
          Founder controlled · Local templates
        </span>
      </div>
      {!data.requirements.length ? (
        <EmptyState
          title="Start with a buyer brief"
          detail="Create a requirement or promote a reviewed market signal to open an execution desk."
          action={
            <Link className="button button-primary" href="/requirements">
              Open buyer requirements
            </Link>
          }
        />
      ) : (
        <>
          <label className="execution-picker">
            <span>WORKING REQUIREMENT</span>
            <select
              aria-label="Working requirement"
              value={selected ?? ""}
              onChange={(e) =>
                router.replace(`/execution?requirement=${encodeURIComponent(e.target.value)}`)
              }
            >
              {requested && !data.requirements.some((r) => r.id === requested) ? (
                <option value={requested}>Requirement unavailable</option>
              ) : null}
              {data.requirements.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.client} · {r.aircraftModel}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <ExecutionDesk
              key={`${selected}:${search.get("tab")}`}
              id={selected}
              initialTab={
                search.get("tab") === "actions"
                  ? "Actions & questions"
                  : search.get("tab") === "drafts"
                    ? "Drafts"
                    : "Candidates"
              }
            />
          ) : null}
        </>
      )}
    </>
  );
}
function ExecutionDesk({ id, initialTab }: { id: string; initialTab: (typeof tabNames)[number] }) {
  const { refresh, dispatch, saving } = useWorkspace();
  const [desk, setDesk] = useState<ExecutionContext | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<(typeof tabNames)[number]>(initialTab),
    [filter, setFilter] = useState("All candidates"),
    [query, setQuery] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [modal, setModal] = useState<ExecutionModalState | null>(null),
    [draft, setDraft] = useState<OutreachDraft | null>(null),
    [visible, setVisible] = useState(30);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const value = await api<ExecutionContext>(`/api/execution/${encodeURIComponent(id)}`, {
        signal,
      });
      if (!signal?.aborted) setDesk(value);
      return value;
    },
    [id],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not open this requirement.");
    });
    return () => controller.abort();
  }, [load]);
  async function save(action: ExecutionAction) {
    if (!desk || busy) return false;
    setBusy(true);
    setError("");
    try {
      await api(`/api/execution/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ revision: desk.revision, action }),
      });
      await load();
      window.dispatchEvent(new Event("aerion-execution-updated"));
      if (action.type === "confirm-brief") await refresh();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save this change.";
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function run(action: ExecutionAction) {
    void save(action).catch(() => {});
  }
  async function createOpportunity(aircraftId: string) {
    if (!desk) return;
    setBusy(true);
    setError("");
    try {
      const ok = await dispatch({
        type: "deal",
        item: {
          id: crypto.randomUUID(),
          title: `${desk.requirement.client} · ${desk.requirement.aircraftModel}`,
          aircraftId,
          requirementId: id,
          stage: "Sourcing",
          nextAction: "Reconfirm availability and representation with retained evidence",
          dueDate: calendarDate(),
        },
      });
      if (!ok) throw new Error("Opportunity was not saved. Check the workspace message and retry.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the opportunity.");
    } finally {
      setBusy(false);
    }
  }
  if (!desk)
    return (
      <div className="execution-loading" role={error ? "alert" : "status"}>
        {error || "Bringing your requirement and evidence together…"}
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setError("");
            load().catch((e) => setError(e.message));
          }}
        >
          Retry
        </button>
      </div>
    );
  const today = calendarDate(),
    r = desk.requirement;
  const shortlist = desk.decisions.filter((d) => d.decision === "Shortlisted");
  const overdue = desk.actions.filter((a) => dueState(a, today) === "Overdue").length;
  const filtered = desk.matches.filter(
    (m) =>
      `${m.aircraft.manufacturer} ${m.aircraft.model} ${m.aircraft.serial}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "All candidates" ||
        (filter === "Shortlisted" && shortlist.some((d) => d.aircraftId === m.aircraft.id)) ||
        filter === m.state),
  );
  const noDraftReason = desk.requalificationRequired
    ? "This brief is historical. Use and confirm the revised buyer requirement."
    : !desk.confirmation
      ? "Record the brief confirmation first."
      : !shortlist.length
        ? "Shortlist an eligible aircraft first."
        : !desk.contacts.some((c) => ["Buyer", "Seller", "Broker"].includes(c.type))
          ? "Link a buyer, seller or broker contact first."
          : "";
  return (
    <>
      {desk.requalificationRequired ? (
        <div className="execution-error" role="status">
          This brief needs requalification after a reviewed revision or corrected reply assignment.
          Existing records remain historical.{" "}
          {desk.supersededBy ? (
            <Link
              className="text-link"
              href={`/execution?requirement=${encodeURIComponent(desk.supersededBy.requirementId)}`}
            >
              Open revised requirement
            </Link>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="execution-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => {
              load()
                .then(() => setError(""))
                .catch((e) => setError(e.message));
            }}
          >
            Reload desk
          </button>
        </div>
      ) : null}
      <div className="execution-metrics">
        {[
          { label: "Shortlisted", value: shortlist.length, icon: CheckCheck },
          { label: "Retained drafts", value: desk.drafts.length, icon: Mail },
          { label: "Overdue", value: overdue, icon: Flag },
          {
            label: "Reviewed evidence",
            value: `${desk.readiness.filter((i) => ["Reviewed", "Verified"].includes(i.status)).length} / 6`,
            icon: ClipboardList,
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className={metric.label === "Overdue" && overdue ? "needs-attention" : ""}
          >
            <metric.icon size={17} />
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="execution-context-toggle"
        aria-expanded={contextOpen}
        aria-controls="execution-brief-context"
        onClick={() => setContextOpen((v) => !v)}
      >
        {contextOpen ? "Hide brief and people" : "View brief, contacts and opportunities"}
        <ArrowUpRight size={14} />
      </button>
      <div className="execution-layout">
        <aside
          id="execution-brief-context"
          className={`execution-context ${contextOpen ? "context-open" : ""}`}
        >
          <section className="execution-panel brief-panel">
            <span className="eyebrow muted">BUYER BRIEF</span>
            <h2>{r.client}</h2>
            <p className="execution-family">
              {r.aircraftModel} <span>× {r.quantity}</span>
            </p>
            <dl className="execution-facts">
              <div>
                <dt>Market</dt>
                <dd>{r.category}</dd>
              </div>
              <div>
                <dt>Minimum year</dt>
                <dd>{r.minYear}</dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>{r.engine || "No constraint"}</dd>
              </div>
              <div>
                <dt>Budget / aircraft</dt>
                <dd>{requirementTerms(r)}</dd>
              </div>
              <div>
                <dt>Delivery by</dt>
                <dd>{dateLabel(r.deadline)}</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>{r.destination}</dd>
              </div>
            </dl>
            {desk.confirmation ? (
              <div className="execution-confirmation">
                <Badge tone="green">Founder-recorded confirmation</Badge>
                <p>
                  {desk.confirmation.contact} · {dateLabel(desk.confirmation.confirmedOn)}
                </p>
                <details>
                  <summary>View confirmation basis</summary>
                  <p>{desk.confirmation.basis}</p>
                  {desk.confirmation.origin === "signal" ? (
                    <Link className="text-link" href={desk.confirmation.href}>
                      Original signal review <ArrowUpRight size={13} />
                    </Link>
                  ) : null}
                </details>
              </div>
            ) : (
              <div className="execution-confirmation">
                <Badge tone="orange">Confirmation needs a record</Badge>
                <p>The saved status alone does not establish who confirmed the brief.</p>
                <button
                  className="text-link"
                  type="button"
                  onClick={() => setModal({ kind: "confirm" })}
                >
                  Record confirmation <Plus size={13} />
                </button>
              </div>
            )}
            {r.description ? (
              <details className="execution-description">
                <summary>Brief notes</summary>
                <p>{r.description}</p>
              </details>
            ) : null}
          </section>
          <section className="execution-panel">
            <div className="execution-section-title">
              <h3>People in this requirement</h3>
              <button
                className="icon-button"
                type="button"
                aria-label="Link a contact"
                onClick={() => setModal({ kind: "contact" })}
              >
                <Link2 size={16} />
              </button>
            </div>
            {desk.contacts.map((c) => (
              <div className="execution-person" key={c.id}>
                <span>{c.name}</span>
                <Badge>{c.type}</Badge>
                <small>
                  {c.company} · {c.email}
                </small>
              </div>
            ))}
            {!desk.contacts.length ? (
              <p className="execution-caption">
                Link a saved contact to prepare relevant outreach.
              </p>
            ) : null}
            <Link className="text-link" href="/contacts">
              Manage contacts <ArrowUpRight size={13} />
            </Link>
          </section>
          <section className="execution-panel">
            <div className="execution-section-title">
              <h3>Connected opportunities</h3>
              <Link href="/deals" aria-label="Open deal room">
                <ArrowUpRight size={16} />
              </Link>
            </div>
            {desk.deals.length ? (
              desk.deals.map((d) => (
                <Link key={d.id} href="/deals" className="execution-deal">
                  <strong>{d.title}</strong>
                  <small>
                    {d.stage} · {dateLabel(d.dueDate)}
                  </small>
                  <span>{d.nextAction}</span>
                </Link>
              ))
            ) : (
              <p className="execution-caption">
                Create an opportunity from a shortlisted candidate when you are ready.
              </p>
            )}
          </section>
        </aside>
        <div className="execution-work">
          <nav className="execution-tabs" aria-label="Execution sections">
            {tabNames.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={tab === name}
                className={tab === name ? "active" : ""}
                onClick={() => setTab(name)}
              >
                {name}
                {name === "Drafts" ? (
                  <span>{desk.drafts.filter((d) => d.status !== "Archived").length}</span>
                ) : null}
                {name === "Actions & questions" ? (
                  <span>{desk.actions.filter((a) => a.status === "Open").length}</span>
                ) : null}
              </button>
            ))}
          </nav>
          {tab === "Candidates" ? (
            <section className="execution-panel execution-main-panel">
              <div className="execution-section-title">
                <div>
                  <h2>Make the shortlist deliberate.</h2>
                  <p>Match checks describe sourcing fit. Your decision keeps its own reason.</p>
                </div>
                <Badge>
                  {desk.matches.length} {desk.matches.length === 1 ? "candidate" : "candidates"}
                </Badge>
              </div>
              <div className="execution-filters">
                <input
                  aria-label="Search execution candidates"
                  placeholder="Search model or serial…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setVisible(30);
                  }}
                />
                <select
                  aria-label="Candidate filter"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setVisible(30);
                  }}
                >
                  <option>All candidates</option>
                  <option>Shortlisted</option>
                  <option value="eligible">Eligible</option>
                  <option value="needs-review">Needs review</option>
                  <option value="excluded">Excluded</option>
                </select>
              </div>
              {filtered.slice(0, visible).map(({ aircraft: a, state, checks }) => {
                const decision = desk.decisions.find((d) => d.aircraftId === a.id),
                  deal = desk.deals.find((d) => d.aircraftId === a.id);
                return (
                  <article className="execution-candidate" key={a.id}>
                    <div className="execution-candidate-heading">
                      <div>
                        <span className="eyebrow muted">
                          {a.year} · {a.category.toUpperCase()}
                        </span>
                        <h3>
                          {a.manufacturer} {a.model}
                        </h3>
                        <p>
                          Serial {a.serial} · {a.location}
                        </p>
                      </div>
                      <Badge
                        tone={
                          state === "eligible" ? "green" : state === "excluded" ? "red" : "orange"
                        }
                      >
                        {state === "needs-review"
                          ? "Needs review"
                          : state === "eligible"
                            ? "Eligible"
                            : "Excluded"}
                      </Badge>
                    </div>
                    <div className="execution-checks">
                      {checks.map((c) => (
                        <span key={c.label} className={c.result} title={c.detail}>
                          {c.result === "pass" ? <Check size={12} /> : <span>·</span>}
                          {c.label}
                          <small>{c.detail}</small>
                        </span>
                      ))}
                    </div>
                    {decision ? (
                      <div className="execution-decision">
                        <strong>{decision.decision}</strong>
                        <p>{decision.reason}</p>
                      </div>
                    ) : null}
                    <div className="execution-candidate-footer">
                      <span>
                        {a.evidence ? (
                          <Link
                            href={`/sources?review=${a.evidence.reviewId}`}
                            className="text-link"
                          >
                            <FileText size={13} />
                            Aircraft evidence
                          </Link>
                        ) : (
                          <small>Original evidence needed for drafting</small>
                        )}
                      </span>
                      <div>
                        {decision?.decision === "Shortlisted" && state === "eligible" ? (
                          <button
                            type="button"
                            disabled={busy || saving || Boolean(deal)}
                            className="button button-secondary"
                            onClick={() => void createOpportunity(a.id)}
                          >
                            {deal ? "In deal room" : "Create opportunity"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => setModal({ kind: "decision", aircraftId: a.id })}
                        >
                          {decision ? "Update decision" : "Record decision"}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
              {!filtered.length ? (
                <p className="execution-empty">
                  No candidates in this view. Add approved aircraft in the source library or adjust
                  the filter.
                </p>
              ) : null}
              {filtered.length > visible ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setVisible((v) => v + 30)}
                >
                  Show more candidates
                </button>
              ) : null}
            </section>
          ) : tab === "Drafts" ? (
            <section className="execution-panel execution-main-panel">
              <div className="execution-section-title">
                <div>
                  <h2>Evidence before outreach.</h2>
                  <p>
                    Every retained draft has a claim register. Email submission needs explicit
                    approval and a configured sender.
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={Boolean(noDraftReason) || busy}
                  onClick={() => setModal({ kind: "draft" })}
                >
                  <Plus size={14} />
                  Prepare draft
                </button>
              </div>
              {noDraftReason ? <p className="execution-inline-note">{noDraftReason}</p> : null}
              {desk.drafts.map((d) => (
                <article className="execution-draft-row" key={d.id}>
                  <span className="execution-draft-icon">
                    <Mail size={20} />
                  </span>
                  <div>
                    <div className="execution-draft-status">
                      <Badge tone={d.status === "Reviewed" ? "green" : "neutral"}>{d.status}</Badge>
                      <small>
                        {d.audience} ·{" "}
                        {desk.availableContacts.find((c) => c.id === d.contactId)?.name ??
                          "Contact unavailable"}
                      </small>
                      {d.stale ? <Badge tone="orange">Inputs changed</Badge> : null}
                    </div>
                    <h3>{d.subject}</h3>
                    <p>
                      {d.claims.length} attributed facts ·{" "}
                      {new Date(d.createdAt).toLocaleDateString("en-GB")}
                    </p>
                    <button type="button" className="text-link" onClick={() => setDraft(d)}>
                      Open draft and evidence <ArrowUpRight size={14} />
                    </button>
                  </div>
                </article>
              ))}
              {!desk.drafts.length ? (
                <div className="execution-empty">
                  <Mail size={28} />
                  <h3>The next conversation starts here.</h3>
                  <p>Shortlist an eligible aircraft, link a contact, then prepare a local draft.</p>
                </div>
              ) : null}
            </section>
          ) : tab === "Actions & questions" ? (
            <section className="execution-panel execution-main-panel">
              <div className="execution-section-title">
                <div>
                  <h2>Give every open loop a next step.</h2>
                  <p>
                    Due dates stay visible here. Suggested actions are saved only when requested.
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setModal({ kind: "action" })}
                >
                  <Plus size={14} />
                  Add action
                </button>
              </div>
              <div className="execution-action-toolbar">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => run({ type: "suggest-actions" })}
                >
                  <RefreshCw size={14} />
                  Suggest next actions
                </button>
                <span>Based on gaps in this requirement</span>
              </div>
              {desk.actions.map((a) => {
                const due = dueState(a, today);
                return (
                  <article
                    className={`execution-action-row ${a.status === "Done" ? "is-done" : ""}`}
                    key={a.id}
                  >
                    <button
                      type="button"
                      className="execution-task-check"
                      aria-label={`${a.status === "Done" ? "Reopen" : "Complete"} ${a.title}`}
                      disabled={busy}
                      onClick={() =>
                        run({
                          type: "action-status",
                          actionId: a.id,
                          status: a.status === "Done" ? "Open" : "Done",
                        })
                      }
                    >
                      {a.status === "Done" ? <Check size={15} /> : null}
                    </button>
                    <div>
                      <span className="eyebrow muted">
                        {a.kind}
                        {a.seedKey ? " · SUGGESTED" : ""}
                      </span>
                      <h3>{a.title}</h3>
                      {a.detail ? <p>{a.detail}</p> : null}
                      <span className="execution-action-date">
                        {a.dueDate ? dateLabel(a.dueDate) : "No due date recorded"}
                      </span>
                    </div>
                    <Badge
                      tone={
                        due === "Overdue"
                          ? "red"
                          : due === "Due today"
                            ? "orange"
                            : due === "Done"
                              ? "green"
                              : "neutral"
                      }
                    >
                      {due}
                    </Badge>
                  </article>
                );
              })}
              {!desk.actions.length ? (
                <p className="execution-empty">
                  Add a follow-up or question, or ask for next actions based on this desk.
                </p>
              ) : null}
            </section>
          ) : (
            <section className="execution-panel execution-main-panel">
              <div className="execution-section-title">
                <div>
                  <h2>See what the evidence supports.</h2>
                  <p>
                    Received → Reviewed → Verification recorded. Each step retains its source and
                    basis.
                  </p>
                </div>
                <ClipboardList size={22} />
              </div>
              <div className="execution-inline-note">
                A recorded verification attributes a conclusion to the named verifier. It does not
                certify transaction readiness.
              </div>
              {readinessDefinitions.map((def) => {
                const item = desk.readiness.find((i) => i.key === def.key);
                return (
                  <article key={def.key} className="execution-readiness-row">
                    <div className="execution-readiness-top">
                      <div>
                        <span className="eyebrow muted">{def.group}</span>
                        <h3>{def.title}</h3>
                      </div>
                      <Badge
                        tone={
                          item?.status === "Verified"
                            ? "green"
                            : item?.status === "Reviewed"
                              ? "blue"
                              : item?.status === "Received"
                                ? "orange"
                                : "neutral"
                        }
                      >
                        {item?.status === "Verified"
                          ? "Verification recorded"
                          : (item?.status ?? "Missing")}
                      </Badge>
                    </div>
                    {item ? (
                      <>
                        <p>{item.note}</p>
                        <a className="text-link" href={`/api/sources/${item.sourceId}/document`}>
                          <FileText size={13} />
                          {desk.sources.find((s) => s.id === item.sourceId)?.title ??
                            "Retained source"}
                        </a>
                        {item.verifiedBy ? (
                          <small className="execution-verifier">
                            Recorded verifier: {item.verifiedBy} · {dateLabel(item.verifiedOn)}
                          </small>
                        ) : null}
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setModal({ kind: "readiness", key: def.key })}
                    >
                      {item ? "Update evidence" : "Record receipt"}
                      <ArrowUpRight size={13} />
                    </button>
                  </article>
                );
              })}
              <Link className="text-link" href="/sources">
                Upload supporting documents in the source library <ArrowUpRight size={14} />
              </Link>
            </section>
          )}
          <details className="execution-history execution-panel">
            <summary>
              Decision history <span>Latest {desk.activity.length} events · up to 50</span>
            </summary>
            {desk.activity.length ? (
              desk.activity.map((e) => (
                <div key={e.id}>
                  <span className="execution-history-dot" />
                  <div>
                    <strong>{e.action.replace("execution.", "").replaceAll("-", " ")}</strong>
                    <p>
                      {String(
                        e.detail.reason ??
                          e.detail.note ??
                          e.detail.title ??
                          e.detail.decision ??
                          e.detail.status ??
                          "Founder-recorded workflow change",
                      )}
                    </p>
                    <small>{dateTimeLabel(e.createdAt)}</small>
                  </div>
                </div>
              ))
            ) : (
              <p className="execution-caption">Decisions appear here as you work.</p>
            )}
          </details>
        </div>
      </div>
      {modal ? (
        <ExecutionModal
          key={`${modal.kind}:${"key" in modal ? modal.key : ""}`}
          modal={modal}
          desk={desk}
          onClose={() => setModal(null)}
          onSave={save}
          busy={busy}
        />
      ) : null}
      {draft ? (
        <DraftPreview
          draft={desk.drafts.find((d) => d.id === draft.id) ?? draft}
          contact={String(
            draft.claims.find((c) => c.field === "contact.email")?.value ?? "Recipient unavailable",
          )}
          onClose={() => setDraft(null)}
          onReview={(status) => {
            setDraft(null);
            setModal({ kind: "review", draftId: draft.id, status });
          }}
        />
      ) : null}
    </>
  );
}
function DraftPreview({
  draft: d,
  contact,
  onClose,
  onReview,
}: {
  draft: OutreachDraft;
  contact: string;
  onClose: () => void;
  onReview: (status: "Reviewed" | "Archived") => void;
}) {
  return (
    <Modal
      wide
      title="Review the message and its evidence"
      description="Inspect the retained message and evidence. External email requires a current draft review, configured sender and explicit approval."
      onClose={onClose}
    >
      <div className="execution-draft-preview">
        <div className="execution-draft-status">
          <Badge>{d.status}</Badge>
          {d.stale ? (
            <Badge tone="orange">Inputs changed · prepare from current context</Badge>
          ) : null}
        </div>
        <dl>
          <div>
            <dt>RECIPIENT</dt>
            <dd>{contact}</dd>
          </div>
          <div>
            <dt>SUBJECT</dt>
            <dd>{d.subject}</dd>
          </div>
        </dl>
        <pre>{d.body}</pre>
        <div className="execution-section-title">
          <h3>Claim register</h3>
          <span>{d.claims.length} retained at preparation</span>
        </div>
        {d.claims.map((c) => (
          <details className="execution-claim" key={c.field}>
            <summary>
              <strong>
                {c.label}: {c.value}
              </strong>
              <span>{c.attribution}</span>
            </summary>
            <blockquote>{c.quote}</blockquote>
            <Link className="text-link" href={c.href}>
              {c.page ? `Evidence · page ${c.page}` : "Recorded basis"}
              <ArrowUpRight size={13} />
            </Link>
            {c.sourceId ? (
              <a className="text-link" href={`/api/sources/${c.sourceId}/document`}>
                Original document <ArrowUpRight size={13} />
              </a>
            ) : null}
          </details>
        ))}
        {d.reviewNote ? <p className="execution-inline-note">Review note: {d.reviewNote}</p> : null}
        <div className="execution-preview-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              downloadText(
                `aerion-${d.id}.txt`,
                `To: ${contact}\nSubject: ${d.subject}\n\n${d.body}\n\nRETAINED CLAIM REGISTER\n${d.claims.map((c) => `${c.label}: ${c.value}\n${c.attribution} · ${c.href}${c.page ? ` · page ${c.page}` : ""}\n${c.quote}`).join("\n\n")}`,
              )
            }
          >
            Download draft + evidence
          </button>
          {d.status !== "Archived" ? (
            <>
              <button className="text-link" type="button" onClick={() => onReview("Archived")}>
                Archive
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={d.stale || d.status === "Reviewed"}
                onClick={() => onReview("Reviewed")}
              >
                Record review
              </button>
            </>
          ) : null}
        </div>
        <MailDeliveryPanel draft={d} />
      </div>
    </Modal>
  );
}
