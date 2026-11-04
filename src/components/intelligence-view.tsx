"use client";

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  FileText,
  ListFilter,
  Plus,
  Radar,
  RefreshCw,
  Search,
  ScanText,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import {
  signalStages,
  type Intelligence,
  type SignalRecord,
} from "@/lib/intelligence/market-schema";
import { Badge } from "./ui";
import { BatchSourceModal } from "./batch-source-modal";
import { SignalReviewModal } from "./signal-review-modal";
import { useWorkspace } from "./workspace-provider";

const initial: Intelligence = {
  signals: [],
  sources: [],
  total: 0,
  page: 1,
  pages: 1,
  counts: {
    Signal: 0,
    Lead: 0,
    "Potential requirement": 0,
    "Confirmed requirement": 0,
    Dismissed: 0,
  },
  facets: { organizations: [], families: [], geographies: [] },
};
const defaults = {
  stage: "All",
  market: "All",
  intent: "All",
  organization: "",
  family: "",
  geography: "",
  days: "0",
  page: 1,
};
export function IntelligenceView() {
  const [intelligence, setIntelligence] = useState<Intelligence>(initial);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filters, setFilters] = useState(defaults);
  const [tab, setTab] = useState<"signals" | "sources">("signals");
  const [adding, setAdding] = useState(false);
  const [signal, setSignal] = useState<SignalRecord | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requirementId, setRequirementId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const { refresh } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const requested = params.get("signal");
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const search = new URLSearchParams(
        Object.entries({ ...filters, q: deferredQuery }).map(([k, v]) => [k, String(v)]),
      );
      const result = await api<Intelligence>(`/api/intelligence?${search}`);
      if (sequence === requestSequence.current) {
        setIntelligence(result);
        setError("");
        setLoading(false);
      }
    } catch (e) {
      if (sequence === requestSequence.current) {
        setError(e instanceof Error ? e.message : "Intelligence could not be loaded.");
        setLoading(false);
      }
    }
  }, [filters, deferredQuery]);
  useEffect(() => {
    void load();
    return () => {
      requestSequence.current++;
    };
  }, [load]);
  const active = intelligence.sources.some((s) => s.status === "queued" || s.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    api<SignalRecord>(`/api/intelligence/${encodeURIComponent(requested)}`, {
      signal: controller.signal,
    })
      .then(setSignal)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [requested]);
  function filter(key: keyof typeof defaults, value: string) {
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  }
  function closeSignal() {
    setSignal(null);
    if (requested) router.replace("/intelligence", { scroll: false });
  }
  async function queue(ids: string[]) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ results: { status: string; error?: string }[] }>(
        "/api/intelligence/extract",
        { method: "POST", body: JSON.stringify({ ids }) },
      );
      const queued = result.results.filter((r) => r.status === "queued").length;
      const skipped = result.results.filter((r) => r.status === "skipped");
      setMessage(
        `${queued} source${queued === 1 ? "" : "s"} queued for local market extraction.${skipped.length ? ` ${skipped.length} skipped: ${skipped[0].error}` : ""}`,
      );
      setSelected([]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction could not be queued.");
    } finally {
      setBusy(false);
    }
  }
  const counts = intelligence.counts;
  const hasFilters =
    query ||
    Object.entries(filters).some(
      ([k, v]) => k !== "page" && v !== defaults[k as keyof typeof defaults],
    );
  const ready = intelligence.sources.filter((s) => s.status === "ready" || s.status === "failed");
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">MARKET INTELLIGENCE</div>
          <h1>Find the signal. Build the connection.</h1>
          <p>Turn source material into reviewed leads and a clearer buyer brief.</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          Add market sources
        </button>
      </div>
      <section className="market-hero" aria-label="Intelligence pipeline summary">
        <div className="market-hero-copy">
          <span className="market-kicker">
            <span /> YOUR INTELLIGENCE DESK
          </span>
          <h2>
            A wider view.
            <br />A considered next move.
          </h2>
          <p>
            Capture what the market says. Decide what it means. Keep the evidence with every step.
          </p>
          <span className="market-local-mode">
            <ScanText size={14} />
            Local parsing available · human review at every stage
          </span>
        </div>
        <div className="market-radar" aria-hidden="true">
          <div className="radar-ring ring-one" />
          <div className="radar-ring ring-two" />
          <div className="radar-ring ring-three" />
          <div className="radar-cross horizontal" />
          <div className="radar-cross vertical" />
          <Radar size={30} />
          <i className="radar-point point-one" />
          <i className="radar-point point-two" />
          <i className="radar-point point-three" />
        </div>
        <div className="market-pipeline-counts">
          {signalStages.slice(0, 4).map((stage, index) => (
            <button
              type="button"
              key={stage}
              aria-pressed={filters.stage === stage}
              onClick={() => {
                filter("stage", stage);
                setTab("signals");
              }}
            >
              <span className="market-step-number">0{index + 1}</span>
              <strong>{counts[stage]}</strong>
              <span>
                {stage === "Signal"
                  ? "Unreviewed signals"
                  : stage === "Lead"
                    ? "Qualified leads"
                    : stage === "Potential requirement"
                      ? "Potential requirements"
                      : "Founder-recorded confirmations"}
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </section>
      <div className="market-tabs">
        <div className="tabs">
          <button
            type="button"
            className={tab === "signals" ? "active" : ""}
            aria-pressed={tab === "signals"}
            onClick={() => setTab("signals")}
          >
            <Radar size={15} />
            Signals & leads
          </button>
          <button
            type="button"
            className={tab === "sources" ? "active" : ""}
            aria-pressed={tab === "sources"}
            onClick={() => setTab("sources")}
          >
            <FileText size={15} />
            Source inbox <span>{intelligence.sources.length}</span>
          </button>
        </div>
        <button type="button" className="text-link" onClick={() => void load()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <div className="market-notice" role="status">
          <ShieldCheck size={17} />
          <span>{message}</span>
          {requirementId ? (
            <Link className="text-link" href={`/matches?requirement=${requirementId}`}>
              Explore matches <ArrowRight size={14} />
            </Link>
          ) : null}
        </div>
      ) : null}
      {tab === "signals" ? (
        <>
          <div className="market-filter-bar">
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Search market signals"
                value={query}
                placeholder="Search organization, aircraft, geography…"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFilters((f) => ({ ...f, page: 1 }));
                }}
              />
            </label>
            <label>
              <span className="sr-only">Signal stage</span>
              <select
                aria-label="Signal stage"
                value={filters.stage}
                onChange={(e) => filter("stage", e.target.value)}
              >
                <option value="All">All stages</option>
                {signalStages.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Market</span>
              <select
                aria-label="Market"
                value={filters.market}
                onChange={(e) => filter("market", e.target.value)}
              >
                <option value="All">Both markets</option>
                <option>Commercial</option>
                <option>Business</option>
              </select>
            </label>
            <select
              aria-label="Signal type"
              value={filters.intent}
              onChange={(e) => filter("intent", e.target.value)}
            >
              <option value="All">All signal types</option>
              <option>Demand</option>
              <option>Supply</option>
              <option>Fleet activity</option>
            </select>
          </div>
          <div className="market-secondary-filters">
            <ListFilter size={14} />
            {(
              [
                ["organization", "organizations", "All organizations"],
                ["family", "families", "All aircraft families"],
                ["geography", "geographies", "All geographies"],
              ] as const
            ).map(([key, facet, label]) => (
              <select
                aria-label={label}
                key={key}
                value={filters[key]}
                onChange={(e) => filter(key, e.target.value)}
              >
                <option value="">{label}</option>
                {intelligence.facets[facet].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ))}
            <select
              aria-label="Event recency"
              value={filters.days}
              onChange={(e) => filter("days", e.target.value)}
            >
              <option value="0">Any event date</option>
              <option value="30">Event: last 30 days</option>
              <option value="90">Event: last 90 days</option>
              <option value="365">Event: last year</option>
            </select>
            {hasFilters ? (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setFilters(defaults);
                  setQuery("");
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <section
            className="panel market-signal-panel"
            aria-label="Market signals and reviewed leads"
          >
            <div className="market-list-heading">
              <div>
                <h2>Signals worth a closer look</h2>
                <p>Source statements stay distinct from confirmed buyer demand.</p>
              </div>
              <span className="subtle-label">{intelligence.total} RESULTS</span>
            </div>
            {loading ? (
              <p className="no-results">Loading your intelligence desk…</p>
            ) : intelligence.signals.length ? (
              <div className="market-signal-list">
                {intelligence.signals.map((item) => (
                  <button
                    type="button"
                    className="market-signal-row"
                    key={item.id}
                    onClick={() => setSignal(item)}
                  >
                    <span
                      className={`market-signal-symbol ${item.values.intent === "Demand" ? "demand" : item.values.intent === "Supply" ? "supply" : "activity"}`}
                    >
                      {item.values.intent === "Demand" ? (
                        <FileSearch size={21} />
                      ) : item.values.intent === "Supply" ? (
                        <ArrowDownToLine size={21} />
                      ) : (
                        <Radar size={21} />
                      )}
                    </span>
                    <span className="market-signal-copy">
                      <span className="market-signal-overline">
                        {item.values.market ?? "MARKET UNKNOWN"} ·{" "}
                        {item.values.intent ?? "TYPE UNKNOWN"}
                      </span>
                      <strong>{item.values.organization ?? "Organization needs review"}</strong>
                      <span>
                        {item.values.aircraftFamily ?? "Aircraft family unknown"}
                        {item.values.quantity ? ` · ${item.values.quantity} aircraft` : ""} ·{" "}
                        {item.values.geography ?? "Geography unknown"}
                      </span>
                      <small>
                        <FileText size={12} />
                        {item.sourceTitle}
                      </small>
                    </span>
                    <span className="market-signal-status">
                      <Badge
                        tone={
                          item.stage === "Confirmed requirement"
                            ? "green"
                            : item.stage === "Signal"
                              ? "neutral"
                              : "orange"
                        }
                      >
                        {item.stage === "Confirmed requirement"
                          ? "Founder-recorded confirmation"
                          : item.stage}
                      </Badge>
                      <small>{item.confidence} observations</small>
                    </span>
                    <span className="market-signal-date">
                      <strong>
                        {item.values.eventDate
                          ? dateLabel(item.values.eventDate)
                          : "Event date unknown"}
                      </strong>
                      <small>Captured {dateLabel(item.capturedAt.slice(0, 10))}</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="market-empty">
                <span>
                  <Radar size={30} />
                </span>
                <h3>
                  {hasFilters
                    ? "No signals in this view."
                    : "Your next connection starts with a source."}
                </h3>
                <p>
                  {hasFilters
                    ? "Adjust the stage, market or evidence filters. Unknown event dates are excluded when a recency filter is active."
                    : "Add market briefs, fleet announcements or a CSV. Review what they establish before creating a buyer requirement."}
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => {
                    if (hasFilters) {
                      setFilters(defaults);
                      setQuery("");
                    } else setAdding(true);
                  }}
                >
                  {hasFilters ? "Clear filters" : "Add your first market source"}
                  <ArrowRight size={15} />
                </button>
              </div>
            )}
            {intelligence.pages > 1 ? (
              <div className="market-pagination">
                <span>
                  Page {intelligence.page} of {intelligence.pages} · 40 per page
                </span>
                <div>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={intelligence.page <= 1}
                    onClick={() => setFilters((f) => ({ ...f, page: intelligence.page - 1 }))}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={intelligence.page >= intelligence.pages}
                    onClick={() => setFilters((f) => ({ ...f, page: intelligence.page + 1 }))}
                  >
                    Next
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <section className="panel market-signal-panel">
          <div className="market-list-heading">
            <div>
              <h2>Originals in. Context retained.</h2>
              <p>Each source supports a separate market extraction and aircraft extraction.</p>
            </div>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !selected.length}
              onClick={() => void queue(selected)}
            >
              Extract selected ({selected.length})<ScanText size={15} />
            </button>
          </div>
          {ready.length ? (
            <label className="market-select-all">
              <input
                type="checkbox"
                checked={
                  !!selected.length && ready.slice(0, 100).every((s) => selected.includes(s.id))
                }
                onChange={(e) =>
                  setSelected(e.target.checked ? ready.slice(0, 100).map((s) => s.id) : [])
                }
              />
              Select up to 100 ready sources
            </label>
          ) : null}
          {loading ? (
            <p className="no-results">Loading source inbox…</p>
          ) : intelligence.sources.length ? (
            intelligence.sources.map((s) => (
              <div className="market-inbox-row" key={s.id}>
                <input
                  type="checkbox"
                  aria-label={`Select ${s.title}`}
                  checked={selected.includes(s.id)}
                  disabled={
                    busy ||
                    !["ready", "failed"].includes(s.status) ||
                    (!selected.includes(s.id) && selected.length >= 100)
                  }
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                    )
                  }
                />
                <span className="review-item-icon">
                  <FileText size={19} />
                </span>
                <div className="market-inbox-copy">
                  <strong>{s.title}</strong>
                  <span>
                    {s.kind.toUpperCase()} · Captured {dateLabel(s.createdAt.slice(0, 10))} ·{" "}
                    {s.sha256.slice(0, 12)}
                  </span>
                  {s.error ? <small className="source-job-error">{s.error}</small> : null}
                </div>
                <Badge
                  tone={
                    s.status === "completed" ? "green" : s.status === "failed" ? "red" : "neutral"
                  }
                >
                  {s.status === "ready" ? "Not extracted" : s.status}
                </Badge>
                <a
                  className="icon-button"
                  aria-label={`Download ${s.title}`}
                  href={`/api/sources/${s.id}/document`}
                >
                  <ArrowDownToLine size={16} />
                </a>
                {["ready", "failed"].includes(s.status) ? (
                  <button
                    className="text-link"
                    type="button"
                    disabled={busy}
                    onClick={() => void queue([s.id])}
                  >
                    {s.status === "failed" ? "Retry" : "Extract"}
                    <ArrowRight size={14} />
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <div className="market-empty">
              <span>
                <FileText size={28} />
              </span>
              <h3>Keep the original. Grow the picture.</h3>
              <p>
                Add batches of PDF, CSV, TXT and EML documents, or paste a market brief. Exact
                duplicates are reported separately.
              </p>
              <button
                className="button button-primary"
                type="button"
                onClick={() => setAdding(true)}
              >
                Add market sources
                <Plus size={15} />
              </button>
            </div>
          )}
        </section>
      )}
      <div className="market-footer-note">
        <ShieldCheck size={18} />
        <p>
          A source can describe demand, supply or fleet activity. An open mandate needs its own
          confirmation.{" "}
          <Link href="/sources">
            Review aircraft evidence <ArrowRight size={13} />
          </Link>
        </p>
        <span>CAPTURE → REVIEW → CONFIRM → MATCH</span>
      </div>
      {adding ? (
        <BatchSourceModal
          onClose={() => setAdding(false)}
          onDone={async () => {
            setTab("sources");
            await load();
          }}
        />
      ) : null}
      {signal ? (
        <SignalReviewModal
          key={`${signal.id}:${signal.revision}`}
          signal={signal}
          onClose={closeSignal}
          onDone={async (id) => {
            closeSignal();
            setRequirementId(id);
            setMessage(
              id
                ? "Buyer requirement confirmed with its evidence. It now uses your existing matching rules."
                : "Review saved. The signal has moved to its next stage.",
            );
            await Promise.all([load(), refresh()]);
          }}
        />
      ) : null}
    </>
  );
}
