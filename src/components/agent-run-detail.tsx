"use client";
import { dateTimeLabel, workspaceTimeZone } from "@/lib/format";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, RefreshCw, Square, X } from "lucide-react";
import { agentById } from "@/lib/agents/catalog";
import type { AgentRunDetail, ProposalRecord } from "@/lib/agents/schema";
import { api } from "@/lib/api";
import { useWorkspace } from "./workspace-provider";
import { Badge, Field, Modal } from "./ui";
export function AgentRunDetailView({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { refresh } = useWorkspace();
  const decisionForm = useRef<HTMLFormElement>(null);
  const [run, setRun] = useState<AgentRunDetail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [decision, setDecision] = useState<{
      proposal: ProposalRecord;
      decision: "accept" | "reject";
    } | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const detail = await api<AgentRunDetail>(`/api/agents/${id}`, { signal });
      if (!signal?.aborted) setRun(detail);
      return detail;
    },
    [id],
  );
  useEffect(() => {
    if (decision) decisionForm.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [decision]);
  const active = run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(),
      timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        load(controller.signal)
          .then((detail) => {
            if (!["queued", "running"].includes(detail.status)) onChanged();
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(e.message);
          });
      }, 1800);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, load, onChanged]);
  async function operation(value: "cancel" | "retry") {
    if (!run || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>(`/api/agents/${id}`, {
        method: "POST",
        body: JSON.stringify({ operation: value, revision: run.revision }),
      });
      await load();
      onChanged();
      if (result.id !== id) {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run could not be changed.");
    } finally {
      setBusy(false);
    }
  }
  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!run || !decision || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ status: string; message: string }>(
        `/api/agents/proposals/${decision.proposal.id}`,
        {
          method: "POST",
          body: JSON.stringify({
            decision: decision.decision,
            revision: run.revision,
            note: String(form.get("note") ?? ""),
            attested: form.get("attested") === "on",
          }),
        },
      );
      await load();
      await refresh();
      window.dispatchEvent(new Event("aerion-execution-updated"));
      onChanged();
      setDecision(null);
      if (result.status === "obsolete") setError(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision was not saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={run ? `${agentById(run.agentId).name} · run result` : "Opening agent run"}
      description="Inspect the work performed, retained evidence and proposed changes before acting."
      onClose={onClose}
    >
      <div className="agent-result">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {!run ? (
          <p role="status">Loading the saved run…</p>
        ) : (
          <>
            <div className="agent-result-meta">
              <Badge
                tone={
                  run.status === "failed"
                    ? "red"
                    : active
                      ? "orange"
                      : run.status === "review"
                        ? "blue"
                        : "green"
                }
              >
                {run.status}
              </Badge>
              <span>
                {run.provider === "rules" ? "Deterministic tools" : run.provider}{" "}
                {run.model ? `· ${run.model}` : ""}
              </span>
              <small>
                Attempt {run.attempts} · {dateTimeLabel(run.createdAt)}
              </small>
            </div>
            {active ? (
              <div className="agent-working" role="status">
                <RefreshCw size={18} />
                <div>
                  <strong>
                    {run.status === "queued"
                      ? "Waiting for the local worker"
                      : "The agent is working"}
                  </strong>
                  <p>
                    Tool steps appear as they are retained. This run continues if you close this
                    dialog.
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void operation("cancel")}
                >
                  <Square size={12} />
                  Cancel run
                </button>
              </div>
            ) : null}
            {run.error ? (
              <div className="agent-failure">
                <strong>Run needs attention</strong>
                <p>{run.error}</p>
              </div>
            ) : null}
            {run.report ? (
              <>
                <p className="agent-result-summary">{run.report.summary}</p>
                {run.provider !== "rules" ? (
                  <p className="agent-generated-note">
                    Generated analysis requires review. Passage checks establish source traceability
                    and do not independently verify a conclusion.
                  </p>
                ) : null}
                <div className="agent-findings">
                  {run.report.findings.map((f) => (
                    <article
                      key={`${f.title}:${f.detail}`}
                      className={`agent-finding finding-${f.severity}`}
                    >
                      <span className="agent-finding-mark">
                        {f.severity === "missing" ? "?" : f.severity === "review" ? "!" : "·"}
                      </span>
                      <div>
                        <h3>{f.title}</h3>
                        <p>{f.detail}</p>
                        {f.citations.map((c) => (
                          <details
                            className="agent-citation"
                            key={`${c.sourceId}:${c.page}:${c.quote}`}
                          >
                            <summary>
                              Source · page {c.page} · {c.quote.slice(0, 55)}
                              {c.quote.length > 55 ? "…" : ""}
                            </summary>
                            <blockquote>{c.quote}</blockquote>
                            <a href={`/api/sources/${c.sourceId}/document`} className="text-link">
                              Original document <ArrowUpRight size={12} />
                            </a>
                          </details>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
            <div className="agent-result-section">
              <h3>
                Action proposals{" "}
                <span>
                  {run.proposals.filter((p) => p.status === "proposed").length} awaiting review
                </span>
              </h3>
              <p>
                Accepting a proposal saves the described change. Confirmation, technical
                verification and external sending remain separate.
              </p>
            </div>
            {run.proposals.map((p) => (
              <article className="agent-proposal" key={p.id}>
                <div className="agent-proposal-top">
                  <h4>{p.title}</h4>
                  <Badge
                    tone={
                      p.status === "accepted"
                        ? "green"
                        : p.status === "proposed"
                          ? "blue"
                          : "neutral"
                    }
                  >
                    {p.status}
                  </Badge>
                </div>
                <p>{p.reason}</p>
                {p.action.type === "lead" || p.action.type === "lead-enrichment" ? (
                  <dl className="agent-lead-fields">
                    {Object.entries({
                      ...(p.action.type === "lead"
                        ? {
                            Side: p.action.values.side,
                            "Evidence basis": p.action.values.basis,
                            Aircraft: p.action.values.aircraftModel,
                          }
                        : { "Research type": "Published business contact" }),
                      Organization: p.action.values.organization,
                      Geography: p.action.values.geography,
                      "Published contact": p.action.values.contactName,
                      "Published email": p.action.values.email,
                      "Published phone": p.action.values.phone,
                    }).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value ?? "Not stated"}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <details>
                    <summary>Review proposed record fields</summary>
                    <pre>{JSON.stringify(p.action, null, 2)}</pre>
                  </details>
                )}
                {p.citations.map((c) => (
                  <details className="agent-citation" key={`${c.sourceId}:${c.page}:${c.quote}`}>
                    <summary>Supporting passage · page {c.page}</summary>
                    <blockquote>{c.quote}</blockquote>
                    <a href={`/api/sources/${c.sourceId}/document`} className="text-link">
                      Original document <ArrowUpRight size={12} />
                    </a>
                  </details>
                ))}
                {p.resolutionNote ? (
                  <p className="agent-resolution">Decision note: {p.resolutionNote}</p>
                ) : null}
                {p.status === "accepted" &&
                (p.action.type === "lead" || ("leadId" in p.action && p.action.leadId)) ? (
                  <Link
                    className="text-link"
                    href={`/discovery?lead=${p.action.type === "lead" ? p.appliedRef : "leadId" in p.action ? p.action.leadId : ""}`}
                    onClick={onClose}
                  >
                    Open lead qualification workspace <ArrowUpRight size={12} />
                  </Link>
                ) : null}
                {p.status === "proposed" && !active ? (
                  <div className="agent-proposal-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => {
                        setDecision({ proposal: p, decision: "reject" });
                        setError("");
                      }}
                    >
                      <X size={13} />
                      Reject
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy}
                      onClick={() => {
                        setDecision({ proposal: p, decision: "accept" });
                        setError("");
                      }}
                    >
                      <Check size={13} />
                      Review & accept
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
            {!run.proposals.length ? (
              <p className="agent-caption">
                This run has no record-change proposals. Review findings or supply the missing
                inputs before another run.
              </p>
            ) : null}
            {decision ? (
              <form ref={decisionForm} className="agent-decision-form" onSubmit={resolve}>
                <h3>
                  {decision.decision === "accept" ? "Accept" : "Reject"}: {decision.proposal.title}
                </h3>
                <Field label="Decision note">
                  <textarea
                    name="note"
                    required
                    minLength={5}
                    maxLength={2000}
                    placeholder="Record your review and any relevant context."
                  />
                </Field>
                {decision.decision === "accept" ? (
                  <label className="agent-consent">
                    <input type="checkbox" name="attested" required />I reviewed the proposed
                    fields, current context and supporting evidence.
                  </label>
                ) : null}
                <div>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setDecision(null)}
                  >
                    Back
                  </button>
                  <button type="submit" className="button button-primary" disabled={busy}>
                    {busy ? "Saving…" : "Save decision"}
                  </button>
                </div>
              </form>
            ) : null}
            <details className="agent-trace">
              <summary>
                Tool activity <span>{run.steps.length} saved steps</span>
              </summary>
              {run.steps.map((step) => (
                <ToolStep key={step.id} step={step} />
              ))}
              {!run.steps.length ? <p>No tool step has been retained yet.</p> : null}
            </details>
            {run.report?.limitations.length ? (
              <details className="agent-limitations">
                <summary>Limits and unresolved assumptions</summary>
                <ul>
                  {run.report.limitations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {run.usage ? (
              <p className="agent-usage">
                Agent loop usage (excludes separate extraction jobs) · {run.usage.requests} requests
                · {run.usage.inputTokens.toLocaleString()} input tokens ·{" "}
                {run.usage.outputTokens.toLocaleString()} output tokens
              </p>
            ) : null}
            <div className="agent-result-footer">
              <Link
                className="text-link"
                href={
                  run.input.requirementId
                    ? `/execution?requirement=${encodeURIComponent(run.input.requirementId)}`
                    : "/sources"
                }
              >
                {run.input.requirementId ? "Open connected execution desk" : "Open source library"}
                <ArrowUpRight size={13} />
              </Link>
              {["failed", "cancelled", "needs-input"].includes(run.status) ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void operation("retry")}
                >
                  <RefreshCw size={13} />
                  Retry as a new run
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
function ToolStep({ step }: { step: AgentRunDetail["steps"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {step.tool.replaceAll("_", " ")}{" "}
        <small>
          {new Date(step.createdAt).toLocaleTimeString("en-IN", { timeZone: workspaceTimeZone })}
        </small>
      </summary>
      {open ? (
        <>
          <span className="eyebrow muted">INPUT</span>
          <pre>{JSON.stringify(step.input, null, 2)}</pre>
          <span className="eyebrow muted">RESULT</span>
          <pre>{JSON.stringify(step.output, null, 2)}</pre>
        </>
      ) : null}
    </details>
  );
}
