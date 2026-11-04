"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, MapPin, Plus, Search, UsersRound } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { Badge, EmptyState } from "./ui";
import { dateLabel, initials } from "@/lib/format";
import { requirementTerms } from "@/lib/sourcing";
import { evaluateMatch } from "@/lib/matching";

export function RequirementsView({ onCreate }: { onCreate: () => void }) {
  const { data } = useWorkspace();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All requirements");
  const filtered = data.requirements.filter(
    (r) =>
      `${r.client} ${r.aircraftModel}`.toLowerCase().includes(query.toLowerCase()) &&
      (status === "All requirements" || r.status === status),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">BUYER REQUIREMENTS</div>
          <h1>Start with the right brief.</h1>
          <p>Clear requirements make better connections. Keep every buyer’s needs in view.</p>
        </div>
        <button type="button" className="button button-primary" onClick={onCreate}>
          <Plus size={16} />
          New requirement
        </button>
      </div>
      <div className="view-toolbar">
        <div className="tabs">
          {["All requirements", "Sourcing", "Confirmed", "Draft"].map((tab) => (
            <button
              type="button"
              key={tab}
              className={status === tab ? "active" : ""}
              aria-pressed={status === tab}
              onClick={() => setStatus(tab)}
            >
              {tab === "Confirmed" ? "Founder-recorded" : tab}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search requirements"
            placeholder="Search buyer or aircraft family…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="subtle-label">{filtered.length} REQUIREMENTS</span>
      </div>
      <div className="requirement-grid">
        {filtered.map((requirement, index) => {
          const matches = data.aircraft.filter(
            (a) => evaluateMatch(a, requirement).state === "eligible",
          );
          return (
            <article className="requirement-card" key={requirement.id}>
              <div className="requirement-top">
                <span className={`company-avatar company-${index % 3}`}>
                  {initials(requirement.client)}
                </span>
                <div>
                  <strong>{requirement.client}</strong>
                  <span>{requirement.destination}</span>
                </div>
                <Badge
                  tone={
                    requirement.status === "Sourcing"
                      ? "orange"
                      : requirement.status === "Confirmed"
                        ? "green"
                        : "neutral"
                  }
                >
                  {requirement.status === "Confirmed" ? "Founder-recorded" : requirement.status}
                </Badge>
              </div>
              <div className="requirement-title">
                <span className="eyebrow muted">
                  {requirement.category.toUpperCase()} · {requirement.transactionKind ?? "Sale"} ·{" "}
                  {requirement.quantity} {requirement.quantity === 1 ? "AIRCRAFT" : "AIRCRAFT"}
                </span>
                <h2>{requirement.aircraftModel}</h2>
                <p>
                  {requirement.description || "Additional requirements have not been supplied."}
                </p>
              </div>
              <div className="requirement-details">
                <div>
                  <span>MINIMUM YEAR</span>
                  <strong>{requirement.minYear} onwards</strong>
                </div>
                <div>
                  <span>BUDGET / AIRCRAFT</span>
                  <strong>{requirementTerms(requirement)}</strong>
                </div>
                <div>
                  <span>ENGINE PREFERENCE</span>
                  <strong>{requirement.engine || "No constraint"}</strong>
                </div>
                <div>
                  <span>DELIVERY BY</span>
                  <strong>{dateLabel(requirement.deadline)}</strong>
                </div>
              </div>
              {requirement.intelligence ? (
                <Link
                  className="requirement-evidence-link"
                  href={`/intelligence?signal=${requirement.intelligence.signalId}`}
                >
                  Founder-recorded buyer basis <ArrowUpRight size={14} />
                </Link>
              ) : null}
              <div className="requirement-footer">
                <span>
                  <span className={`tiny-dot ${matches.length > 0 ? "green" : "orange"}`} />
                  {matches.length} sourcing {matches.length === 1 ? "match" : "matches"}
                </span>
                <Link
                  className="text-link"
                  href={`/execution?requirement=${encodeURIComponent(requirement.id)}`}
                >
                  Open execution desk <ArrowUpRight size={15} />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title="A fresh start for your next brief"
          detail="Create a buyer requirement or adjust your search to find an existing one."
          action={
            <button type="button" className="button button-primary" onClick={onCreate}>
              <UsersRound size={16} />
              New requirement
            </button>
          }
        />
      ) : null}
      <div className="info-strip">
        <CalendarDays size={17} />
        <span>
          Delivery dates, engine requirements, and per-aircraft budgets are evaluated as hard
          sourcing constraints.
        </span>
        <MapPin size={16} />
      </div>
    </>
  );
}
