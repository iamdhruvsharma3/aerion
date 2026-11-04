"use client";

import { useState } from "react";
import { Bookmark, CalendarDays, Download, FileText, MapPin, ShieldCheck } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { AircraftArt } from "./aircraft-art";
import { Badge, Modal } from "./ui";
import { dateLabel, downloadText, number } from "@/lib/format";
import { aircraftTerms } from "@/lib/sourcing";
import { evaluateMatch } from "@/lib/matching";
import type { Aircraft } from "@/lib/schema";

export function AircraftDetail({ aircraft, onClose }: { aircraft: Aircraft; onClose: () => void }) {
  const { data, dispatch } = useWorkspace();
  const [tab, setTab] = useState("Overview");
  const saved = data.saved.includes(aircraft.id);
  const facts = [
    ["Manufacture year", aircraft.year],
    ["Registration", aircraft.registration],
    ["Engine type", aircraft.engine],
    ["Flight hours", number(aircraft.hours)],
    ["Flight cycles", number(aircraft.cycles)],
    ["Offering", aircraft.offering ?? "Sale"],
    ["Available from", dateLabel(aircraft.availableDate)],
  ];
  const note = `SOURCING NOTE — ${aircraft.manufacturer} ${aircraft.model}\n\nSerial: ${aircraft.serial}\nYear: ${aircraft.year}\nLocation: ${aircraft.location}, ${aircraft.country}\nEngine: ${aircraft.engine}\nFlight hours: ${number(aircraft.hours)}\nFlight cycles: ${number(aircraft.cycles)}\nCommercial terms: ${aircraftTerms(aircraft)}\nAvailability: ${aircraft.availability} — ${dateLabel(aircraft.availableDate)}\n\nSource: ${aircraft.source}\nSource date: ${aircraft.sourceDate}\nNotes: ${aircraft.notes}\n\nReview current availability, source authority, technical records and configuration before sharing. This is a structured record summary, not a technical assessment.`;
  return (
    <Modal
      title={`${aircraft.manufacturer} ${aircraft.model}`}
      description={`${aircraft.year} · ${aircraft.serial} · ${aircraft.category} aircraft`}
      onClose={onClose}
      wide
    >
      <div className="detail-art">
        <AircraftArt business={aircraft.category === "Business"} />
        <Badge tone={aircraft.availability === "Confirmed" ? "green" : "orange"}>
          {aircraft.availability}
        </Badge>
        <span>Illustrative aircraft artwork</span>
      </div>
      <div className="detail-summary">
        <div>
          <span className="eyebrow muted">INDICATIVE COMMERCIAL TERMS</span>
          <strong>{aircraftTerms(aircraft)}</strong>
        </div>
        <div>
          <MapPin size={15} />
          <span>
            {aircraft.location}, {aircraft.country}
          </span>
        </div>
        <button
          type="button"
          className={`button button-secondary ${saved ? "selected-button" : ""}`}
          aria-pressed={saved}
          onClick={() => dispatch({ type: "save-aircraft", id: aircraft.id })}
        >
          <Bookmark size={15} fill={saved ? "currentColor" : "none"} />
          {saved ? "Saved aircraft" : "Save aircraft"}
        </button>
      </div>
      <div className="tabs detail-tabs">
        {["Overview", "Source record", "Buyer matches"].map((item) => (
          <button
            type="button"
            key={item}
            className={tab === item ? "active" : ""}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="detail-content">
        {tab === "Overview" ? (
          <>
            <div className="detail-facts">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="detail-note">
              <FileText size={17} />
              <div>
                <strong>Aircraft notes</strong>
                <p>{aircraft.notes || "No additional notes supplied."}</p>
              </div>
            </div>
          </>
        ) : tab === "Source record" ? (
          <>
            <div className="source-record">
              <span className="source-file">
                <FileText size={25} />
              </span>
              <div>
                <strong>{aircraft.source}</strong>
                <p>Structured source record · {dateLabel(aircraft.sourceDate)}</p>
              </div>
              <Badge>Reported data</Badge>
            </div>
            <p className="source-explanation">
              {aircraft.evidence
                ? "This record was published through the source review queue. The original document and field observations remain linked to the review. Source claims still require independent confirmation."
                : "These are the values supplied with this earlier aircraft record. Upload its original source through the source library to build a document-backed review."}
            </p>
            {aircraft.evidence ? (
              <div className="aircraft-evidence-links">
                <a
                  className="button button-secondary"
                  href={`/api/sources/${aircraft.evidence.sourceId}/document`}
                >
                  <Download size={15} />
                  Download original source
                </a>
                <p>
                  Review reference: <code>{aircraft.evidence.reviewId}</code>
                </p>
                <a href={`/sources?review=${aircraft.evidence.reviewId}`}>Open evidence review</a>
              </div>
            ) : null}
            <pre className="record-preview">
              {JSON.stringify(
                {
                  manufacturer: aircraft.manufacturer,
                  model: aircraft.model,
                  serial: aircraft.serial,
                  engine: aircraft.engine,
                  flightHours: aircraft.hours,
                  flightCycles: aircraft.cycles,
                  askingPriceUSD: aircraft.price,
                  offering: aircraft.offering ?? "Sale",
                  leaseRate: aircraft.leaseRate ?? null,
                  leaseCurrency: aircraft.leaseCurrency ?? null,
                  leaseBasis: aircraft.leaseBasis ?? null,
                  availabilityDate: aircraft.availableDate,
                },
                null,
                2,
              )}
            </pre>
          </>
        ) : (
          <div className="detail-match-list">
            {data.requirements.map((requirement) => {
              const match = evaluateMatch(aircraft, requirement);
              return (
                <div key={requirement.id}>
                  <div>
                    <strong>{requirement.client}</strong>
                    <span>
                      {requirement.aircraftModel} · {requirement.quantity} aircraft
                    </span>
                  </div>
                  <Badge
                    tone={
                      match.state === "eligible"
                        ? "green"
                        : match.state === "excluded"
                          ? "neutral"
                          : "orange"
                    }
                  >
                    {match.state === "eligible"
                      ? `${match.score} fit score`
                      : match.state === "excluded"
                        ? "Outside constraints"
                        : "Needs review"}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="detail-footer">
        <span>
          <ShieldCheck size={15} />
          Source-aware. Ready for your review.
        </span>
        <button
          type="button"
          className="button button-primary"
          onClick={() => downloadText(`aerion-${aircraft.serial}-note.txt`, note)}
        >
          <Download size={15} />
          Export sourcing note
        </button>
      </div>
      <div className="detail-disclaimer">
        <CalendarDays size={13} />
        Availability and pricing are dated observations, subject to confirmation.
      </div>
    </Modal>
  );
}
