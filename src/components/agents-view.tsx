"use client";
import { agentProviderLabels } from "@/lib/agents/providers";
import { dateTimeLabel } from "@/lib/format";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCheck,
  Clock3,
  Compass,
  Crosshair,
  FileSearch,
  FileText,
  Mail,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  ScanText,
  Settings2,
  ShieldCheck,
  UsersRound,
  Workflow,
} from "lucide-react";
import { agentCatalog, agentById, type AgentDefinition, type AgentId } from "@/lib/agents/catalog";
import type { AgentCenter, AgentSchedule } from "@/lib/agents/schema";
import type { Pipeline, SourceRecord } from "@/lib/intelligence/schema";
import { api } from "@/lib/api";
import { Badge, EmptyState, Field, Modal } from "./ui";
import { AgentRunForm } from "./agent-run-form";
import { AgentRunDetailView } from "./agent-run-detail";
const icons = {
  "aircraft-discovery": Radar,
  "aircraft-intelligence": Compass,
  "buyer-discovery": UsersRound,
  "buyer-requirements": ScanText,
  matching: Crosshair,
  outreach: Mail,
  communication: MessagesSquare,
  documents: FileSearch,
  "due-diligence": ShieldCheck,
  "deal-coordination": Workflow,
  negotiation: Network,
  crm: FileText,
};
export function AgentsView() {
  const [center, setCenter] = useState<AgentCenter | null>(null),
    [sources, setSources] = useState<SourceRecord[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [tab, setTab] = useState("Agents"),
    [page, setPage] = useState(1),
    [runId, setRunId] = useState<string | null>(null),
    [form, setForm] = useState<{ agent: AgentDefinition; schedule?: AgentSchedule } | null>(null),
    [connector, setConnector] = useState(false);
  const load = useCallback(async () => {
    const value = await api<AgentCenter>(`/api/agents?page=${page}`);
    setCenter(value);
    return value;
  }, [page]);
  const refresh = useCallback(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<AgentCenter>(`/api/agents?page=${page}`, { signal: controller.signal }),
      api<Pipeline>("/api/sources", { signal: controller.signal }),
    ])
      .then(([value, pipeline]) => {
        if (!controller.signal.aborted) {
          setCenter(value);
          setSources(pipeline.sources);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [page]);
  const active = Boolean((center?.counts.queued ?? 0) + (center?.counts.running ?? 0));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [active, refresh]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 6500);
    return () => clearTimeout(timer);
  }, [message]);
  function start(agent: AgentDefinition, schedule?: AgentSchedule) {
    api<Pipeline>("/api/sources")
      .then((p) => setSources(p.sources))
      .catch((e) => setError(e.message));
    setForm({ agent, schedule });
  }
  async function pause(schedule: AgentSchedule) {
    try {
      await api("/api/agents/schedules", {
        method: "POST",
        body: JSON.stringify({ ...schedule, enabled: false }),
      });
      refresh();
      setMessage("Recurring run paused");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not pause this schedule.");
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">AERION AGENTS</div>
          <h1>Your operations, in motion.</h1>
          <p>Start the work. Inspect the evidence. Decide what moves forward.</p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setError("");
            refresh();
          }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {error ? (
        <div className="agent-page-error" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="agent-page-message" role="status">
          <CheckCheck size={15} />
          {message}
        </div>
      ) : null}
      {!center ? (
        <p role="status">Loading your agent operations…</p>
      ) : (
        <>
          <div className="agent-operations-hero">
            <span className="agent-operations-symbol">
              <Bot size={30} />
            </span>
            <div>
              <span className="eyebrow">TWELVE ROLES · ONE OPERATING WORKSPACE</span>
              <h2>Work you can follow, decisions you can trace.</h2>
              <p>
                Each run uses its granted tools, retains results, and prepares changes for your
                review.
              </p>
            </div>
            <div className="agent-provider-status">
              <span className="tiny-dot green" />
              Local tools available
              <span>
                {center.providers.some((p) => p.id !== "rules" && p.ready)
                  ? "Model configuration detected"
                  : "Live AI needs model configuration"}
              </span>
            </div>
          </div>
          <div className="agent-stats">
            {[
              {
                icon: Play,
                label: "Active runs",
                value: (center.counts.queued ?? 0) + (center.counts.running ?? 0),
              },
              { icon: CheckCheck, label: "Runs awaiting review", value: center.counts.review ?? 0 },
              { icon: Workflow, label: "Finished runs", value: center.counts.completed ?? 0 },
              {
                icon: Clock3,
                label: "Enabled schedules",
                value: center.schedules.filter((s) => s.enabled).length,
              },
            ].map((item) => (
              <div key={item.label}>
                <item.icon size={16} />
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="agent-workspace-tabs">
            {["Agents", "Run history", "Sources & schedules"].map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={tab === name}
                className={tab === name ? "active" : ""}
                onClick={() => setTab(name)}
              >
                {name}
                {name === "Run history" ? <span>{center.totalRuns}</span> : null}
              </button>
            ))}
          </div>
          {tab === "Agents" ? (
            <>
              <div className="agent-mode-notice">
                <span>RUN MODES</span>
                <p>
                  <strong>Local tools</strong> run deterministic workflows now.{" "}
                  <strong>OpenAI / NVIDIA / Ollama</strong> run model-driven tool loops once
                  configured. Provider labels describe configuration; successful live runs establish
                  connectivity.
                </p>
              </div>
              <div className="agent-operating-grid">
                {agentCatalog.map((agent, index) => {
                  const Icon = icons[agent.id],
                    last = center.runs.find((r) => r.agentId === agent.id),
                    schedule = center.schedules.find((s) => s.agentId === agent.id);
                  return (
                    <article className="agent-operating-card" key={agent.id}>
                      <div className="agent-operating-card-top">
                        <span
                          className={`agent-card-icon ${index % 3 === 0 ? "orange" : index % 3 === 1 ? "blue" : "green"}`}
                        >
                          <Icon size={21} />
                        </span>
                        <span className="agent-role-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                      </div>
                      <h2>{agent.name}</h2>
                      <p>{agent.description}</p>
                      <div className="agent-card-input">
                        <span>INPUT</span>
                        {agent.inputs}
                      </div>
                      <div className="agent-card-run-state">
                        {last ? (
                          <button
                            type="button"
                            className="text-link"
                            onClick={() => setRunId(last.id)}
                          >
                            Latest run: {last.status}
                            <ArrowUpRight size={12} />
                          </button>
                        ) : (
                          <span>Ready for its first run</span>
                        )}
                        {schedule?.enabled ? (
                          <span
                            className="agent-scheduled-dot"
                            title={`Every ${schedule.intervalHours} hours`}
                          />
                        ) : null}
                      </div>
                      <div className="agent-card-controls">
                        <button
                          type="button"
                          className="button button-primary"
                          aria-label={`Run ${agent.name}`}
                          onClick={() => start(agent)}
                        >
                          <Play size={12} />
                          Run agent
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Configure ${agent.name} schedule`}
                          onClick={() => start(agent, schedule ?? defaultSchedule(agent.id))}
                        >
                          <Settings2 size={15} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : tab === "Run history" ? (
            <section className="agent-history-panel">
              <div className="agent-section-heading">
                <div>
                  <h2>Every run leaves a record.</h2>
                  <p>Execution provider, saved tool work, findings and proposal decisions.</p>
                </div>
                <span>{center.totalRuns} runs</span>
              </div>
              {center.runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="agent-history-row"
                  onClick={() => setRunId(run.id)}
                >
                  <span className="agent-history-icon">
                    <Bot size={17} />
                  </span>
                  <div>
                    <strong>{agentById(run.agentId).name}</strong>
                    <small>
                      {run.provider === "rules"
                        ? "Local deterministic tools"
                        : `${run.provider} · ${run.model}`}{" "}
                      · {dateTimeLabel(run.createdAt)}
                    </small>
                    <p>
                      {run.error ??
                        run.report?.summary ??
                        (run.status === "queued"
                          ? "Waiting for the local worker"
                          : "Open to inspect saved tool activity")}
                    </p>
                  </div>
                  <Badge
                    tone={
                      run.status === "failed"
                        ? "red"
                        : run.status === "review"
                          ? "blue"
                          : ["queued", "running"].includes(run.status)
                            ? "orange"
                            : "neutral"
                    }
                  >
                    {run.status}
                  </Badge>
                  <ArrowUpRight size={15} />
                </button>
              ))}
              {!center.runs.length ? (
                <EmptyState
                  title="Your first run starts a working history"
                  detail="Choose an agent and supply the relevant records or original documents."
                  action={
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => setTab("Agents")}
                    >
                      Choose an agent <ArrowRight size={14} />
                    </button>
                  }
                />
              ) : null}
              <div className="agent-pagination">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page} of {Math.max(1, Math.ceil(center.totalRuns / 40))}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={page * 40 >= center.totalRuns}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </section>
          ) : (
            <div className="agent-configuration-grid">
              <section className="agent-history-panel">
                <div className="agent-section-heading">
                  <div>
                    <h2>Source connectors</h2>
                    <p>Public HTTPS pages, feeds, JSON or text selected for collection.</p>
                  </div>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setConnector(true)}
                  >
                    <Plus size={13} />
                    Add source
                  </button>
                </div>
                {center.connectors.map((source) => (
                  <article key={source.id} className="agent-connector-row">
                    <div>
                      <strong>{source.name}</strong>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.url}
                        <ArrowUpRight size={12} />
                      </a>
                      <small>
                        {source.purpose} · {source.format} ·{" "}
                        {source.lastCollectedAt
                          ? `Collected ${dateTimeLabel(source.lastCollectedAt)}`
                          : "No collection recorded"}
                      </small>
                    </div>
                    <Badge tone={source.enabled ? "green" : "neutral"}>
                      {source.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </article>
                ))}
                {!center.connectors.length ? (
                  <p className="agent-caption">
                    Add approved sources, then select them in an aircraft or buyer discovery run.
                    Collection retains originals and respects access failures.
                  </p>
                ) : null}
                <Link className="text-link" href="/sources">
                  Open retained source library <ArrowUpRight size={13} />
                </Link>
              </section>
              <section className="agent-history-panel">
                <div className="agent-section-heading">
                  <div>
                    <h2>Recurring work</h2>
                    <p>Runs continue while the local worker is running on this machine.</p>
                  </div>
                  <Clock3 size={21} />
                </div>
                {center.schedules.map((schedule) => (
                  <article key={schedule.agentId} className="agent-schedule-row">
                    <div>
                      <strong>{agentById(schedule.agentId).name}</strong>
                      <small>
                        {schedule.enabled
                          ? `Every ${schedule.intervalHours} hours · ${schedule.provider}`
                          : "Paused"}
                      </small>
                      <p>
                        {schedule.nextRunAt
                          ? `Next run ${dateTimeLabel(schedule.nextRunAt)}`
                          : "No next run scheduled"}
                      </p>
                    </div>
                    <div>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${agentById(schedule.agentId).name} schedule`}
                        onClick={() => start(agentById(schedule.agentId), schedule)}
                      >
                        <Settings2 size={14} />
                      </button>
                      {schedule.enabled ? (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Pause ${agentById(schedule.agentId).name} schedule`}
                          onClick={() => void pause(schedule)}
                        >
                          <Pause size={14} />
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
                {!center.schedules.length ? (
                  <p className="agent-caption">
                    Use the settings control on an agent to choose inputs, provider and recurrence.
                    Scheduling is opt-in for each role.
                  </p>
                ) : null}
              </section>
              <section className="agent-history-panel agent-providers-panel">
                <div className="agent-section-heading">
                  <div>
                    <h2>Execution providers</h2>
                    <p>
                      Secrets remain in .env.local. Restart the web server and worker after
                      configuration changes.
                    </p>
                  </div>
                </div>
                {center.providers.map((provider) => (
                  <div key={provider.id}>
                    <strong>{agentProviderLabels[provider.id]}</strong>
                    <Badge tone={provider.ready ? "green" : "orange"}>
                      {provider.id === "rules"
                        ? "Available"
                        : provider.ready
                          ? "Configured"
                          : "Setup needed"}
                    </Badge>
                    <p>{provider.detail}</p>
                    {provider.model ? <small>Configured model: {provider.model}</small> : null}
                  </div>
                ))}
                <div>
                  <strong>Business mailbox intake</strong>
                  <Badge tone={center.connections.mailbox.ready ? "green" : "orange"}>
                    {center.connections.mailbox.ready ? "Configured" : "Setup needed"}
                  </Badge>
                  <p>
                    Read-only IMAP intake from an explicitly selected business folder.{" "}
                    {center.connections.mailbox.account
                      ? `${center.connections.mailbox.account} · ${center.connections.mailbox.folder}`
                      : "Configure IMAP_HOST, IMAP_USER, IMAP_FOLDER and an app password or access token."}
                  </p>
                </div>
                <div>
                  <strong>Reviewed email submission</strong>
                  <Badge tone={center.connections.smtp.ready ? "green" : "orange"}>
                    {center.connections.smtp.ready ? "Configured" : "Setup needed"}
                  </Badge>
                  <p>
                    SMTP sending is available only after a founder reviews a current draft and
                    approves the specific message.{" "}
                    {center.connections.smtp.sender
                      ? `Configured sender: ${center.connections.smtp.sender}`
                      : "Configure SMTP_HOST, SMTP_USER, SMTP_FROM and an app password or access token."}
                  </p>
                </div>
              </section>
            </div>
          )}
        </>
      )}
      {form && center ? (
        <AgentRunForm
          agent={form.agent}
          schedule={form.schedule}
          center={center}
          sources={sources}
          onClose={() => {
            setForm(null);
            refresh();
          }}
          onQueued={(id) => {
            setRunId(id);
            refresh();
          }}
          onMessage={setMessage}
        />
      ) : null}
      {runId ? (
        <AgentRunDetailView
          key={runId}
          id={runId}
          onClose={() => setRunId(null)}
          onChanged={refresh}
        />
      ) : null}
      {connector ? (
        <ConnectorForm
          onClose={() => setConnector(false)}
          onSaved={() => {
            setConnector(false);
            refresh();
            setMessage("Source connector saved");
          }}
        />
      ) : null}
    </>
  );
}
function defaultSchedule(agentId: AgentId): AgentSchedule {
  return {
    agentId,
    enabled: false,
    provider: "rules",
    intervalHours: 24,
    nextRunAt: null,
    input: {
      requirementId: null,
      aircraftId: null,
      contactId: null,
      sourceIds: [],
      connectorIds: [],
      objective: "",
      allowExternalSources: false,
      allowModelData: false,
      allowMailbox: false,
    },
  };
}
function ConnectorForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/agents/connectors", {
        method: "POST",
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          url: String(form.get("url") ?? ""),
          format: String(form.get("format")),
          purpose: String(form.get("purpose")),
          enabled: form.get("enabled") === "on",
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this source.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add an approved source"
      description="Choose a specific public HTTPS page, RSS/Atom feed, JSON endpoint or text document. Credentials and private network URLs are not supported."
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={save}>
        <Field label="Source name">
          <input name="name" required maxLength={200} />
        </Field>
        <Field label="Public HTTPS URL">
          <input type="url" name="url" required maxLength={2000} placeholder="https://…" />
        </Field>
        <div className="form-grid">
          <Field label="Source format">
            <select name="format">
              <option value="page">Web page</option>
              <option value="feed">RSS / Atom feed</option>
              <option value="json">JSON</option>
              <option value="text">Plain text</option>
            </select>
          </Field>
          <Field label="Discovery purpose">
            <select name="purpose">
              <option value="aircraft">Aircraft availability</option>
              <option value="market">Buyer / market signals</option>
            </select>
          </Field>
        </div>
        <label className="agent-consent">
          <input type="checkbox" name="enabled" defaultChecked />
          Enable this source for collection when explicitly selected in a run or schedule.
        </label>
        <p className="agent-caption">
          Only public responses are collected. A login, access restriction or unsupported document
          is reported for review.
        </p>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span />
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Saving…" : "Save source"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
