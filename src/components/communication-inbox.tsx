"use client";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Check,
  FileText,
  Inbox,
  Link2,
  Mail,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/format";
import type { AgentProvider } from "@/lib/agents/schema";
import {
  communicationStates,
  type CommunicationDetail,
  type CommunicationInboxData,
} from "@/lib/communication/schema";
import { Badge, Field } from "./ui";
import { AgentRunDetailView } from "./agent-run-detail";
import { useWorkspace } from "./workspace-provider";

export function CommunicationInbox() {
  return (
    <Suspense fallback={<p className="communication-loading">Opening communications…</p>}>
      <CommunicationWorkspace />
    </Suspense>
  );
}
function CommunicationWorkspace() {
  const requested = useSearchParams().get("message");
  const [inbox, setInbox] = useState<CommunicationInboxData | null>(null),
    [selected, setSelected] = useState<string | null>(requested),
    [filter, setFilter] = useState("Needs review"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [uploading, setUploading] = useState(false),
    [notice, setNotice] = useState("");
  const form = useRef<HTMLFormElement>(null),
    { refresh: refreshWorkspace } = useWorkspace();
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await api<CommunicationInboxData>("/api/communication", { signal });
    if (!signal?.aborted) setInbox(value);
    return value;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (requested) setSelected(requested);
  }, [requested]);
  const reload = useCallback(() => {
    load().catch((e) => setError(e.message));
    refreshWorkspace();
  }, [load, refreshWorkspace]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const value = await api<{ id: string; reused: boolean; issues: string[] }>(
        "/api/communication",
        { method: "POST", body: new FormData(event.currentTarget) },
      );
      await load();
      setSelected(value.id);
      setNotice(
        `${value.reused ? "Existing original reopened" : "Original email retained"}. ${value.issues.join(" ")}`,
      );
      form.current?.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The original email could not be retained.");
    } finally {
      setUploading(false);
    }
  }
  const visible =
    inbox?.messages.filter(
      (message) =>
        (filter === "All" || filter === "Needs review"
          ? filter === "All" || ["Unassigned", "Suggested", "Ambiguous"].includes(message.state)
          : message.state === filter) &&
        `${message.subject} ${message.sender} ${message.recipients.join(" ")}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ) ?? [];
  const awaiting = inbox
    ? inbox.counts.Unassigned + inbox.counts.Suggested + inbox.counts.Ambiguous
    : 0;
  return (
    <div className="communication-workspace">
      <header className="communication-hero">
        <div>
          <span className="eyebrow">AERION / CONVERSATIONS TO REQUIREMENTS</span>
          <h1>Keep the conversation connected.</h1>
          <p>Retain the reply. Review the relationship. Build the next brief.</p>
        </div>
        <div className="communication-hero-count">
          <strong>{awaiting}</strong>
          <span>replies to review</span>
          <small>{inbox?.counts.Linked ?? 0} linked to working leads</small>
        </div>
      </header>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="communication-notice">
          {notice}
        </p>
      ) : null}
      <section className="communication-import">
        <div>
          <Mail size={18} />
          <div>
            <h2>Bring in an original reply</h2>
            <p>
              {inbox?.mailbox.ready
                ? `Mailbox intake is configured for ${inbox.mailbox.account}. Communication agent runs can collect the selected folder.`
                : "Import .eml messages now. A connected mailbox can feed this same review flow later."}
            </p>
          </div>
        </div>
        <form ref={form} onSubmit={upload}>
          <label className="communication-file">
            Original .eml file
            <input
              type="file"
              name="file"
              accept=".eml,message/rfc822"
              required
              disabled={uploading}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={uploading}>
            <Upload size={14} />
            {uploading ? "Retaining…" : "Import reply"}
          </button>
        </form>
        <small>2 MB per original · up to four supported attachments · no message is sent</small>
      </section>
      <div className="communication-layout">
        <section className="communication-inbox-list" aria-label="Retained communication inbox">
          <div className="communication-list-top">
            <h2>
              <Inbox size={16} /> Reply inbox
            </h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh communication inbox"
              onClick={reload}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <Field label="Filter replies">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option>Needs review</option>
              <option>All</option>
              {communicationStates.map((state) => (
                <option key={state}>{state}</option>
              ))}
            </select>
          </Field>
          <Field label="Search replies">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Subject or business address"
            />
          </Field>
          {!inbox ? (
            <p role="status">Loading retained messages…</p>
          ) : visible.length ? (
            visible.map((message) => (
              <button
                type="button"
                key={message.id}
                className={`communication-message-row ${selected === message.id ? "is-selected" : ""}`}
                onClick={() => {
                  setSelected(message.id);
                  setNotice("");
                }}
                aria-pressed={selected === message.id}
              >
                <span className="communication-message-sender">
                  {message.sender || "Sender not supplied"}
                </span>
                <strong>{message.subject}</strong>
                <span>
                  <Badge
                    tone={
                      message.state === "Linked"
                        ? "green"
                        : message.state === "Ambiguous"
                          ? "orange"
                          : "neutral"
                    }
                  >
                    {message.state}
                  </Badge>
                  <small>{dateTimeLabel(message.createdAt)}</small>
                </span>
                {message.classification !== "Message" ? <em>{message.classification}</em> : null}
              </button>
            ))
          ) : (
            <div className="communication-empty">
              <Mail size={24} />
              <h3>No replies in this view</h3>
              <p>
                Import a retained email or select another filter. Unmatched messages remain
                available for manual review.
              </p>
            </div>
          )}
          <p className="communication-small">
            Showing the latest 200 retained messages. Original bytes remain in the Source library.
          </p>
        </section>
        {selected && inbox ? (
          <CommunicationMessagePanel
            key={selected}
            id={selected}
            inbox={inbox}
            onChanged={reload}
          />
        ) : (
          <section className="communication-detail communication-choose">
            <Link2 size={32} />
            <h2>A reply becomes useful when it has context.</h2>
            <p>
              Select a message to inspect the original, review its suggested lead and extract the
              next requirement.
            </p>
            <div>
              <span>01 · Retain</span>
              <ArrowRight size={13} />
              <span>02 · Link</span>
              <ArrowRight size={13} />
              <span>03 · Analyze</span>
            </div>
          </section>
        )}
      </div>
      {inbox ? <CommunicationRestrictions inbox={inbox} onChanged={reload} /> : null}
    </div>
  );
}
type Editor =
  | "link"
  | "correct-link"
  | "dismiss"
  | "reopen"
  | "analyze"
  | "clarify"
  | "suppress"
  | { runId: string; proposalId: string };
function CommunicationMessagePanel({
  id,
  inbox,
  onChanged,
}: {
  id: string;
  inbox: CommunicationInboxData;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CommunicationDetail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editor, setEditor] = useState<Editor | null>(null),
    [runId, setRunId] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<AgentProvider>(
    inbox.providers.find((p) => p.id === "nvidia" && p.ready)?.id ?? "rules",
  );
  const idempotency = useRef(crypto.randomUUID()),
    editorRef = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const value = await api<CommunicationDetail>(`/api/communication/${id}`, { signal });
      if (!signal?.aborted) setDetail(value);
      return value;
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
  const active = detail?.analysisRuns.some((run) => ["queued", "running"].includes(run.status));
  useEffect(() => {
    if (!active || runId) return;
    const controller = new AbortController(),
      timer = setInterval(() => {
        if (document.visibilityState === "visible")
          load(controller.signal).catch((e) => {
            if (!controller.signal.aborted) setError(e.message);
          });
      }, 2500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, runId, load]);
  useEffect(() => {
    if (editor) {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      editorRef.current?.querySelector<HTMLElement>("select,textarea,input")?.focus();
    }
  }, [editor]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !editor || busy) return;
    const form = new FormData(event.currentTarget),
      note = String(form.get("note") ?? "").trim();
    let body: Record<string, unknown>;
    if (typeof editor === "object")
      body = {
        kind: "use-revision",
        runId: editor.runId,
        proposalId: editor.proposalId,
        leadRevision: detail.leadRevision,
        note,
        attested: true,
      };
    else if (editor === "link" || editor === "correct-link")
      body = { kind: editor, leadId: String(form.get("leadId")), note, attested: true };
    else if (editor === "analyze")
      body = {
        kind: editor,
        provider,
        allowModelData: form.get("modelConsent") === "on",
        idempotencyKey: idempotency.current,
      };
    else if (editor === "suppress")
      body = {
        kind: editor,
        email: String(form.get("email")),
        reason: String(form.get("reason")),
        note,
        attested: true,
      };
    else body = { kind: editor, note, attested: true };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ runId?: string; draftId?: string; requirementId?: string }>(
        `/api/communication/${id}`,
        { method: "POST", body: JSON.stringify({ ...body, revision: detail.revision }) },
      );
      await load();
      onChanged();
      setEditor(null);
      idempotency.current = crypto.randomUUID();
      if (result.runId) setRunId(result.runId);
      setNotice(
        result.draftId
          ? "Clarification draft prepared. Review its recipient and exact text in the lead workspace before delivery."
          : result.requirementId
            ? "Revised Draft brief connected. Record a fresh confirmation and review prior opportunities against the new requirement."
            : result.runId
              ? "Reply analysis queued with this retained source selection."
              : "Decision saved with the original message and review note.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision could not be saved.");
      if (e instanceof Error && e.message.includes("changed")) await load();
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <section className="communication-detail">
        <p role="status">Opening the retained message…</p>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </section>
    );
  const linked = detail.state === "Linked",
    isMessage = detail.classification === "Message";
  const suggested =
    detail.suggestedLeadIds[0] && inbox.leads.some((lead) => lead.id === detail.suggestedLeadIds[0])
      ? detail.suggestedLeadIds[0]
      : "";
  return (
    <section className="communication-detail" aria-label="Selected retained message">
      <header>
        <div>
          <span className="communication-kicker">RETAINED CORRESPONDENCE</span>
          <h2>{detail.subject}</h2>
        </div>
        <Badge tone={linked ? "green" : detail.state === "Ambiguous" ? "orange" : "neutral"}>
          {detail.state}
        </Badge>
      </header>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="communication-notice">
          {notice}
        </p>
      ) : null}
      <dl className="communication-envelope">
        <div>
          <dt>From · source header</dt>
          <dd>{detail.sender || "Not supplied"}</dd>
        </div>
        <div>
          <dt>To · source header</dt>
          <dd>{detail.recipients.join(", ") || "Not supplied"}</dd>
        </div>
        <div>
          <dt>Retained</dt>
          <dd>{dateTimeLabel(detail.createdAt)}</dd>
        </div>
        <div>
          <dt>Message type</dt>
          <dd>
            {detail.classification} · {detail.direction}
          </dd>
        </div>
      </dl>
      <div className="communication-routing">
        <Link2 size={16} />
        <div>
          <strong>
            {linked
              ? `${detail.lead?.organization ?? "Saved lead"} · ${detail.lead?.aircraftModel ?? "Aircraft focus not stated"}`
              : detail.state === "Suggested"
                ? "A matching thread suggests a lead"
                : detail.state === "Ambiguous"
                  ? "Several leads match this thread"
                  : "Review the lead association"}
          </strong>
          <p>{detail.routingBasis}</p>
          {linked ? (
            <Link href={`/discovery?lead=${detail.leadId}`} className="text-link">
              Open lead qualification <ArrowUpRight size={12} />
            </Link>
          ) : null}
        </div>
      </div>
      <div className="communication-actions">
        {!linked && detail.state !== "Dismissed" ? (
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !inbox.leads.length}
            onClick={() => setEditor("link")}
          >
            <Link2 size={13} />
            Review & link lead
          </button>
        ) : null}
        {linked && isMessage ? (
          <>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || active}
              onClick={() => setEditor("analyze")}
            >
              {detail.currentRequirementId ? "Analyze possible revision" : "Analyze reply"}
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setEditor("clarify")}
            >
              Prepare clarification
            </button>
          </>
        ) : null}
        {linked ? (
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => setEditor("correct-link")}
          >
            Correct lead assignment
          </button>
        ) : null}
        {!linked ? (
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => setEditor(detail.state === "Dismissed" ? "reopen" : "dismiss")}
          >
            {detail.state === "Dismissed" ? "Reopen" : "Dismiss"}
          </button>
        ) : null}
        <button
          type="button"
          className="text-link"
          disabled={busy || (!detail.sender && !detail.recipients.length)}
          onClick={() => setEditor("suppress")}
        >
          <Ban size={12} />
          Contact restriction
        </button>
        <Link
          className="text-link"
          target="_blank"
          href={`/api/sources/${detail.sourceId}/document`}
        >
          Download original <ArrowUpRight size={12} />
        </Link>
      </div>
      {!isMessage ? (
        <p className="communication-warning">
          Automated responses and delivery reports remain evidence for review. They do not enter
          buyer-brief extraction.
        </p>
      ) : null}
      <div ref={editorRef}>
        {editor ? (
          <section className="communication-editor">
            <div>
              <h3>
                {typeof editor === "object"
                  ? "Use this accepted Draft as the revised buyer brief"
                  : (
                      {
                        link: "Review the reply and its lead",
                        "correct-link": "Correct the reply's current lead assignment",
                        dismiss: "Dismiss from the working inbox",
                        reopen: "Reopen this message",
                        analyze: "Analyze retained reply evidence",
                        clarify: "Prepare a qualification clarification",
                        suppress: "Record a contact restriction",
                      } as const
                    )[editor]}
              </h3>
              <button
                type="button"
                aria-label="Close reply action"
                className="icon-button"
                onClick={() => setEditor(null)}
                disabled={busy}
              >
                <X size={15} />
              </button>
            </div>
            <form onSubmit={submit}>
              <fieldset disabled={busy}>
                {editor === "link" || editor === "correct-link" ? (
                  <>
                    <Field label="Working lead">
                      <select
                        name="leadId"
                        required
                        defaultValue={editor === "correct-link" ? "" : suggested}
                      >
                        <option value="" disabled>
                          Select a saved lead
                        </option>
                        {inbox.leads
                          .filter((lead) => editor !== "correct-link" || lead.id !== detail.leadId)
                          .map((lead) => (
                            <option key={lead.id} value={lead.id}>
                              {lead.side} · {lead.organization ?? "Organization unstated"} ·{" "}
                              {lead.aircraftModel ?? "Aircraft unstated"}
                              {detail.suggestedLeadIds.includes(lead.id) ? " · thread match" : ""}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <p>
                      The original message and its supported retained attachments become evidence on
                      this lead. Check the sender, content and actual business relationship before
                      linking. Matching headers do not authenticate a sender.
                    </p>
                    {editor === "correct-link" ? (
                      <p className="communication-warning">
                        The prior source links, accepted briefs, confirmations and opportunities
                        remain in history. Pending analysis for the old assignment is cancelled. Old
                        briefs that relied on the assignment need fresh review; this action does not
                        move or confirm a buyer requirement.
                      </p>
                    ) : null}
                  </>
                ) : null}
                {editor === "analyze" ? (
                  <>
                    <Field label="Reply analysis provider">
                      <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value as AgentProvider)}
                      >
                        {inbox.providers.map((item) => (
                          <option key={item.id} value={item.id} disabled={!item.ready}>
                            {item.id === "rules" ? "Local deterministic rules" : item.id}
                            {!item.ready ? " · not configured" : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <p>
                      {detail.currentRequirementId
                        ? "The current brief stays unchanged. A complete, supported buyer reply can produce a separate Draft; you decide whether to use it as a revision after reviewing its proposal."
                        : "Only this retained message and its supported attachments are selected for this run. Missing constraints become clarification questions."}
                    </p>
                    {provider !== "rules" ? (
                      <label className="communication-consent">
                        <input type="checkbox" name="modelConsent" required />
                        Allow this retained reply, its selected attachments and lead context to be
                        sent to {provider}.
                      </label>
                    ) : (
                      <p>
                        Local rules recognize explicit brief labels. Unlabelled prose may need a
                        connected model or clarification from the buyer.
                      </p>
                    )}
                  </>
                ) : null}
                {editor === "suppress" ? (
                  <>
                    <Field label="Business address to restrict">
                      <select name="email" required defaultValue={detail.sender}>
                        {[...new Set([detail.sender, ...detail.recipients].filter(Boolean))].map(
                          (email) => (
                            <option key={email}>{email}</option>
                          ),
                        )}
                      </select>
                    </Field>
                    <Field label="Restriction reason">
                      <select name="reason">
                        <option>Do not contact</option>
                        <option>Delivery failure</option>
                        <option>Founder decision</option>
                      </select>
                    </Field>
                    <p>
                      A reviewed restriction blocks delivery to this address until you explicitly
                      lift it. Header classification alone never adds a restriction.
                    </p>
                  </>
                ) : null}
                {editor === "clarify" ? (
                  <p>
                    This prepares a private, editable draft asking for a complete current brief.
                    Review its exact text and recipient in the lead workspace before approving any
                    delivery.
                  </p>
                ) : null}
                {typeof editor === "object" ? (
                  <p>
                    The existing brief, confirmation and opportunities remain in history. The
                    accepted replacement starts as Draft and needs a new confirmation. Old-brief
                    email delivery is blocked after replacement.
                  </p>
                ) : null}
                {editor !== "analyze" ? (
                  <>
                    <Field label="Reply decision note">
                      <textarea
                        name="note"
                        required
                        minLength={20}
                        maxLength={2000}
                        rows={3}
                        placeholder="Record the source and basis for this decision."
                      />
                    </Field>
                    {!["dismiss", "reopen"].includes(typeof editor === "string" ? editor : "") ? (
                      <label className="communication-consent">
                        <input type="checkbox" required />I reviewed the retained message, selected
                        record and supporting evidence.
                      </label>
                    ) : null}
                  </>
                ) : null}
                <div className="communication-editor-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => setEditor(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button button-primary">
                    {busy
                      ? "Saving…"
                      : editor === "analyze"
                        ? "Start reply analysis"
                        : "Save decision"}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        ) : null}
      </div>
      <details className="communication-source" open>
        <summary>
          <FileText size={14} />
          Retained message text
        </summary>
        <pre>{detail.text}</pre>
      </details>
      {detail.attachments.length ? (
        <section className="communication-attachments">
          <h3>Retained attachments</h3>
          {detail.attachments.map((attachment) => (
            <div key={attachment.id}>
              <span>
                <strong>{attachment.filename}</strong>
                <small>{attachment.contentType}</small>
              </span>
              <Link target="_blank" href={`/api/sources/${attachment.id}/document`}>
                Original <ArrowUpRight size={11} />
              </Link>
            </div>
          ))}
        </section>
      ) : null}
      {detail.analysisRuns.length ? (
        <section className="communication-analysis">
          <h3>Analysis & decisions</h3>
          {detail.analysisRuns.map((run) => (
            <article key={run.id}>
              <button type="button" onClick={() => setRunId(run.id)}>
                <span>
                  <strong>
                    {run.kind}
                    {run.leadId !== detail.leadId ? " · prior assignment" : ""}
                  </strong>
                  <small>{dateTimeLabel(run.createdAt)}</small>
                </span>
                <Badge tone={run.status === "review" ? "orange" : "neutral"}>{run.status}</Badge>
                <ArrowUpRight size={13} />
              </button>
              {run.kind === "Revised brief" && run.leadId === detail.leadId
                ? run.proposals
                    .filter(
                      (proposal) =>
                        proposal.type === "requirement" &&
                        proposal.status === "accepted" &&
                        proposal.appliedRef &&
                        proposal.appliedRef !== detail.currentRequirementId,
                    )
                    .map((proposal) => (
                      <div className="communication-revision" key={proposal.id}>
                        <p>{proposal.title}</p>
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy || run.priorRequirementId !== detail.currentRequirementId}
                          onClick={() => setEditor({ runId: run.id, proposalId: proposal.id })}
                        >
                          Use as revised buyer brief
                        </button>
                      </div>
                    ))
                : null}
            </article>
          ))}
        </section>
      ) : null}
      {detail.revisions.length ? (
        <section className="communication-history">
          <h3>Brief revision history</h3>
          {detail.revisions.map((revision) => (
            <div key={revision.id}>
              <Check size={14} />
              <div>
                <strong>Revised brief connected · {dateTimeLabel(revision.createdAt)}</strong>
                <p>{revision.reviewNote}</p>
                <Link href={`/execution?requirement=${encodeURIComponent(revision.requirementId)}`}>
                  Open revised brief <ArrowUpRight size={11} />
                </Link>
                <Link
                  href={`/execution?requirement=${encodeURIComponent(revision.priorRequirementId)}`}
                >
                  Prior brief and opportunities <ArrowUpRight size={11} />
                </Link>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {detail.assignmentCorrections.length ? (
        <section className="communication-history">
          <h3>Assignment correction history</h3>
          {detail.assignmentCorrections.map((correction) => (
            <div key={correction.id}>
              <Link2 size={14} />
              <div>
                <strong>
                  Corrected from {correction.priorOrganization ?? correction.priorLeadId} to{" "}
                  {correction.organization ?? correction.leadId}
                </strong>
                <p>
                  {dateTimeLabel(correction.createdAt)} · {correction.reviewNote}
                </p>
                <Link href={`/discovery?lead=${correction.priorLeadId}`}>
                  Prior lead history <ArrowUpRight size={11} />
                </Link>
                <Link href={`/discovery?lead=${correction.leadId}`}>
                  Reviewed assignment <ArrowUpRight size={11} />
                </Link>
                {correction.priorRequirementId ? (
                  <p>
                    Previously adopted briefs and opportunities remain unchanged and require fresh
                    supporting evidence.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {detail.reviewNote ? (
        <p className="communication-small">Last message decision: {detail.reviewNote}</p>
      ) : null}
      {runId ? (
        <AgentRunDetailView
          id={runId}
          onClose={() => {
            setRunId(null);
            load().catch((e) => setError(e.message));
            onChanged();
          }}
          onChanged={() => {
            load().catch((e) => setError(e.message));
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
function CommunicationRestrictions({
  inbox,
  onChanged,
}: {
  inbox: CommunicationInboxData;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entry = inbox.suppressions.find((item) => item.email === selected);
    if (!entry || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/communication/suppressions", {
        method: "POST",
        body: JSON.stringify({
          email: entry.email,
          revision: entry.revision,
          active: !entry.active,
          attested: true,
          note: String(new FormData(event.currentTarget).get("note") ?? ""),
        }),
      });
      setSelected(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The restriction could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="communication-restrictions">
      <summary>
        <Ban size={14} />
        Contact restrictions{" "}
        <span>{inbox.suppressions.filter((item) => item.active).length} active</span>
      </summary>
      <p>
        Restrictions require a reviewed retained source. They are checked again immediately before
        external submission.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {inbox.suppressions.length ? (
        inbox.suppressions.map((entry) => (
          <div className="communication-restriction" key={entry.email}>
            <div>
              <strong>{entry.email}</strong>
              <p>
                {entry.reason} · {entry.active ? "Restricted" : "Lifted"}
              </p>
              <small>{entry.reviewNote}</small>
            </div>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setSelected(entry.email)}
            >
              {entry.active ? "Review lifting restriction" : "Reinstate restriction"}
            </button>
          </div>
        ))
      ) : (
        <p className="communication-small">No contact restrictions recorded.</p>
      )}
      {selected ? (
        <form className="communication-editor" onSubmit={submit}>
          <h3>Review restriction for {selected}</h3>
          <Field label="Restriction review note">
            <textarea name="note" minLength={20} maxLength={2000} required rows={3} />
          </Field>
          <label className="communication-consent">
            <input type="checkbox" required />I reviewed the address, retained evidence and reason
            for changing this restriction.
          </label>
          <div className="communication-editor-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setSelected(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "Saving…" : "Record restriction review"}
            </button>
          </div>
        </form>
      ) : null}
    </details>
  );
}
