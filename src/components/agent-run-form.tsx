"use client";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { agentProviderLabels } from "@/lib/agents/providers";
import type { AgentDefinition } from "@/lib/agents/catalog";
import type { AgentCenter, AgentProvider, AgentSchedule, RunInput } from "@/lib/agents/schema";
import type { SourceRecord } from "@/lib/intelligence/schema";
import { api } from "@/lib/api";
import { useWorkspace } from "./workspace-provider";
import { Field, Modal } from "./ui";
export function AgentRunForm({
  agent,
  center,
  sources,
  onClose,
  onQueued,
  onMessage,
  schedule,
}: {
  agent: AgentDefinition;
  center: AgentCenter;
  sources: SourceRecord[];
  onClose: () => void;
  onQueued: (id: string) => void;
  onMessage: (message: string) => void;
  schedule?: AgentSchedule;
}) {
  const { data } = useWorkspace();
  const key = useRef(crypto.randomUUID());
  const [provider, setProvider] = useState<AgentProvider>(schedule?.provider ?? "rules"),
    [sourceIds, setSourceIds] = useState<string[]>(schedule?.input.sourceIds ?? []),
    [connectorIds, setConnectorIds] = useState<string[]>(schedule?.input.connectorIds ?? []),
    [query, setQuery] = useState("");
  const [scheduling, setScheduling] = useState(Boolean(schedule?.enabled)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const configuration = center.providers.find((p) => p.id === provider),
    selectedSources = sources.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget),
      text = (name: string) => String(form.get(name) ?? "");
    const input: RunInput = {
      agentId: agent.id,
      provider,
      requirementId: text("requirementId") || null,
      aircraftId: text("aircraftId") || null,
      contactId: text("contactId") || null,
      sourceIds,
      connectorIds,
      objective: text("objective"),
      allowExternalSources: form.get("allowExternalSources") === "on",
      allowModelData: form.get("allowModelData") === "on",
      allowMailbox: form.get("allowMailbox") === "on",
      idempotencyKey: key.current,
    };
    try {
      if (schedule) {
        await api("/api/agents/schedules", {
          method: "POST",
          body: JSON.stringify({
            agentId: agent.id,
            provider,
            enabled: scheduling,
            intervalHours: Number(text("intervalHours")),
            input: omitIdentity(input),
          }),
        });
        onMessage("Agent schedule saved");
        onClose();
        return;
      }
      const run = await api<{ id: string; reused: boolean }>("/api/agents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      let message = run.reused ? "Existing active run opened" : "Agent run queued";
      if (scheduling) {
        try {
          await api("/api/agents/schedules", {
            method: "POST",
            body: JSON.stringify({
              agentId: agent.id,
              provider,
              enabled: true,
              intervalHours: Number(text("intervalHours")),
              input: omitIdentity(input),
            }),
          });
          message += " · recurring run enabled";
        } catch {
          message += " · schedule was not saved; configure it from Sources & schedules";
        }
      }
      onMessage(message);
      onQueued(run.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "This request could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={schedule ? `Schedule ${agent.name.toLowerCase()}` : `Run ${agent.name.toLowerCase()}`}
      description={agent.description}
      onClose={onClose}
    >
      <form className="modal-form agent-run-form" onSubmit={submit}>
        <div className="agent-input-note">
          <strong>Useful inputs</strong>
          <p>{agent.inputs}</p>
          <small>{agent.boundary}</small>
        </div>
        <Field label="Execution provider" hint={configuration?.detail}>
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)}>
            {center.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {agentProviderLabels[item.id]} ·{" "}
                {item.id === "rules"
                  ? "available now"
                  : item.ready
                    ? "configured"
                    : "configuration required"}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Buyer requirement">
            <select name="requirementId" defaultValue={schedule?.input.requirementId ?? ""}>
              <option value="">Choose when relevant</option>
              {data.requirements.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.client} · {r.aircraftModel}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Aircraft">
            <select name="aircraftId" defaultValue={schedule?.input.aircraftId ?? ""}>
              <option value="">Choose when relevant</option>
              {data.aircraft.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.manufacturer} {a.model} · {a.serial}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Contact">
          <select name="contactId" defaultValue={schedule?.input.contactId ?? ""}>
            <option value="">Choose when relevant</option>
            {data.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.type}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="agent-selection">
          <legend>
            Retained documents <span>{sourceIds.length} / 20 selected</span>
          </legend>
          <input
            aria-label="Filter agent source documents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a document…"
          />
          <div>
            {selectedSources.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={sourceIds.includes(s.id)}
                  disabled={!sourceIds.includes(s.id) && sourceIds.length >= 20}
                  onChange={(e) =>
                    setSourceIds((ids) =>
                      e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                    )
                  }
                />
                <span>
                  {s.title}
                  <small>{s.kind.toUpperCase()} · retained original</small>
                </span>
              </label>
            ))}
            {!selectedSources.length ? (
              <p>No documents in this view. Add originals in the source library.</p>
            ) : null}
          </div>
          <small>
            Linked aircraft evidence and requirement readiness documents are also available to the
            run.
          </small>
        </fieldset>
        {agent.tools.includes("collect_source") ? (
          <fieldset className="agent-selection">
            <legend>
              Approved source connectors <span>Choose up to two per run</span>
            </legend>
            <div>
              {center.connectors
                .filter((c) => c.enabled)
                .map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={connectorIds.includes(c.id)}
                      disabled={!connectorIds.includes(c.id) && connectorIds.length >= 2}
                      onChange={(e) =>
                        setConnectorIds((ids) =>
                          e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span>
                      {c.name}
                      <small>
                        {c.purpose} · {new URL(c.url).hostname}
                      </small>
                    </span>
                  </label>
                ))}
              {!center.connectors.some((c) => c.enabled) ? (
                <p>Register public HTTPS sources in Sources & schedules.</p>
              ) : null}
            </div>
          </fieldset>
        ) : null}
        {agent.id === "communication" ? (
          <div className="agent-input-note">
            <strong>Mailbox intake</strong>
            <p>
              {center.connections.mailbox.ready
                ? `${center.connections.mailbox.account} · ${center.connections.mailbox.folder}`
                : "Configure a dedicated IMAP account and folder to enable live intake. Retained EML/text messages work without a connection."}
            </p>
            <label className="agent-consent">
              <input
                type="checkbox"
                name="allowMailbox"
                disabled={!center.connections.mailbox.ready}
                defaultChecked={schedule?.input.allowMailbox}
              />
              Collect up to five messages and supported attachments from this configured folder in
              read-only mode.
            </label>
          </div>
        ) : null}
        {["buyer-discovery", "aircraft-discovery"].includes(agent.id) ? (
          <div className="agent-input-note">
            <p>
              For a web search or specific public URLs, use{" "}
              <Link href="/discovery" className="text-link">
                Lead discovery
              </Link>
              . This form runs against your selected documents and connectors.
            </p>
          </div>
        ) : null}
        <Field label="Task details (optional)">
          <textarea
            name="objective"
            maxLength={2000}
            defaultValue={schedule?.input.objective ?? ""}
            placeholder="What should this agent focus on or resolve?"
          />
        </Field>
        {connectorIds.length ? (
          <label className="agent-consent">
            <input
              type="checkbox"
              name="allowExternalSources"
              required
              defaultChecked={schedule?.input.allowExternalSources}
            />
            Collect from the selected public source URLs and retain their original responses.
          </label>
        ) : null}
        {provider !== "rules" ? (
          <label className="agent-consent">
            <input
              type="checkbox"
              name="allowModelData"
              required
              defaultChecked={schedule?.input.allowModelData}
            />
            Allow the configured model provider to receive workspace record context and selected or
            linked document passages for this run{scheduling ? " and its recurring runs" : ""}.
            {["due-diligence", "deal-coordination", "negotiation"].includes(agent.id)
              ? " This includes related transaction reviews, fee conditions and invoice/payment balances for the selected case."
              : null}
          </label>
        ) : null}
        <div className="agent-schedule-choice">
          <label className="agent-consent">
            <input
              type="checkbox"
              checked={scheduling}
              onChange={(e) => setScheduling(e.target.checked)}
            />
            {schedule ? "Enable this recurring run" : "Repeat this task automatically"}
          </label>
          {scheduling || schedule ? (
            <Field label="Repeat every">
              <select name="intervalHours" defaultValue={schedule?.intervalHours ?? 24}>
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={168}>7 days</option>
              </select>
            </Field>
          ) : null}
          <p>
            Recurring runs use these inputs while the local worker is running. Changes to business
            records still produce proposals for review.
          </p>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span className="form-inline-note">Saved tools, results and action history</span>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || (!configuration?.ready && (!schedule || scheduling))}
          >
            {busy ? "Saving…" : schedule ? "Save schedule" : "Queue agent run"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function omitIdentity({
  agentId: _agentId,
  provider: _provider,
  idempotencyKey: _key,
  ...input
}: RunInput) {
  return input;
}
