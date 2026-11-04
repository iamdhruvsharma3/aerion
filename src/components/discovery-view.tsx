"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Globe2,
  Link2,
  LoaderCircle,
  Plane,
  Radar,
  RefreshCw,
  Search,
  UsersRound,
} from "lucide-react";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/format";
import type { AgentProvider, Citation } from "@/lib/agents/schema";
import {
  suggestedQuery,
  type DiscoveryCenter,
  type DiscoveryInput,
  type LeadValues,
} from "@/lib/discovery/schema";
import { Badge, Field } from "./ui";
import { AgentRunDetailView } from "./agent-run-detail";
const LeadWorkspace = dynamic(() => import("./lead-workspace"));

type InboxTab = "review" | "saved" | "history";
const providerName = (id: string) =>
  ({
    nvidia: "NVIDIA Nemotron",
    openai: "OpenAI",
    ollama: "Local Ollama",
    rules: "Collect pages only",
  })[id] ?? id;
export function DiscoveryView() {
  const router = useRouter(),
    search = useSearchParams(),
    requestedLead = search.get("lead");
  const [leadId, setLeadId] = useState<string | null>(requestedLead);
  const [buyerIntent, setBuyerIntent] = useState<"Demand" | "Fleet" | "Profiles">("Demand");
  const [center, setCenter] = useState<DiscoveryCenter | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [side, setSide] = useState<DiscoveryInput["side"]>("Buyer");
  const [target, setTarget] = useState("");
  const [market, setMarket] = useState<DiscoveryInput["market"]>("Any");
  const [region, setRegion] = useState("");
  const [method, setMethod] = useState<DiscoveryInput["method"]>("web");
  const [freshness, setFreshness] = useState<DiscoveryInput["freshness"]>("any");
  const [queryOverride, setQueryOverride] = useState<string | null>(null);
  const [urls, setUrls] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("nvidia");
  const [consent, setConsent] = useState(false);
  const [tab, setTab] = useState<InboxTab>("review");
  const [runId, setRunId] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const query = queryOverride ?? suggestedQuery(side, target, region, buyerIntent);
  useEffect(() => {
    if (requestedLead) {
      setLeadId(requestedLead);
      setRunId(null);
    }
  }, [requestedLead]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await api<DiscoveryCenter>("/api/discovery", { signal });
    if (!signal?.aborted) setCenter(value);
    return value;
  }, []);
  const refresh = useCallback(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setProvider(
          (value.providers.find((p) => p.id === "nvidia" && p.ready)?.id as AgentProvider) ??
            (value.providers.find((p) => p.ready && p.id !== "rules")?.id as AgentProvider) ??
            "rules",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [load]);
  const active =
    center?.sessions.some(({ run }) => run.status === "queued" || run.status === "running") ??
    false;
  useEffect(() => {
    if (!active) return;
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
  }, [active, load]);
  const readyProvider = center?.providers.find((p) => p.id === provider && p.ready);
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    requestKey.current ??= crypto.randomUUID();
    try {
      const discovery: DiscoveryInput = {
        side,
        target: target.trim(),
        market,
        region: region.trim(),
        method,
        query: method === "web" ? query : "",
        urls:
          method === "urls"
            ? urls
                .split(/\r?\n/)
                .map((url) => url.trim())
                .filter(Boolean)
            : [],
        freshness,
        buyerIntent,
      };
      const result = await api<{ id: string }>("/api/discovery", {
        method: "POST",
        body: JSON.stringify({
          agentId: side === "Buyer" ? "buyer-discovery" : "aircraft-discovery",
          provider,
          aircraftId: null,
          requirementId: null,
          contactId: null,
          sourceIds: [],
          connectorIds: [],
          discovery,
          objective: `Find relevant ${side.toLowerCase()}-side evidence for ${target.trim()}. Save only source-supported lead proposals. Treat fleet activity and business profiles as research targets. Current intent, availability and representation need qualification.`,
          allowExternalSources: consent,
          allowModelData: consent && provider !== "rules",
          allowMailbox: false,
          idempotencyKey: requestKey.current,
        }),
      });
      requestKey.current = null;
      setConsent(false);
      setTab("history");
      setRunId(result.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery could not start.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="discovery-desk">
      <section className="discovery-hero">
        <div className="discovery-hero-copy">
          <span className="eyebrow">AERION INTELLIGENCE / ORIGINATION</span>
          <h1>Find the next conversation.</h1>
          <p>
            Discover buyer signals and aircraft listings.
            <br />
            Keep the source. Review the lead. Build your pipeline.
          </p>
        </div>
        <div className="discovery-radar" aria-hidden="true">
          <Radar size={94} strokeWidth={0.65} />
          <span>PUBLIC SOURCE RESEARCH</span>
        </div>
        <div className="discovery-scoreboard">
          <div>
            <strong>{center?.counts.pending ?? "—"}</strong>
            <span>awaiting review</span>
          </div>
          <div>
            <strong>{center?.counts.saved ?? "—"}</strong>
            <span>saved leads</span>
          </div>
          <div>
            <strong>{center?.counts.pages ?? "—"}</strong>
            <span>pages retained</span>
          </div>
        </div>
      </section>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="discovery-layout">
        <section className="discovery-workbench" aria-labelledby="discovery-form-heading">
          <div className="discovery-panel-heading">
            <span className="discovery-step">01</span>
            <div>
              <h3 id="discovery-form-heading">Start a discovery run</h3>
              <p>Give your agents a focused search.</p>
            </div>
          </div>
          <form
            onSubmit={start}
            onChange={() => {
              if (!busy) requestKey.current = null;
            }}
          >
            <fieldset disabled={busy}>
              <fieldset className="discovery-segment" aria-label="Lead side">
                {(["Buyer", "Seller"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={side === value}
                    onClick={() => {
                      setSide(value);
                      setQueryOverride(null);
                    }}
                  >
                    <span>
                      {value === "Buyer" ? <UsersRound size={15} /> : <Plane size={15} />}
                      {value === "Buyer" ? "Find buyers" : "Find sellers"}
                    </span>
                  </button>
                ))}
              </fieldset>
              {side === "Buyer" ? (
                <Field
                  label="Buyer search focus"
                  hint="Purchase requirements need explicit demand. Fleet signals and profiles remain research targets."
                >
                  <select
                    value={buyerIntent}
                    onChange={(e) => {
                      setBuyerIntent(e.target.value as "Demand" | "Fleet" | "Profiles");
                      setQueryOverride(null);
                    }}
                  >
                    <option value="Demand">Stated purchase requirements</option>
                    <option value="Fleet">Fleet activity signals</option>
                    <option value="Profiles">Operator / company research</option>
                  </select>
                </Field>
              ) : null}
              <Field label="Aircraft or fleet focus">
                <input
                  required
                  minLength={2}
                  maxLength={120}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="e.g. Airbus A319 or midsize jets"
                />
              </Field>
              <div className="discovery-form-pair">
                <Field label="Aircraft market">
                  <select
                    value={market}
                    onChange={(e) => setMarket(e.target.value as DiscoveryInput["market"])}
                  >
                    <option value="Any">Both markets</option>
                    <option>Commercial</option>
                    <option>Business</option>
                  </select>
                </Field>
                <Field label="Region (optional)">
                  <input
                    maxLength={120}
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="Worldwide"
                  />
                </Field>
              </div>
              <fieldset className="discovery-method" aria-label="Discovery method">
                <button
                  type="button"
                  aria-pressed={method === "web"}
                  onClick={() => setMethod("web")}
                >
                  <Globe2 size={13} />
                  Web search
                </button>
                <button
                  type="button"
                  aria-pressed={method === "urls"}
                  onClick={() => setMethod("urls")}
                >
                  <Link2 size={13} />
                  Specific URLs
                </button>
              </fieldset>
              {method === "web" ? (
                <>
                  <Field
                    label="Search query"
                    hint="One search, up to six results. Edit the query to narrow your research."
                  >
                    <textarea
                      required
                      maxLength={400}
                      rows={3}
                      value={query}
                      onChange={(e) => setQueryOverride(e.target.value)}
                    />
                  </Field>
                  {queryOverride !== null ? (
                    <button
                      className="text-link discovery-query-reset"
                      type="button"
                      onClick={() => setQueryOverride(null)}
                    >
                      Reset suggested query
                    </button>
                  ) : null}
                  <Field
                    label="Search window"
                    hint="Page age is an index estimate; current intent and availability remain unknown."
                  >
                    <select
                      value={freshness}
                      onChange={(e) => setFreshness(e.target.value as DiscoveryInput["freshness"])}
                    >
                      <option value="year">Past year</option>
                      <option value="month">Past month</option>
                      <option value="any">Any time</option>
                    </select>
                  </Field>
                  {!center?.search.ready ? (
                    <div className="discovery-connection-note">
                      <strong>Connect Brave Search to search the web.</strong>
                      <p>Public URL inspection is ready to use while you add the search key.</p>
                      <a
                        href="https://api-dashboard.search.brave.com/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Brave API dashboard <ArrowUpRight size={12} />
                      </a>
                    </div>
                  ) : null}
                </>
              ) : (
                <Field
                  label="Public page URLs"
                  hint="One HTTPS URL per line, up to three. Use an aircraft listing, procurement page or company announcement."
                >
                  <textarea
                    required
                    rows={4}
                    value={urls}
                    maxLength={6002}
                    onChange={(e) => setUrls(e.target.value)}
                    placeholder="https://…"
                  />
                </Field>
              )}
              <Field label="Research agent">
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AgentProvider)}
                >
                  {(center?.providers ?? [{ id: "nvidia", ready: false }]).map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.ready}>
                      {providerName(p.id)}
                      {p.ready ? "" : " · not connected"}
                    </option>
                  ))}
                </select>
              </Field>
              {provider === "rules" ? (
                <p className="discovery-field-note">
                  Collects original pages. Choose a connected AI model to generate structured lead
                  proposals.
                </p>
              ) : (
                <p className="discovery-field-note">
                  {readyProvider?.model ?? "Waiting for model configuration"}
                </p>
              )}
              <label className="discovery-consent">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Allow this run to {method === "web" ? "send the query to Brave and " : ""}fetch
                  these public pages
                  {provider !== "rules" ? ` and send their text to ${providerName(provider)}` : ""}.
                </span>
              </label>
              <button
                className="button button-primary discovery-submit"
                type="submit"
                disabled={
                  busy || !center || !readyProvider || (method === "web" && !center.search.ready)
                }
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
                {busy ? "Starting discovery…" : "Start discovery"}
                <ArrowRight size={15} />
              </button>
              <p className="discovery-run-bound">
                Up to 3 public pages · proposals reviewed before saving
              </p>
            </fieldset>
          </form>
        </section>
        <section className="discovery-inbox" aria-labelledby="discovery-inbox-heading">
          <div className="discovery-panel-heading">
            <span className="discovery-step">02</span>
            <div>
              <h3 id="discovery-inbox-heading">Your lead inbox</h3>
              <p>Evidence first. Qualification next.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={refresh}
              aria-label="Refresh discovery"
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div
            className="discovery-tabs"
            role="tablist"
            aria-label="Discovery inbox"
            onKeyDown={(event) => {
              const tabs: InboxTab[] = ["review", "saved", "history"];
              const index = tabs.indexOf(tab);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 3
                  : event.key === "ArrowLeft"
                    ? (index + 2) % 3
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : null;
              if (next === null) return;
              event.preventDefault();
              setTab(tabs[next]);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`#discovery-tab-${tabs[next]}`)
                ?.focus();
            }}
          >
            {(
              [
                { id: "review", label: "To review", count: center?.counts.pending },
                { id: "saved", label: "Saved leads", count: center?.counts.saved },
                { id: "history", label: "Search history", count: center?.counts.runs },
              ] as const
            ).map((item) => (
              <button
                type="button"
                key={item.id}
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                id={`discovery-tab-${item.id}`}
                aria-controls={`discovery-panel-${item.id}`}
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                <span>{item.count ?? "—"}</span>
              </button>
            ))}
          </div>
          <div
            className="discovery-inbox-body"
            role="tabpanel"
            id={`discovery-panel-${tab}`}
            aria-labelledby={`discovery-tab-${tab}`}
          >
            {!center ? (
              <p className="discovery-loading">Loading discovery…</p>
            ) : tab === "review" ? (
              center.proposals.length ? (
                <>
                  <p className="discovery-list-note">
                    Check the original passage and decide which candidates belong in your pipeline.
                  </p>
                  {center.proposals.map((proposal) =>
                    proposal.action.type === "lead" ? (
                      <LeadCard
                        key={proposal.id}
                        values={proposal.action.values}
                        url={proposal.sourceUrl}
                        sourceId={proposal.action.sourceId}
                        citations={proposal.citations}
                        saved={false}
                        onReview={() => setRunId(proposal.runId)}
                      />
                    ) : null,
                  )}
                </>
              ) : (
                <DiscoveryEmpty active={active} side={side} kind="review" />
              )
            ) : tab === "saved" ? (
              center.leads.length ? (
                <>
                  <p className="discovery-list-note">
                    Saved research leads. Confirm current needs, availability and representation
                    before creating an opportunity.
                  </p>
                  {center.leads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      values={lead.values}
                      url={lead.url}
                      sourceId={lead.sourceId}
                      citations={lead.citations}
                      saved
                      onReview={() => setRunId(lead.runId)}
                      onWork={() => {
                        setLeadId(lead.id);
                        router.replace(`/discovery?lead=${lead.id}`, { scroll: false });
                      }}
                    />
                  ))}
                  {center.counts.saved > center.leads.length ? (
                    <p className="discovery-list-note">Showing the latest 100 saved leads.</p>
                  ) : null}
                </>
              ) : (
                <DiscoveryEmpty active={false} side={side} kind="saved" />
              )
            ) : center.sessions.length ? (
              <>
                <p className="discovery-list-note">
                  Each run retains its exact search scope, results and collection outcomes.
                </p>
                {center.sessions.map((session) => (
                  <article className="discovery-session" key={session.run.id}>
                    <div className="discovery-session-top">
                      <span>{session.run.input.discovery?.side} research</span>
                      <Badge
                        tone={
                          session.run.status === "failed"
                            ? "red"
                            : ["queued", "running"].includes(session.run.status)
                              ? "blue"
                              : session.run.status === "review"
                                ? "orange"
                                : "neutral"
                        }
                      >
                        {session.run.status}
                      </Badge>
                    </div>
                    <h4>{session.run.input.discovery?.target}</h4>
                    <p>
                      {dateTimeLabel(session.run.createdAt)} · {providerName(session.run.provider)}
                    </p>
                    <details>
                      <summary>
                        {session.results.length} results ·{" "}
                        {session.results.filter((r) => r.status === "retained").length} pages
                        retained
                      </summary>
                      <p className="discovery-query-text">
                        {session.run.input.discovery?.method === "web"
                          ? session.run.input.discovery.query
                          : "Specific public URLs"}
                      </p>
                      {session.results.map((result) => (
                        <div className="discovery-result" key={result.id}>
                          <a href={result.url} target="_blank" rel="noreferrer">
                            {result.title}
                            <ArrowUpRight size={12} />
                          </a>
                          <span>
                            {result.status === "unread" ? "Not inspected" : result.status}
                          </span>
                          {result.error ? <p role="status">{result.error}</p> : null}
                        </div>
                      ))}
                    </details>
                    {session.error || session.run.error ? (
                      <p className="discovery-session-error">
                        {session.error ?? session.run.error}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setRunId(session.run.id)}
                    >
                      Open run & review <ArrowRight size={13} />
                    </button>
                  </article>
                ))}
                {center.counts.runs > center.sessions.length ? (
                  <p className="discovery-list-note">
                    Showing the latest 40 discovery runs. Older runs remain in the Agent center.
                  </p>
                ) : null}
              </>
            ) : (
              <DiscoveryEmpty active={false} side={side} kind="history" />
            )}
          </div>
          <div className="discovery-inbox-footer">
            <Check size={14} />
            <span>Original pages retained. Unknown details stay unknown.</span>
          </div>
        </section>
      </div>
      {runId ? (
        <AgentRunDetailView
          id={runId}
          onClose={() => {
            setRunId(null);
            refresh();
          }}
          onChanged={refresh}
        />
      ) : null}
      {leadId && center ? (
        <LeadWorkspace
          id={leadId}
          providers={center.providers}
          onChanged={refresh}
          onClose={() => {
            setLeadId(null);
            router.replace("/discovery", { scroll: false });
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
function DiscoveryEmpty({
  active,
  side,
  kind,
}: {
  active: boolean;
  side: DiscoveryInput["side"];
  kind: InboxTab;
}) {
  return (
    <div className="discovery-empty">
      <div className="discovery-empty-symbol">
        {active ? <LoaderCircle size={29} className="spin" /> : <Radar size={33} strokeWidth={1} />}
      </div>
      <span className="eyebrow">YOUR NEXT OPPORTUNITY STARTS WITH EVIDENCE</span>
      <h3>
        {active
          ? "Your agents are researching."
          : kind === "saved"
            ? "A considered pipeline starts here."
            : kind === "history"
              ? "Your research trail, kept intact."
              : "Turn public signals into leads."}
      </h3>
      <p>
        {active
          ? "Pages and proposals will appear here as the run progresses. You can follow its activity in Search history."
          : kind === "saved"
            ? "Review a candidate and accept its evidence to save your first lead."
            : kind === "history"
              ? "Start a run to keep a record of the query, public results and pages your agent inspected."
              : `Start a ${side.toLowerCase()} search or inspect public URLs. Your agent will bring back relevant candidates with the original passages.`}
      </p>
      <div className="discovery-empty-flow">
        <span>01 / Discover</span>
        <ArrowRight size={12} />
        <span>02 / Review</span>
        <ArrowRight size={12} />
        <span>03 / Qualify</span>
      </div>
    </div>
  );
}
function LeadCard({
  values: v,
  url,
  sourceId,
  citations,
  saved,
  onReview,
  onWork,
}: {
  values: LeadValues;
  url: string;
  sourceId: string;
  citations: Citation[];
  saved: boolean;
  onReview: () => void;
  onWork?: () => void;
}) {
  const researchTarget = ["Fleet activity", "Business profile"].includes(v.basis);
  return (
    <article className="discovery-lead">
      <div className="discovery-lead-top">
        <span>
          {v.side === "Buyer" ? <UsersRound size={13} /> : <Plane size={13} />}
          {v.side} side
        </span>
        <Badge tone={saved ? "green" : "orange"}>{saved ? "Saved lead" : "Awaiting review"}</Badge>
      </div>
      <h3>{v.organization ?? v.aircraftModel}</h3>
      <div className="discovery-lead-basis">
        {v.basis}
        {researchTarget ? <span>Research target</span> : null}
      </div>
      <p className="discovery-lead-summary">
        <span>Agent assessment</span>
        {v.summary}
      </p>
      <dl className="discovery-lead-facts">
        <div>
          <dt>Aircraft</dt>
          <dd>{v.aircraftModel ?? "Not stated"}</dd>
        </div>
        <div>
          <dt>Geography</dt>
          <dd>{v.geography ?? "Not stated"}</dd>
        </div>
        <div className="discovery-lead-contact">
          <dt>Published business contact</dt>
          <dd>{[v.contactName, v.email, v.phone].filter(Boolean).join(" · ") || "Not stated"}</dd>
        </div>
      </dl>
      <details className="discovery-lead-evidence">
        <summary>
          Read retained evidence{" "}
          <span>
            {citations.length} passage{citations.length === 1 ? "" : "s"}
          </span>
        </summary>
        {citations.map((citation) => (
          <blockquote key={`${citation.sourceId}:${citation.page}:${citation.quote}`}>
            {citation.quote}
          </blockquote>
        ))}
        <a href={`/api/sources/${sourceId}/document`} target="_blank" rel="noreferrer">
          Retained original <ArrowUpRight size={12} />
        </a>
      </details>
      <div className="discovery-lead-actions">
        <a href={url} target="_blank" rel="noreferrer">
          <Globe2 size={12} />
          {new URL(url).hostname}
          <ArrowUpRight size={11} />
        </a>
        <button type="button" className="text-link" onClick={onReview}>
          {saved ? "Review history" : "Review candidate"}
          <ArrowRight size={13} />
        </button>
        {onWork ? (
          <button type="button" className="button button-secondary" onClick={onWork}>
            Work this lead <ArrowRight size={13} />
          </button>
        ) : null}
      </div>
    </article>
  );
}
