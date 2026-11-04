"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, Check, RefreshCw, ShieldCheck } from "lucide-react";
import type { Operations } from "@/lib/operations/schema";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/format";
import { Badge, Field } from "./ui";

export function OperationsView() {
  const [detail, setDetail] = useState<Operations | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await api<Operations>("/api/operations", { signal });
    if (!signal?.aborted) setDetail(value);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        load(controller.signal).catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api<Operations>("/api/operations", {
        method: "POST",
        body: JSON.stringify({
          revision: detail.revision,
          settings: {
            paused: form.get("paused") === "on",
            maxModelJobs: Number(form.get("jobs")),
            maxAgentTokens: Number(form.get("tokens")),
            maxSearches: Number(form.get("searches")),
            maxMail: Number(form.get("mail")),
          },
          note: String(form.get("note") ?? ""),
        }),
      });
      setDetail(value);
      setEditing(false);
      setNotice("Operating limits saved. Existing submitted work is retained.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ops-view">
      <header className="ops-heading">
        <div>
          <p className="eyebrow">AERION / OPERATIONS</p>
          <h1>Keep the business moving.</h1>
          <p>Runtime health, agent evidence and the limits behind every run.</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="ops-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!detail ? (
        <p role="status">Reading current operating state…</p>
      ) : (
        <>
          <div className="ops-metrics">
            <article>
              <span>Worker</span>
              <strong>{detail.worker.ready ? "Running" : "Needs attention"}</strong>
              <small>
                {detail.worker.lastSeen
                  ? `Last heartbeat ${dateTimeLabel(detail.worker.lastSeen)}`
                  : "No heartbeat recorded"}
              </small>
            </article>
            <article>
              <span>Agent work</span>
              <strong>
                {detail.jobs.runningAgents} running · {detail.jobs.queuedAgents} queued
              </strong>
              <small>{detail.jobs.queuedExtractions} queued extractions</small>
            </article>
            <article>
              <span>Agent capability acceptance</span>
              <strong>
                {detail.validations.filter((v) => v.status === "passed").length} / 12 passed
              </strong>
              <small>
                {detail.validations.filter((v) => v.observed).length} roles have successful
                workspace runs; observations are separate from acceptance
              </small>
            </article>
            <article>
              <span>Database backup</span>
              <strong>{detail.backup?.verifiedAt ? "Restore tested" : "Setup needed"}</strong>
              <small>
                {detail.backup
                  ? dateTimeLabel(detail.backup.createdAt)
                  : "Create a private backup below"}
              </small>
            </article>
          </div>
          <div className="ops-grid">
            <section className="ops-card">
              <div className="ops-card-title">
                <Activity size={17} />
                <h2>What needs attention</h2>
              </div>
              {detail.alerts.length ? (
                detail.alerts.map((alert) => (
                  <Link className="ops-alert" key={alert.key} href={alert.href}>
                    <div>
                      <strong>{alert.title}</strong>
                      <p>{alert.detail}</p>
                    </div>
                    <ArrowUpRight size={15} />
                  </Link>
                ))
              ) : (
                <p className="ops-empty">
                  <Check size={16} /> No current operating alerts.
                </p>
              )}
            </section>
            <section className="ops-card">
              <div className="ops-card-title">
                <ShieldCheck size={17} />
                <h2>Daily operating limits</h2>
                <button type="button" className="text-link" onClick={() => setEditing((v) => !v)}>
                  {editing ? "Close" : "Edit limits"}
                </button>
              </div>
              <p>Workspace day: {detail.usage.day} · Asia/Kolkata</p>
              <dl className="ops-usage">
                {[
                  ["AI jobs", detail.usage.modelJobs, detail.settings.maxModelJobs],
                  [
                    "Observed agent tokens",
                    detail.usage.agentTokens,
                    detail.settings.maxAgentTokens,
                  ],
                  ["Brave searches", detail.usage.searches, detail.settings.maxSearches],
                  ["Email queue entries", detail.usage.mail, detail.settings.maxMail],
                ].map(([label, used, limit]) => (
                  <div key={String(label)}>
                    <dt>{label}</dt>
                    <dd>
                      {Number(used).toLocaleString()} / {Number(limit).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="ops-fine">
                AI jobs count agent runs and model extractions. Token totals cover reported
                agent-loop usage; separate extraction usage and provider billing are not included.
                Observed-token limits stop new jobs after reported usage reaches the limit; a
                request already running can finish. These are usage controls, not a currency
                spending guarantee.
              </p>
              {editing ? (
                <form className="ops-settings" onSubmit={submit}>
                  <fieldset disabled={busy}>
                    <label className="ops-checkbox">
                      <input
                        name="paused"
                        type="checkbox"
                        defaultChecked={detail.settings.paused}
                      />{" "}
                      Pause new agent work and email submissions
                    </label>
                    <div className="ops-fields">
                      <Field label="Daily AI jobs">
                        <input
                          name="jobs"
                          type="number"
                          min="1"
                          max="500"
                          required
                          defaultValue={detail.settings.maxModelJobs}
                        />
                      </Field>
                      <Field label="Daily observed agent tokens">
                        <input
                          name="tokens"
                          type="number"
                          min="1000"
                          max="100000000"
                          required
                          defaultValue={detail.settings.maxAgentTokens}
                        />
                      </Field>
                      <Field label="Daily Brave searches">
                        <input
                          name="searches"
                          type="number"
                          min="1"
                          max="1000"
                          required
                          defaultValue={detail.settings.maxSearches}
                        />
                      </Field>
                      <Field label="Daily email queue entries">
                        <input
                          name="mail"
                          type="number"
                          min="1"
                          max="500"
                          required
                          defaultValue={detail.settings.maxMail}
                        />
                      </Field>
                    </div>
                    <Field label="Reason for this change">
                      <textarea name="note" required minLength={10} maxLength={1000} />
                    </Field>
                    <button type="submit" className="button button-primary">
                      {busy ? "Saving…" : "Save operating limits"}
                    </button>
                  </fieldset>
                </form>
              ) : null}
            </section>
          </div>
          <section className="ops-card">
            <div className="ops-card-title">
              <h2>All twelve agents</h2>
              <Link href="/agents" className="text-link">
                Open Agent center <ArrowUpRight size={13} />
              </Link>
            </div>
            <p>
              Acceptance checks verify actual stored role, provider, report, tool trace and required
              actions. Published fictional-fixture proof contains hashes and counts rather than
              private documents. A successful workspace run is shown as an observation until an
              explicit capability check passes. These checks do not establish domain quality,
              transaction authority or business outcomes.
            </p>
            <div className="ops-agents">
              {detail.validations.map((value) => (
                <article key={value.agentId}>
                  <div>
                    <strong>{value.name}</strong>
                    <Badge
                      tone={
                        value.status === "passed"
                          ? "green"
                          : value.status === "failed"
                            ? "red"
                            : "neutral"
                      }
                    >
                      {value.status === "passed"
                        ? "Capability check passed"
                        : value.status === "failed"
                          ? "Acceptance check failed"
                          : value.status === "observed"
                            ? "Live run observed"
                            : "Live evidence pending"}
                    </Badge>
                  </div>
                  <small>
                    {value.proofKind === "published-fixture"
                      ? "Verified fictional fixture · private source data retained separately"
                      : value.acceptanceProfile
                        ? "Verified capability on retained workspace records"
                        : value.observed
                          ? "Successful workspace API run · acceptance pending"
                          : "Local integration tests available"}
                    {value.checkedAt ? ` · ${dateTimeLabel(value.checkedAt)}` : ""}
                  </small>
                  {value.summary ? (
                    <details>
                      <summary>Read saved outcome</summary>
                      <p>{value.summary}</p>
                      <p className="ops-fine">Model: {value.model}</p>
                      {value.counts ? (
                        <p className="ops-fine">
                          Verified trace: {value.counts.toolCalls} business tool calls ·{" "}
                          {value.counts.proposals} proposals · {value.counts.accepted} accepted
                          actions.
                          {value.counts.reportDiagnostics
                            ? ` ${value.counts.reportDiagnostics} rejected-report correction diagnostic(s) retained separately.`
                            : ""}
                        </p>
                      ) : null}
                      {value.reportHash ? (
                        <p className="ops-fine">Report SHA-256: {value.reportHash}</p>
                      ) : null}
                      {value.acceptanceProfile ? (
                        <p className="ops-fine">Acceptance profile: {value.acceptanceProfile}</p>
                      ) : null}
                    </details>
                  ) : null}
                  {value.history.length ? (
                    <details>
                      <summary>Acceptance history ({value.history.length})</summary>
                      {value.history.map((record) => (
                        <p className="ops-fine" key={record.sourceRunId}>
                          {record.verified
                            ? record.status === "passed"
                              ? "Passed capability check"
                              : "Failed capability check"
                            : "Unverified historical entry"}{" "}
                          ·{" "}
                          {record.origin === "live-fixture"
                            ? "Fictional fixture"
                            : "Workspace record"}{" "}
                          · {dateTimeLabel(record.checkedAt)}
                          <br />
                          Report hash: {record.reportHash}
                        </p>
                      ))}
                    </details>
                  ) : null}
                  {value.sourceRunId &&
                  value.proofKind !== "published-fixture" &&
                  value.origin === "operational-run" ? (
                    <Link href="/agents" className="text-link">
                      Inspect saved runs <ArrowUpRight size={12} />
                    </Link>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
          <section className="ops-card">
            <h2>Local readiness and recovery</h2>
            <div className="ops-connections">
              {Object.entries({
                "Local development access": detail.configuration.local,
                "NVIDIA model configuration": detail.configuration.nvidia,
                "Brave Search configuration": detail.configuration.brave,
                "Business SMTP": detail.configuration.smtp,
                "Business IMAP": detail.configuration.imap,
              }).map(([label, ready]) => (
                <div key={label}>
                  <span>{label}</span>
                  <Badge tone={ready ? "green" : "neutral"}>
                    {ready ? "Configured" : "Deferred"}
                  </Badge>
                </div>
              ))}
            </div>
            <p>
              Configuration is not a live connection test. Keep local access on this computer. The
              production server refuses development authentication.
            </p>
            <div className="ops-backup">
              <strong>Create and verify a database backup</strong>
              <code>npm run db:backup -- --verify-local</code>
              <p>
                The command writes a private PostgreSQL archive, restores it into a newly created
                temporary local test database, checks row counts and removes only that temporary
                database. Your business database remains the source.
              </p>
              {detail.backup ? (
                <p className="ops-fine">
                  Last archive: {detail.backup.bytes.toLocaleString()} bytes · SHA-256{" "}
                  {detail.backup.sha256}
                </p>
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
