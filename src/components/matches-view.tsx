"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Crosshair,
  Download,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { AircraftArt } from "./aircraft-art";
import { Badge, EmptyState } from "./ui";
import { getMatches, type AircraftMatch } from "@/lib/matching";
import { dateLabel, downloadText } from "@/lib/format";
import { aircraftTerms, requirementTerms } from "@/lib/sourcing";
import type { Aircraft } from "@/lib/schema";

function candidateReport(matches: AircraftMatch[]) {
  return [
    "AERION — ELIGIBLE SOURCING CANDIDATES",
    "Prepared from workspace records. Review current availability and source claims before sharing.",
    ...matches.map(
      (match) =>
        `\n${match.requirement.client} — ${match.requirement.aircraftModel}\n${match.aircraft.manufacturer} ${match.aircraft.model} | ${match.aircraft.serial}\nAircraft terms: ${aircraftTerms(match.aircraft)}\nBuyer terms: ${requirementTerms(match.requirement)}\nSource: ${match.aircraft.source} (${match.aircraft.sourceDate})\n${match.checks.map((check) => `${check.result.toUpperCase()}: ${check.label} — ${check.detail}`).join("\n")}`,
    ),
  ].join("\n");
}

export function MatchesView({
  onAircraft,
  notify,
}: {
  onAircraft: (aircraft: Aircraft) => void;
  notify: (message: string) => void;
}) {
  const { data, dispatch } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get("requirement") ?? "all";
  const [showExcluded, setShowExcluded] = useState(false);
  const all = getMatches(data.aircraft, data.requirements).filter(
    (match) => selected === "all" || match.requirement.id === selected,
  );
  const matches = all.filter((match) => showExcluded || match.state !== "excluded");
  const eligible = all.filter((match) => match.state === "eligible");
  async function createOpportunity(match: AircraftMatch) {
    if (
      data.deals.some(
        (deal) =>
          deal.aircraftId === match.aircraft.id && deal.requirementId === match.requirement.id,
      )
    ) {
      notify("This match is already in your deal room");
      return;
    }
    const saved = await dispatch({
      type: "deal",
      item: {
        id: crypto.randomUUID(),
        title: `${match.requirement.client} · ${match.aircraft.model}`,
        aircraftId: match.aircraft.id,
        requirementId: match.requirement.id,
        stage: "Sourcing",
        nextAction: "Confirm availability and request source documents",
        dueDate: new Date().toISOString().slice(0, 10),
      },
    });
    if (saved) notify("Opportunity added to the deal room");
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">INTELLIGENT MATCHING</div>
          <h1>Make the right connection.</h1>
          <p>Transparent sourcing rules. Clear reasons. Every unknown stays visible.</p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={eligible.length === 0}
          onClick={() => downloadText("aerion-candidates.txt", candidateReport(eligible))}
        >
          <Download size={16} />
          Export candidates
        </button>
      </div>
      <div className="match-summary">
        <span className="match-summary-icon">
          <Crosshair size={24} />
        </span>
        <div>
          <strong>{eligible.length} candidates meet known sourcing constraints</strong>
          <p>
            Fit scores rank preferences. Technical suitability and current availability need review.
          </p>
        </div>
        <Badge tone="green">Rules evaluated</Badge>
      </div>
      <div className="filter-bar match-filters">
        <label className="sort-control">
          <SlidersHorizontal size={16} />
          <select
            aria-label="Filter matches by requirement"
            value={selected}
            onChange={(event) =>
              router.replace(
                event.target.value === "all"
                  ? "/matches"
                  : `/matches?requirement=${encodeURIComponent(event.target.value)}`,
                { scroll: false },
              )
            }
          >
            <option value="all">All buyer requirements</option>
            {data.requirements.map((requirement) => (
              <option key={requirement.id} value={requirement.id}>
                {requirement.client} · {requirement.aircraftModel}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="toggle-label"
          aria-pressed={showExcluded}
          onClick={() => setShowExcluded(!showExcluded)}
        >
          <span className={`switch ${showExcluded ? "on" : ""}`} />
          Show excluded candidates
        </button>
      </div>
      <div className="matches-list">
        {matches.map((match) => (
          <article className="match-card" key={`${match.aircraft.id}:${match.requirement.id}`}>
            <div className="match-card-main">
              <div className="match-plane">
                <AircraftArt business={match.aircraft.category === "Business"} compact />
              </div>
              <div className="match-identity">
                <span className="eyebrow muted">
                  {match.aircraft.year} · {match.aircraft.serial}
                </span>
                <button type="button" onClick={() => onAircraft(match.aircraft)}>
                  <h2>
                    {match.aircraft.manufacturer} {match.aircraft.model}
                    <ArrowUpRight size={17} />
                  </h2>
                </button>
                <span>
                  {match.aircraft.location} · {aircraftTerms(match.aircraft)}
                </span>
              </div>
              <ArrowRight className="match-direction" size={19} />
              <div className="match-buyer">
                <span className="eyebrow muted">BUYER REQUIREMENT</span>
                <strong>{match.requirement.client}</strong>
                <span>
                  {match.requirement.quantity} × {match.requirement.aircraftModel}
                </span>
              </div>
              <div className={`match-score ${match.state}`}>
                <strong>{match.score ?? (match.state === "excluded" ? "—" : "?")}</strong>
                <span>
                  {match.state === "eligible"
                    ? "FIT SCORE / 100"
                    : match.state === "excluded"
                      ? "EXCLUDED"
                      : "NEEDS REVIEW"}
                </span>
              </div>
            </div>
            <div className="match-checks">
              {match.checks.map((check) => (
                <span
                  className={`match-check ${check.result}`}
                  key={check.label}
                  title={check.detail}
                >
                  {check.result === "pass" ? (
                    <Check size={13} />
                  ) : check.result === "fail" ? (
                    <X size={13} />
                  ) : (
                    <CircleHelp size={13} />
                  )}
                  {check.label}
                </span>
              ))}
            </div>
            <div className="match-footer">
              <span>
                Source: {match.aircraft.source} · {dateLabel(match.aircraft.sourceDate)}
              </span>
              <Link
                className="text-link"
                href={`/execution?requirement=${encodeURIComponent(match.requirement.id)}`}
              >
                Open execution desk <ArrowUpRight size={15} />
              </Link>
              <button
                type="button"
                className="text-link"
                onClick={() => createOpportunity(match)}
                disabled={match.state !== "eligible"}
              >
                Add to deal room <ArrowUpRight size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {matches.length === 0 ? (
        <EmptyState
          title="No candidates in this view"
          detail="Add aircraft or update the requirement filter. You can also show excluded candidates to inspect the reasons."
        />
      ) : null}
    </>
  );
}
