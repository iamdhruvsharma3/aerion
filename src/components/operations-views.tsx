"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  FileText,
  Mail,
  MapPin,
  MoreHorizontal,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { aircraftTerms } from "@/lib/sourcing";
import { Badge, EmptyState, Field, Modal } from "./ui";
import { dealSchema, dealStages, type Contact, type Deal } from "@/lib/schema";
import { dateLabel, initials } from "@/lib/format";
import { api } from "@/lib/api";
import { isTerminal, type TransactionSummary } from "@/lib/transactions/schema";
const TransactionWorkspace = dynamic(() => import("./transaction-workspace"), {
  loading: () => <p role="status">Opening transaction workspace…</p>,
});

export function DealsView({ notify }: { notify: (message: string) => void }) {
  const { data, dispatch, saving } = useWorkspace();
  const [editing, setEditing] = useState<Deal | null>(null);
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<TransactionSummary[]>([]),
    [transactionError, setTransactionError] = useState(""),
    [transactionId, setTransactionId] = useState<string | null>(null);
  const loadTransactions = useCallback(async (signal?: AbortSignal) => {
    const current = await api<TransactionSummary[]>("/api/transactions", { signal });
    if (!signal?.aborted) {
      setTransactions(current);
      setTransactionError("");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadTransactions(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setTransactionError(e.message);
    });
    return () => controller.abort();
  }, [loadTransactions]);
  useEffect(() => {
    const read = () =>
      setTransactionId(new URL(window.location.href).searchParams.get("transaction"));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const openTransaction = (id: string | null) => {
    setTransactionId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("transaction", id);
    else url.searchParams.delete("transaction");
    window.history.replaceState(null, "", url);
  };
  const archived = data.deals.filter((deal) => {
    const status = transactions.find((t) => t.dealId === deal.id)?.status;
    return status && isTerminal(status);
  });
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const result = dealSchema.safeParse({
      ...editing,
      ...Object.fromEntries(new FormData(event.currentTarget)),
    });
    if (!result.success) {
      setError("Add a valid next action and due date.");
      return;
    }
    if (!(await dispatch({ type: "deal", item: result.data }))) {
      setError("The update was not saved. Check the workspace message and retry.");
      return;
    }
    setEditing(null);
    notify("Opportunity updated");
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">DEAL ROOM</div>
          <h1>Keep good things moving.</h1>
          <p>Your opportunities, next actions, and milestones. All connected.</p>
        </div>
        <Link className="button button-primary" href="/matches">
          <Plus size={16} />
          Add from matches
        </Link>
      </div>
      <div className="pipeline-summary">
        <span>
          <span className="tiny-dot green" />
          {data.deals.length - archived.length} active opportunities · {archived.length} completed
          or archived
        </span>
        <p>
          Stages organize your work. They do not certify that transaction conditions are satisfied.
        </p>
      </div>
      {transactionError ? (
        <p role="alert" className="form-error">
          Transaction records could not be loaded: {transactionError}{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => loadTransactions().catch((e) => setTransactionError(e.message))}
          >
            Retry
          </button>
        </p>
      ) : null}
      <div className="kanban">
        {dealStages.map((stage, index) => {
          const deals = data.deals.filter(
            (deal) => deal.stage === stage && !archived.some((item) => item.id === deal.id),
          );
          return (
            <section className="kanban-column" key={stage}>
              <div className="kanban-heading">
                <span className={`stage-dot stage-${index}`} />
                <h2>{stage}</h2>
                <span className="count-tag">{deals.length}</span>
              </div>
              {deals.map((deal) => {
                const aircraft = data.aircraft.find((a) => a.id === deal.aircraftId);
                const requirement = data.requirements.find((r) => r.id === deal.requirementId);
                const lifecycle = transactions.find((t) => t.dealId === deal.id);
                return (
                  <article className="deal-card" key={deal.id}>
                    <div className="deal-top">
                      <span className="mono muted">
                        {deal.id.startsWith("DEAL") ? deal.id : "OPPORTUNITY"}
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${deal.title}`}
                        onClick={() => {
                          if (lifecycle && lifecycle.revision > 0) openTransaction(deal.id);
                          else setEditing(deal);
                          setError("");
                        }}
                      >
                        <MoreHorizontal size={17} />
                      </button>
                    </div>
                    <h3>{deal.title}</h3>
                    {lifecycle && lifecycle.revision > 0 ? (
                      <div className="deal-transaction-badge">
                        <Badge tone="green">
                          {lifecycle.status} · cycle {lifecycle.cycle}
                        </Badge>
                      </div>
                    ) : null}
                    <p>
                      {aircraft
                        ? `${aircraft.year} · ${aircraft.manufacturer} ${aircraft.model}`
                        : "Aircraft record unavailable"}
                    </p>
                    <div className="deal-value">
                      {aircraft ? aircraftTerms(aircraft) : "Terms unavailable"}
                      <span>Indicative aircraft terms</span>
                    </div>
                    {deal.evidence ? (
                      <Link
                        className="deal-evidence-link"
                        href={`/sources?review=${deal.evidence.reviewId}`}
                      >
                        <FileText size={13} />
                        Reviewed source evidence
                      </Link>
                    ) : null}
                    {deal.requirementEvidence ? (
                      <Link
                        className="deal-evidence-link"
                        href={`/intelligence?signal=${deal.requirementEvidence.signalId}`}
                      >
                        <FileText size={13} />
                        Buyer confirmation evidence
                      </Link>
                    ) : null}
                    <div className="deal-action">
                      <span>NEXT ACTION</span>
                      <strong>{lifecycle?.nextAction || deal.nextAction}</strong>
                    </div>
                    <div className="deal-footer">
                      <span>
                        <CalendarDays size={13} />
                        {dateLabel(
                          lifecycle && lifecycle.revision > 0 ? lifecycle.dueOn : deal.dueDate,
                        )}
                      </span>
                      <span className="mini-avatar" title={requirement?.client}>
                        {initials(requirement?.client ?? "Buyer")}
                      </span>
                    </div>
                    <Link
                      className="deal-open"
                      href={`/execution?requirement=${encodeURIComponent(deal.requirementId)}`}
                    >
                      Open execution desk <ArrowUpRight size={14} />
                    </Link>
                    <button
                      type="button"
                      className="deal-open"
                      onClick={() => openTransaction(deal.id)}
                    >
                      Open transaction workspace <ArrowUpRight size={14} />
                    </button>
                    <button
                      type="button"
                      className="deal-open"
                      onClick={() => {
                        if (lifecycle && lifecycle.revision > 0) openTransaction(deal.id);
                        else setEditing(deal);
                        setError("");
                      }}
                    >
                      Update opportunity <ArrowRight size={14} />
                    </button>
                  </article>
                );
              })}
              {deals.length === 0 ? (
                <div className="kanban-empty">
                  <Workflow size={22} />
                  <p>A little room for your next move.</p>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {archived.length ? (
        <section className="transaction-closed-list">
          <h2>Completed and archived opportunities</h2>
          <div className="transaction-closed-grid">
            {archived.map((deal) => {
              const lifecycle = transactions.find((t) => t.dealId === deal.id);
              return (
                <article className="deal-card" key={deal.id}>
                  <Badge tone={lifecycle?.status === "Completed" ? "green" : "neutral"}>
                    {lifecycle?.status}
                  </Badge>
                  <h3>{deal.title}</h3>
                  <p>
                    Cycle {lifecycle?.cycle}
                    {lifecycle?.completedOn
                      ? ` · completed ${dateLabel(lifecycle.completedOn)}`
                      : ""}
                  </p>
                  <button
                    type="button"
                    className="deal-open"
                    onClick={() => openTransaction(deal.id)}
                  >
                    Review outcome and history <ArrowUpRight size={14} />
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {transactionId ? (
        <TransactionWorkspace
          id={transactionId}
          onClose={() => openTransaction(null)}
          onChanged={() => {
            void loadTransactions().catch((e) => setTransactionError(e.message));
          }}
        />
      ) : null}
      {editing ? (
        <Modal
          title="Move the opportunity forward"
          description={editing.title}
          onClose={() => setEditing(null)}
        >
          <form className="modal-form" onSubmit={save}>
            <Field label="Pipeline stage">
              <select name="stage" defaultValue={editing.stage}>
                {dealStages.map((stage) => (
                  <option key={stage}>{stage}</option>
                ))}
              </select>
            </Field>
            <Field label="Next action">
              <input name="nextAction" defaultValue={editing.nextAction} required maxLength={300} />
            </Field>
            <Field label="Due date">
              <input type="date" name="dueDate" defaultValue={editing.dueDate} required />
            </Field>
            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <span />
              <button className="button button-primary" type="submit" disabled={saving}>
                Save changes
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

export function ContactsView({ onCreate }: { onCreate: () => void }) {
  const { data } = useWorkspace();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("Everyone");
  const [selected, setSelected] = useState<Contact | null>(null);
  const filtered = data.contacts.filter(
    (contact) =>
      `${contact.name} ${contact.company} ${contact.role}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (type === "Everyone" || contact.type === type),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">RELATIONSHIP INTELLIGENCE</div>
          <h1>People make things possible.</h1>
          <p>Keep the context behind every conversation close at hand.</p>
        </div>
        <button type="button" className="button button-primary" onClick={onCreate}>
          <Plus size={16} />
          Add contact
        </button>
      </div>
      <div className="view-toolbar">
        <div className="tabs">
          {["Everyone", "Buyer", "Seller", "Broker", "Specialist"].map((tab) => (
            <button
              type="button"
              key={tab}
              aria-pressed={type === tab}
              className={type === tab ? "active" : ""}
              onClick={() => setType(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search contacts"
            placeholder="Search names, organizations, or roles…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="subtle-label">{filtered.length} CONTACTS</span>
      </div>
      <div className="contact-grid">
        {filtered.map((contact, index) => (
          <button
            type="button"
            className="contact-card"
            key={contact.id}
            onClick={() => setSelected(contact)}
          >
            <div className="contact-card-top">
              <span className={`contact-avatar company-${index % 3}`}>
                {initials(contact.name)}
              </span>
              <ArrowUpRight size={17} />
            </div>
            <h2>{contact.name}</h2>
            <p>{contact.role}</p>
            <strong>{contact.company}</strong>
            <div className="contact-location">
              <MapPin size={13} />
              {contact.location}
            </div>
            <div className="contact-card-bottom">
              <Badge tone={contact.type === "Buyer" ? "blue" : "neutral"}>{contact.type}</Badge>
              <span>
                View contact <ArrowRight size={13} />
              </span>
            </div>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title="Your next connection starts here"
          detail="Add a contact or try a different search."
        />
      ) : null}
      {selected ? (
        <Modal
          title={selected.name}
          description={`${selected.role} · ${selected.company}`}
          onClose={() => setSelected(null)}
        >
          <div className="contact-detail">
            <Badge tone="blue">{selected.type}</Badge>
            <p>
              <Mail size={16} />
              {selected.email}
            </p>
            <p>
              <MapPin size={16} />
              {selected.location}
            </p>
            <div className="detail-note">
              <FileText size={17} />
              <div>
                <strong>Relationship notes</strong>
                <p>{selected.notes || "No notes yet."}</p>
              </div>
            </div>
            <span className="form-inline-note">
              Contact record only. Aerion will not send messages from this screen.
            </span>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
