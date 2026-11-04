"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  List,
  LayoutGrid,
  MapPin,
  Search,
  SlidersHorizontal,
  Plus,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { aircraftTerms } from "@/lib/sourcing";
import { AircraftArt } from "./aircraft-art";
import { Badge, EmptyState } from "./ui";
import { dateLabel, number } from "@/lib/format";
import type { Aircraft } from "@/lib/schema";

export function AircraftView({
  onAircraft,
  onImport,
}: {
  onAircraft: (aircraft: Aircraft) => void;
  onImport: () => void;
}) {
  const { data, dispatch } = useWorkspace();
  const [category, setCategory] = useState("All aircraft");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState("grid");
  const [savedOnly, setSavedOnly] = useState(false);
  const [sort, setSort] = useState("recent");
  const filtered = data.aircraft
    .filter(
      (a) =>
        (category === "All aircraft" || a.category === category) &&
        (!savedOnly || data.saved.includes(a.id)) &&
        `${a.manufacturer} ${a.model} ${a.serial} ${a.location} ${a.engine}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .toSorted((a, b) =>
      sort === "price"
        ? (a.price ?? Infinity) - (b.price ?? Infinity)
        : sort === "year"
          ? b.year - a.year
          : 0,
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">AIRCRAFT INTELLIGENCE</div>
          <h1>Your next opportunity.</h1>
          <p>Every aircraft, every detail. A more complete view of your inventory.</p>
        </div>
        <button type="button" className="button button-primary" onClick={onImport}>
          <Plus size={16} />
          Import aircraft
        </button>
      </div>
      <div className="view-toolbar">
        <fieldset className="tabs" aria-label="Aircraft market">
          {["All aircraft", "Commercial", "Business"].map((tab) => (
            <button
              type="button"
              className={category === tab ? "active" : ""}
              key={tab}
              aria-pressed={category === tab}
              onClick={() => setCategory(tab)}
            >
              {tab}
              <span>
                {tab === "All aircraft"
                  ? data.aircraft.length
                  : data.aircraft.filter((a) => a.category === tab).length}
              </span>
            </button>
          ))}
        </fieldset>
        <fieldset className="layout-toggle" aria-label="Inventory layout">
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
          >
            <List size={17} />
          </button>
        </fieldset>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search aircraft"
            placeholder="Search model, serial number, location…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`button button-secondary ${savedOnly ? "selected-button" : ""}`}
          aria-pressed={savedOnly}
          onClick={() => setSavedOnly(!savedOnly)}
        >
          <Bookmark size={15} />
          Saved aircraft
        </button>
        <label className="sort-control">
          <SlidersHorizontal size={15} />
          <select
            aria-label="Sort aircraft"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="recent">Recently added</option>
            <option value="price">Purchase price: low to high</option>
            <option value="year">Newest year</option>
          </select>
        </label>
      </div>
      <div className="results-label">
        {filtered.length} aircraft in view
        <span>Purchase and lease terms retain their stated units</span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title="No aircraft in this view"
          detail="Try another search or market filter, or bring in your first aircraft."
          action={
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setQuery("");
                setCategory("All aircraft");
                setSavedOnly(false);
              }}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className={`aircraft-grid ${layout === "list" ? "aircraft-list" : ""}`}>
          {filtered.map((aircraft) => (
            <article className="aircraft-card" key={aircraft.id}>
              <div className="aircraft-visual">
                <AircraftArt business={aircraft.category === "Business"} />
                <Badge tone={aircraft.category === "Commercial" ? "neutral" : "blue"}>
                  {aircraft.category}
                </Badge>
                <button
                  type="button"
                  className={`bookmark-button ${data.saved.includes(aircraft.id) ? "is-saved" : ""}`}
                  aria-label={`${data.saved.includes(aircraft.id) ? "Unsave" : "Save"} ${aircraft.manufacturer} ${aircraft.model}`}
                  aria-pressed={data.saved.includes(aircraft.id)}
                  onClick={() => dispatch({ type: "save-aircraft", id: aircraft.id })}
                >
                  <Bookmark
                    size={17}
                    fill={data.saved.includes(aircraft.id) ? "currentColor" : "none"}
                  />
                </button>
                <span className="visual-caption">ILLUSTRATION · DEMO AIRCRAFT</span>
              </div>
              <div className="aircraft-card-body">
                <div className="aircraft-card-title">
                  <div>
                    <span className="mono muted">
                      {aircraft.year} · {aircraft.serial}
                    </span>
                    <button type="button" onClick={() => onAircraft(aircraft)}>
                      <h2>
                        {aircraft.manufacturer} {aircraft.model}
                      </h2>
                    </button>
                  </div>
                  <ArrowUpRight size={18} />
                </div>
                <div className="aircraft-place">
                  <MapPin size={13} />
                  {aircraft.location}, {aircraft.country}
                </div>
                <div className="aircraft-specs">
                  <div>
                    <span>FLIGHT HOURS</span>
                    <strong>{number(aircraft.hours)}</strong>
                  </div>
                  <div>
                    <span>ENGINES</span>
                    <strong>{aircraft.engine}</strong>
                  </div>
                </div>
                <div className="aircraft-card-footer">
                  <div>
                    <strong>{aircraftTerms(aircraft)}</strong>
                    <span>{aircraft.offering ?? "Sale"}</span>
                  </div>
                  <button
                    type="button"
                    className="button button-small button-secondary"
                    onClick={() => onAircraft(aircraft)}
                  >
                    View aircraft <ArrowUpRight size={14} />
                  </button>
                </div>
                <div className="aircraft-availability">
                  <span
                    className={`tiny-dot ${aircraft.availability === "Stale" ? "orange" : "green"}`}
                  />
                  {aircraft.availability === "Stale"
                    ? "Availability needs refresh"
                    : `Available ${dateLabel(aircraft.availableDate)}`}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
