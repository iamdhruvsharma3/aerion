"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Circle,
  FileText,
  Mail,
  Plus,
  RefreshCw,
  Search,
  UsersRound,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateTimeLabel, downloadText } from "@/lib/format";
import { requirementTerms } from "@/lib/sourcing";
import type { LeadCase, LeadCaseAction, LeadDraft } from "@/lib/leads/schema";
import type { OutreachDraft } from "@/lib/execution/schema";
import { Badge, Modal } from "./ui";
import { useWorkspace } from "./workspace-provider";
import { AgentRunDetailView } from "./agent-run-detail";
import { MailDeliveryPanel } from "./mail-delivery-panel";
import {
  Attestation,
  LeadRecordForm,
  LeadResearchForm,
  ReviewNote,
  type LeadEditor,
} from "./lead-case-forms";

type Tab = "Research" | "Buyer brief" | "Matches" | "Outreach" | "Activity";
export default function LeadWorkspace({
  id,
  providers,
  onClose,
  onChanged,
}: {
  id: string;
  providers: { id: string; ready: boolean; model: string | null }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, refresh: refreshWorkspace } = useWorkspace();
  const [detail, setDetail] = useState<LeadCase | null>(null),
    [tab, setTab] = useState<Tab>("Research"),
    [editor, setEditor] = useState<LeadEditor | null>(null),
    [research, setResearch] = useState<"contacts" | "brief" | "aircraft" | null>(null),
    [runId, setRunId] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<{ id: string; kind: "lead" | "execution" } | null>(null),
    [editingDraft, setEditingDraft] = useState<LeadDraft | null>(null);
  const busyRef = useRef(false),
    editorRef = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<LeadCase>(`/api/leads/${id}`, { signal });
      if (!signal?.aborted) setDetail(result);
      return result;
    },
    [id],
  );
  const changed = useCallback(() => {
    load().catch((e) => setError(e.message));
    onChanged();
  }, [load, onChanged]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  const active = detail?.runs.some((r) => ["queued", "running"].includes(r.status)) ?? false;
  useEffect(() => {
    if (!active || runId) return;
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      load(controller.signal)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          pending = false;
        });
    }, 2500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, runId, load]);
  useEffect(() => {
    if (editor || research || review || editingDraft)
      editorRef.current
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        )
        ?.focus();
  }, [editor, research, review, editingDraft]);
  async function mutate(action: LeadCaseAction) {
    if (!detail || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/leads/${id}`, {
        method: "POST",
        body: JSON.stringify({ revision: detail.revision, action }),
      });
      await load();
      await refreshWorkspace();
      onChanged();
      setNotice(
        action.kind === "opportunity"
          ? "Opportunity and buyer offer draft prepared. Open Outreach to review the message."
          : "Saved to this lead's working record.",
      );
      if (action.kind === "opportunity") setTab("Outreach");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action was not saved.");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function reviewMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || !detail || busy) return;
    const form = new FormData(event.currentTarget),
      note = String(form.get("note") ?? "");
    if (review.kind === "lead") {
      if (
        await mutate({
          kind: "review-draft",
          draftId: review.id,
          status: "Reviewed",
          note,
          attested: true,
        })
      )
        setReview(null);
    } else if (detail.desk) {
      setBusy(true);
      setError("");
      try {
        await api(`/api/execution/${detail.desk.requirement.id}`, {
          method: "POST",
          body: JSON.stringify({
            revision: detail.desk.revision,
            action: {
              type: "review-draft",
              draftId: review.id,
              status: "Reviewed",
              note,
              attested: true,
            },
          }),
        });
        await load();
        setReview(null);
        setNotice("Aircraft offer draft reviewed.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Review could not be saved.");
      } finally {
        setBusy(false);
      }
    }
  }
  const title =
    detail?.lead.values.organization ?? detail?.lead.values.aircraftModel ?? "Lead qualification";
  const tabs: Tab[] =
    detail?.lead.values.side === "Seller"
      ? ["Research", "Outreach", "Activity"]
      : ["Research", "Buyer brief", "Matches", "Outreach", "Activity"];
  const disabled = busy || detail?.status === "Dismissed";
  function openEditor(value: LeadEditor) {
    setEditor(value);
    setResearch(null);
    setReview(null);
    setEditingDraft(null);
    setNotice("");
  }
  function openResearch(value: "contacts" | "brief" | "aircraft") {
    setResearch(value);
    setEditor(null);
    setReview(null);
    setEditingDraft(null);
  }
  return (
    <Modal
      title={`${title} · qualification`}
      description="Work from source evidence to a business contact, a confirmed buyer brief and an aircraft opportunity."
      onClose={onClose}
      className="qualification-modal"
      wide
    >
      <div className="qualification-workspace">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="qualification-notice" role="status">
            {notice}
          </p>
        ) : null}
        {!detail ? (
          <p className="qualification-loading">Opening the saved lead…</p>
        ) : (
          <>
            <header className="qualification-header">
              <div>
                <span className="eyebrow">
                  {detail.lead.values.side.toUpperCase()} PIPELINE / WORKING LEAD
                </span>
                <h3>{detail.lead.values.aircraftModel ?? "Aircraft focus not stated"}</h3>
                <p>
                  {detail.lead.values.basis} · captured {dateTimeLabel(detail.lead.createdAt)}
                </p>
              </div>
              <Badge
                tone={
                  detail.status === "Dismissed"
                    ? "neutral"
                    : detail.desk?.confirmation
                      ? "green"
                      : "orange"
                }
              >
                {detail.status === "Dismissed"
                  ? "Dismissed"
                  : detail.desk?.confirmation
                    ? "Requirement confirmed"
                    : detail.status}
              </Badge>
              <button
                className="icon-button"
                type="button"
                onClick={changed}
                aria-label="Refresh lead workspace"
              >
                <RefreshCw size={15} />
              </button>
            </header>
            {detail.lead.values.side === "Buyer" ? (
              <ol className="qualification-journey">
                {detail.readiness.map((item, i) => (
                  <li key={item.key} className={item.ready ? "is-ready" : ""}>
                    {item.ready ? (
                      <Check size={13} />
                    ) : (
                      <span>{String(i + 1).padStart(2, "0")}</span>
                    )}
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.ready ? "Ready" : "Needs input"}</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            <div
              className="qualification-tabs"
              role="tablist"
              aria-label="Lead workflow"
              onKeyDown={(e) => {
                const index = tabs.indexOf(tab);
                const next =
                  e.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : e.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : null;
                if (next === null) return;
                e.preventDefault();
                setTab(tabs[next]);
                e.currentTarget
                  .querySelector<HTMLButtonElement>(`[data-tab-index="${next}"]`)
                  ?.focus();
              }}
            >
              {tabs.map((value, i) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`lead-tab-${i}`}
                  aria-controls={`lead-panel-${i}`}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  data-tab-index={i}
                  onClick={() => {
                    setTab(value);
                    setEditor(null);
                    setResearch(null);
                    setReview(null);
                    setEditingDraft(null);
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
            <div
              className="qualification-panel"
              role="tabpanel"
              id={`lead-panel-${tabs.indexOf(tab)}`}
              aria-labelledby={`lead-tab-${tabs.indexOf(tab)}`}
            >
              {tab === "Research" ? (
                <>
                  <div className="qualification-grid">
                    <section className="qualification-card">
                      <div className="qualification-card-heading">
                        <UsersRound size={16} />
                        <h3>Business contact</h3>
                      </div>
                      {detail.contact ? (
                        <>
                          <h4>{detail.contact.name}</h4>
                          <p>
                            {detail.contact.company} · {detail.contact.role}
                          </p>
                          <p>
                            {detail.contact.email}
                            <br />
                            {detail.contact.location}
                          </p>
                          <Badge>{detail.contact.type} · founder record</Badge>
                        </>
                      ) : (
                        <p className="qualification-empty">
                          Find a published business contact or connect a contact from your own
                          records. A public signal does not establish a relationship.
                        </p>
                      )}
                      <div className="qualification-buttons">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={disabled}
                          onClick={() => openResearch("contacts")}
                        >
                          <Search size={13} />
                          Research contacts
                        </button>
                        <button
                          type="button"
                          className="text-link"
                          disabled={disabled}
                          onClick={() => openEditor("contact")}
                        >
                          Record contact
                        </button>
                        <button
                          type="button"
                          className="text-link"
                          disabled={disabled || !data.contacts.length}
                          onClick={() => openEditor("link-contact")}
                        >
                          Connect existing
                        </button>
                      </div>
                    </section>
                    <section className="qualification-card">
                      <div className="qualification-card-heading">
                        <Circle size={16} />
                        <h3>Next action</h3>
                      </div>
                      <p>{detail.nextAction || "Decide what evidence or reply is needed next."}</p>
                      <p className="qualification-hint">
                        {detail.dueOn ? `Follow up ${detail.dueOn}` : "No follow-up date recorded"}
                      </p>
                      <button
                        type="button"
                        className="text-link"
                        disabled={busy}
                        onClick={() => openEditor("status")}
                      >
                        Update status & follow-up <ArrowRight size={13} />
                      </button>
                      <div className="qualification-source-reference">
                        <span>ORIGINAL PUBLIC REFERENCE</span>
                        <a href={detail.lead.url} target="_blank" rel="noreferrer">
                          {new URL(detail.lead.url).hostname}
                          <ArrowUpRight size={11} />
                        </a>
                        <a
                          href={`/api/sources/${detail.lead.sourceId}/document`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Retained original <ArrowUpRight size={11} />
                        </a>
                      </div>
                    </section>
                  </div>
                  {detail.enrichments.length ? (
                    <section className="qualification-card">
                      <h3>Reviewed contact research</h3>
                      <p className="qualification-hint">
                        Published details retain their own evidence. Recording or connecting a CRM
                        contact is a separate decision.
                      </p>
                      {detail.enrichments.map((item) => (
                        <article className="qualification-enrichment" key={item.id}>
                          <strong>{item.values.organization}</strong>
                          <p>
                            {[
                              item.values.contactName,
                              item.values.email,
                              item.values.phone,
                              item.values.geography,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          <p>{item.values.summary}</p>
                          <details>
                            <summary>Supporting publisher passages</summary>
                            {item.citations.map((c) => (
                              <blockquote key={`${c.sourceId}:${c.page}:${c.quote}`}>
                                {c.quote}
                              </blockquote>
                            ))}
                          </details>
                          <a
                            href={`/api/sources/${item.sourceId}/document`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-link"
                          >
                            Retained contact page <ArrowUpRight size={11} />
                          </a>
                        </article>
                      ))}
                    </section>
                  ) : null}
                  <section className="qualification-card">
                    <div className="qualification-card-heading">
                      <FileText size={16} />
                      <h3>Attached evidence</h3>
                      <button
                        type="button"
                        className="text-link"
                        disabled={disabled}
                        onClick={() => openEditor("source")}
                      >
                        <Plus size={13} />
                        Attach document
                      </button>
                    </div>
                    {detail.sources.map((s) => (
                      <div className="qualification-source-row" key={`${s.id}:${s.purpose}`}>
                        <span>
                          <strong>{s.title}</strong>
                          <small>
                            {s.retired
                              ? "Historical assignment · excluded from new analysis"
                              : s.purpose}
                          </small>
                        </span>
                        <a
                          href={`/api/sources/${s.id}/document`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-link"
                        >
                          Original <ArrowUpRight size={11} />
                        </a>
                      </div>
                    ))}
                    <div className="qualification-buttons">
                      <Link href="/sources" target="_blank" className="text-link">
                        Import a buyer reply or specification <ArrowUpRight size={12} />
                      </Link>
                      {detail.lead.values.side === "Seller" ? (
                        <button
                          type="button"
                          className="text-link"
                          disabled={disabled}
                          onClick={() => openResearch("aircraft")}
                        >
                          Extract aircraft for source review <ArrowRight size={12} />
                        </button>
                      ) : null}
                    </div>
                  </section>
                </>
              ) : tab === "Buyer brief" ? (
                <>
                  <section className="qualification-card">
                    <div className="qualification-card-heading">
                      <FileText size={16} />
                      <h3>Capture the actual requirement</h3>
                    </div>
                    <p>
                      Attach the buyer's response, analyze its stated constraints and resolve
                      missing questions. A public fleet announcement alone does not confirm a
                      current requirement.
                    </p>
                    <div className="qualification-buttons">
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={disabled}
                        onClick={() => openEditor("source")}
                      >
                        Attach buyer reply
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={disabled || Boolean(detail.requirement)}
                        onClick={() => openResearch("brief")}
                      >
                        Analyze brief
                      </button>
                      {!detail.requirement ? (
                        <>
                          <button
                            type="button"
                            className="text-link"
                            disabled={disabled}
                            onClick={() => openEditor("requirement")}
                          >
                            Record draft brief
                          </button>
                          <button
                            type="button"
                            className="text-link"
                            disabled={disabled || !data.requirements.length}
                            onClick={() => openEditor("link-requirement")}
                          >
                            Connect existing brief
                          </button>
                        </>
                      ) : null}
                    </div>
                  </section>
                  {detail.requirement ? (
                    <section className="qualification-card">
                      <div className="qualification-card-heading">
                        <h3>{detail.requirement.client}</h3>
                        <Badge tone={detail.desk?.confirmation ? "green" : "orange"}>
                          {detail.desk?.confirmation ? "Confirmed brief" : "Draft brief"}
                        </Badge>
                      </div>
                      <dl className="qualification-facts">
                        {Object.entries({
                          Aircraft: detail.requirement.aircraftModel,
                          Market: detail.requirement.category,
                          Quantity: detail.requirement.quantity,
                          "Minimum year": detail.requirement.minYear,
                          Engine: detail.requirement.engine || "Not specified",
                          Terms: requirementTerms(detail.requirement),
                          Deadline: detail.requirement.deadline ?? "Not supplied",
                          Destination: detail.requirement.destination,
                        }).map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                      {detail.desk?.confirmation ? (
                        <p className="qualification-hint">
                          Confirmed by {detail.desk.confirmation.contact} on{" "}
                          {detail.desk.confirmation.confirmedOn}. {detail.desk.confirmation.basis}
                        </p>
                      ) : (
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={disabled}
                          onClick={() => openEditor("confirm")}
                        >
                          Record current buyer confirmation
                        </button>
                      )}
                    </section>
                  ) : (
                    <div className="qualification-inline-empty">
                      Unknown quantities, build years, budgets and destinations remain unanswered
                      until the buyer supplies them.
                    </div>
                  )}
                </>
              ) : tab === "Matches" ? (
                <>
                  <section className="qualification-card">
                    <div className="qualification-card-heading">
                      <h3>Aircraft fit and opportunity handoff</h3>
                      {detail.requirement ? (
                        <Link
                          href={`/execution?requirement=${encodeURIComponent(detail.requirement.id)}`}
                          className="text-link"
                        >
                          Full execution desk <ArrowUpRight size={12} />
                        </Link>
                      ) : null}
                    </div>
                    <p>
                      {!detail.requirement
                        ? "Save a draft buyer brief to evaluate approved inventory."
                        : !detail.desk?.confirmation
                          ? "Matches are preliminary until you record current buyer confirmation."
                          : !detail.contact
                            ? "Connect a buyer or broker contact to prepare an offer."
                            : "Choose an eligible aircraft to prepare the shortlist, opportunity and buyer offer draft."}
                    </p>
                  </section>
                  {detail.desk?.matches.length ? (
                    detail.desk.matches.map((match) => (
                      <article
                        className="qualification-card qualification-match"
                        key={match.aircraft.id}
                      >
                        <div className="qualification-card-heading">
                          <div>
                            <h3>
                              {match.aircraft.manufacturer} {match.aircraft.model}
                            </h3>
                            <p>
                              {match.aircraft.year} · {match.aircraft.serial}
                            </p>
                          </div>
                          <Badge
                            tone={
                              match.state === "eligible"
                                ? "green"
                                : match.state === "excluded"
                                  ? "red"
                                  : "orange"
                            }
                          >
                            {match.state === "eligible"
                              ? "Eligible"
                              : match.state === "excluded"
                                ? "Excluded"
                                : "Needs evidence"}
                          </Badge>
                        </div>
                        <dl className="qualification-match-checks">
                          {match.checks.map((c) => (
                            <div key={c.label}>
                              <dt>
                                {c.result === "pass" ? <Check size={11} /> : <Circle size={11} />}{" "}
                                {c.label}
                              </dt>
                              <dd>{c.detail}</dd>
                            </div>
                          ))}
                        </dl>
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={
                            disabled ||
                            match.state !== "eligible" ||
                            !detail.desk?.confirmation ||
                            !detail.contact
                          }
                          onClick={() => openEditor({ aircraftId: match.aircraft.id })}
                        >
                          Create opportunity & offer draft <ArrowRight size={13} />
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="qualification-inline-empty">
                      No inventory candidates yet. Discover seller listings and review their
                      aircraft evidence in the Source library.
                    </div>
                  )}
                </>
              ) : tab === "Outreach" ? (
                <>
                  <section className="qualification-card">
                    <div className="qualification-card-heading">
                      <Mail size={16} />
                      <h3>Qualification enquiry</h3>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={disabled || !detail.contact}
                        onClick={() => mutate({ kind: "prepare-draft" })}
                      >
                        Prepare enquiry draft
                      </button>
                    </div>
                    <p>
                      Ask for current requirements or availability using the connected business
                      contact. Drafts stay private until an explicit delivery approval.
                    </p>
                  </section>
                  {detail.drafts.map((draft) => (
                    <DraftCard
                      key={draft.id}
                      draft={draft}
                      kind="lead"
                      onReview={() => {
                        setReview({ id: draft.id, kind: "lead" });
                        setEditingDraft(null);
                        setEditor(null);
                      }}
                      onEdit={() => {
                        setEditingDraft(draft);
                        setReview(null);
                        setEditor(null);
                      }}
                    />
                  ))}
                  {detail.desk?.drafts.length ? (
                    <section className="qualification-offers">
                      <h3>Aircraft offer drafts</h3>
                      <p className="qualification-hint">
                        Prepared from the confirmed brief, eligible shortlist and approved aircraft
                        evidence.
                      </p>
                      {detail.desk.drafts.map((draft) => (
                        <DraftCard
                          key={draft.id}
                          draft={draft}
                          kind="execution"
                          recipient={
                            detail.desk?.contacts.find((contact) => contact.id === draft.contactId)
                              ?.email
                          }
                          onReview={() => {
                            setReview({ id: draft.id, kind: "execution" });
                            setEditingDraft(null);
                            setEditor(null);
                          }}
                        />
                      ))}
                    </section>
                  ) : null}
                  {detail.desk?.deals.length ? (
                    <div className="qualification-buttons">
                      <Link href="/deals" className="text-link">
                        Open opportunity in Deal room <ArrowUpRight size={12} />
                      </Link>
                      <Link
                        href={`/execution?requirement=${detail.requirement?.id}&tab=drafts`}
                        className="text-link"
                      >
                        Offer evidence and review history <ArrowUpRight size={12} />
                      </Link>
                    </div>
                  ) : null}
                </>
              ) : (
                <section className="qualification-card">
                  <h3>Work and decisions</h3>
                  {[...detail.activity, ...(detail.desk?.activity ?? [])]
                    .sort(
                      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                    )
                    .slice(0, 60)
                    .map((item) => (
                      <div className="qualification-activity" key={item.id}>
                        <strong>
                          {item.action.replace(/^(lead|execution)\./, "").replace(/-/g, " ")}
                        </strong>
                        <small>{dateTimeLabel(item.createdAt)}</small>
                        {typeof item.detail.note === "string" ? <p>{item.detail.note}</p> : null}
                      </div>
                    ))}
                  {!detail.activity.length ? (
                    <p className="qualification-hint">
                      Contact records, reviewed briefs and decisions will appear here.
                    </p>
                  ) : null}
                </section>
              )}
              <div ref={editorRef}>
                {editor ? (
                  <LeadRecordForm
                    key={typeof editor === "string" ? editor : editor.aircraftId}
                    editor={editor}
                    detail={detail}
                    contacts={data.contacts}
                    requirements={data.requirements}
                    busy={busy}
                    onSave={mutate}
                    onCancel={() => setEditor(null)}
                  />
                ) : null}
                {research ? (
                  <LeadResearchForm
                    key={research}
                    kind={research}
                    detail={detail}
                    providers={providers}
                    busy={busy}
                    onCancel={() => setResearch(null)}
                    onRun={(id) => {
                      changed();
                      if (id) setRunId(id);
                      else
                        setNotice(
                          "Aircraft extraction queued. Review the source before publishing inventory.",
                        );
                    }}
                  />
                ) : null}
                {review ? (
                  <section className="qualification-editor">
                    <h3>Review this exact message and recipient</h3>
                    <form onSubmit={reviewMessage}>
                      <fieldset disabled={busy}>
                        <ReviewNote />
                        <Attestation>
                          I reviewed the recipient, evidence and message content.
                        </Attestation>
                        <div className="qualification-form-actions">
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => setReview(null)}
                          >
                            Cancel
                          </button>
                          <button type="submit" className="button button-primary">
                            Record draft review
                          </button>
                        </div>
                      </fieldset>
                    </form>
                  </section>
                ) : null}
                {editingDraft ? (
                  <section className="qualification-editor">
                    <h3>Prepare an edited version</h3>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        if (
                          await mutate({
                            kind: "prepare-draft",
                            subject: String(f.get("subject") ?? ""),
                            body: String(f.get("body") ?? ""),
                          })
                        )
                          setEditingDraft(null);
                      }}
                    >
                      <fieldset disabled={busy}>
                        <label>
                          Subject
                          <input
                            name="subject"
                            required
                            maxLength={300}
                            defaultValue={editingDraft.subject}
                          />
                        </label>
                        <label>
                          Message
                          <textarea
                            name="body"
                            required
                            minLength={20}
                            maxLength={12000}
                            rows={12}
                            defaultValue={editingDraft.body}
                          />
                        </label>
                        <div className="qualification-form-actions">
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => setEditingDraft(null)}
                          >
                            Cancel
                          </button>
                          <button type="submit" className="button button-primary">
                            Save new draft version
                          </button>
                        </div>
                      </fieldset>
                    </form>
                  </section>
                ) : null}
              </div>
              {tab !== "Activity" && detail.runs.length ? (
                <section className="qualification-card qualification-runs">
                  <h3>Agent work for this lead</h3>
                  {detail.runs.map((run) => (
                    <button type="button" key={run.id} onClick={() => setRunId(run.id)}>
                      <span>
                        {run.agentId === "crm" ? "Contact research" : "Buyer brief analysis"}
                        <small>{dateTimeLabel(run.createdAt)}</small>
                      </span>
                      <Badge
                        tone={
                          run.status === "review"
                            ? "orange"
                            : run.status === "failed"
                              ? "red"
                              : "neutral"
                        }
                      >
                        {run.status}
                      </Badge>
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </section>
              ) : null}
            </div>
          </>
        )}
      </div>
      {runId ? (
        <AgentRunDetailView
          id={runId}
          onClose={() => {
            setRunId(null);
            changed();
          }}
          onChanged={changed}
        />
      ) : null}
    </Modal>
  );
}
function DraftCard({
  draft,
  kind,
  onReview,
  onEdit,
  recipient,
}: {
  draft: LeadDraft | OutreachDraft;
  kind: "lead" | "execution";
  onReview: () => void;
  onEdit?: () => void;
  recipient?: string;
}) {
  const to = "recipient" in draft ? draft.recipient : recipient;
  return (
    <article className="qualification-card qualification-draft">
      <div className="qualification-card-heading">
        <h3>{draft.subject}</h3>
        <Badge tone={draft.stale ? "red" : draft.status === "Reviewed" ? "green" : "neutral"}>
          {draft.stale ? "Context changed" : draft.status}
        </Badge>
      </div>
      <p className="qualification-hint">
        {kind === "lead" ? "To" : "Connected recipient"}: {to ?? "Contact unavailable"}
      </p>
      <pre>{draft.body}</pre>
      {"claims" in draft ? (
        <details>
          <summary>Evidence used in this offer</summary>
          {draft.claims.map((claim) => (
            <div className="qualification-offer-claim" key={claim.field}>
              <strong>
                {claim.label}: {claim.value}
              </strong>
              <small>{claim.attribution}</small>
              <p>{claim.quote}</p>
              <Link href={claim.href} target="_blank">
                Open evidence <ArrowUpRight size={11} />
              </Link>
            </div>
          ))}
        </details>
      ) : null}
      <div className="qualification-buttons">
        <button
          type="button"
          className="text-link"
          onClick={() =>
            downloadText(
              `aerion-draft-${draft.id}.txt`,
              `Draft status: ${draft.stale ? "Context changed — review a current version before use" : draft.status}\nTo: ${to ?? "Contact unavailable"}\nSubject: ${draft.subject}\n\n${draft.body}`,
            )
          }
        >
          Download draft
        </button>
        {onEdit ? (
          <button type="button" className="text-link" onClick={onEdit}>
            Edit as a new version
          </button>
        ) : null}
        {draft.status !== "Archived" ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={draft.stale}
            onClick={onReview}
          >
            Review draft & recipient
          </button>
        ) : null}
      </div>
      {draft.reviewNote ? <p className="qualification-hint">Review: {draft.reviewNote}</p> : null}
      <MailDeliveryPanel draft={draft} kind={kind} />
    </article>
  );
}
