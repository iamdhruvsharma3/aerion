"use client";

import { ArrowUpRight, Globe2 } from "lucide-react";
import type { Aircraft } from "@/lib/schema";

export function InventoryMap({
  aircraft,
  onExplore,
}: {
  aircraft: Aircraft[];
  onExplore: () => void;
}) {
  const locations = new Set(aircraft.map((item) => item.location)).size;
  return (
    <section className="inventory-map">
      <div className="map-copy">
        <span className="eyebrow">
          <span className="live-dot" /> OPPORTUNITY RADAR
        </span>
        <h2>
          A world of possibility.
          <br />
          <span>A clearer perspective.</span>
        </h2>
        <p>
          Your aircraft intelligence,
          <br />
          connected in one place.
        </p>
        <button type="button" className="map-explore" onClick={onExplore}>
          Explore inventory <ArrowUpRight size={16} />
        </button>
        <div className="map-meta">
          <Globe2 size={13} />
          <span>{locations} locations</span>
          <span className="map-divider" />
          <span>{aircraft.length} aircraft in view</span>
        </div>
      </div>
      <svg
        className="world-map"
        viewBox="0 0 650 350"
        role="img"
        aria-label="Illustrative world map showing the demo inventory across Europe, the Middle East and Asia"
      >
        <defs>
          <pattern id="map-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="12" cy="12" r=".6" fill="#a3b9b4" opacity=".2" />
          </pattern>
        </defs>
        <rect width="650" height="350" fill="url(#map-grid)" />
        <g fill="#45605e" stroke="#6c8481" strokeWidth=".5" opacity=".65">
          <path d="M56 74L89 48L138 47L167 62L183 90L161 110L147 137L120 145L103 166L89 145L86 119L61 112L45 91Z" />
          <path d="M145 158L171 163L193 194L188 221L169 242L153 275L138 258L135 227L123 200L130 177Z" />
          <path d="M174 32L196 21L221 32L210 63L187 68L174 49Z" />
          <path d="M292 67L314 51L351 59L370 46L409 49L432 64L467 56L504 70L543 69L574 91L567 113L536 120L515 141L495 155L478 177L452 180L434 155L416 138L395 148L380 132L358 115L338 119L319 104L299 102L284 88Z" />
          <path d="M299 118L331 112L355 137L361 169L345 190L332 221L312 218L301 191L285 161L283 138Z" />
          <path d="M370 125L390 133L404 150L392 168L372 159Z" />
          <path d="M443 189L467 191L477 208L503 210L518 226L499 230L475 220L454 217Z" />
          <path d="M506 242L538 225L565 233L581 263L565 283L529 280L510 264Z" />
          <path d="M576 294L588 281L598 282L590 302Z" />
          <path d="M278 63L282 48L290 48L293 66Z" />
          <path d="M330 224L342 207L347 216L342 237Z" />
        </g>
        <g fill="none" stroke="#e98b60" strokeWidth="1.2" strokeDasharray="4 5" opacity=".7">
          <path d="M308 93Q353 47 396 146" />
          <path d="M308 93Q415 41 490 201" />
          <path d="M396 146Q437 141 490 201" />
        </g>
        <g>
          <circle cx="308" cy="93" r="14" fill="#eb9368" opacity=".12" />
          <circle cx="308" cy="93" r="5" fill="#f4a17c" stroke="#203d3d" strokeWidth="2" />
          <circle cx="396" cy="146" r="12" fill="#eb9368" opacity=".12" />
          <circle cx="396" cy="146" r="4.5" fill="#f4a17c" stroke="#203d3d" strokeWidth="2" />
          <circle cx="490" cy="201" r="11" fill="#eb9368" opacity=".12" />
          <circle cx="490" cy="201" r="4" fill="#f4a17c" stroke="#203d3d" strokeWidth="2" />
        </g>
        <g fill="#c1d0ca" fontSize="10" fontFamily="monospace">
          <text x="300" y="76">
            EUROPE
          </text>
          <text x="408" y="148">
            UAE
          </text>
          <text x="502" y="205">
            SINGAPORE
          </text>
        </g>
      </svg>
      <span className="map-note">ILLUSTRATIVE INVENTORY VIEW</span>
    </section>
  );
}
