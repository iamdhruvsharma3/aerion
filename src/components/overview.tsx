"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  CircleDot,
  Crosshair,
  Layers3,
  Plane,
  Plus,
  UsersRound,
  Workflow,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { aircraftTerms } from "@/lib/sourcing";
import { InventoryMap } from "./inventory-map";
import { Badge, SectionHeading } from "./ui";
import { getMatches } from "@/lib/matching";
import type { Aircraft } from "@/lib/schema";

export function Overview({
  onAircraft,
  onImport,
  onRequirement,
}: {
  onAircraft: (item: Aircraft) => void;
  onImport: () => void;
  onRequirement: () => void;
}) {
  const { data, dispatch } = useWorkspace();
  const router = useRouter();
  const matches = getMatches(data.aircraft, data.requirements).filter(
    (match) => match.state === "eligible",
  );
  const stats = [
    {
      label: "Aircraft in inventory",
      value: data.aircraft.length,
      note: `${data.aircraft.filter((a) => a.category === "Commercial").length} commercial · ${data.aircraft.filter((a) => a.category === "Business").length} business`,
      icon: Plane,
      href: "/aircraft",
      color: "orange",
    },
    {
      label: "Buyer requirements",
      value: data.requirements.length,
      note: `${data.requirements.filter((r) => r.status !== "Draft").length} confirmed or sourcing`,
      icon: UsersRound,
      href: "/requirements",
      color: "blue",
    },
    {
      label: "Qualified matches",
      value: matches.length,
      note: "Known sourcing constraints met",
      icon: Crosshair,
      href: "/matches",
      color: "green",
    },
    {
      label: "Active opportunities",
      value: data.deals.length,
      note: "Across your deal pipeline",
      icon: Workflow,
      href: "/deals",
      color: "neutral",
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">YOUR DAILY FLIGHT PLAN</div>
          <h1>
            Good morning, Dhruv<span className="orange-text">.</span>
          </h1>
          <p>A little clarity. A lot of possibility. Here’s your workspace today.</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="button button-secondary" onClick={onImport}>
            <Plus size={16} />
            Import aircraft
          </button>
          <button type="button" className="button button-primary" onClick={onRequirement}>
            <Plus size={16} />
            New requirement
          </button>
        </div>
      </div>
      <div className="stat-grid">
        {stats.map((stat) => (
          <Link className="stat-card" key={stat.label} href={stat.href}>
            <div className="stat-top">
              <span>{stat.label}</span>
              <stat.icon size={18} className={`stat-icon ${stat.color}`} />
            </div>
            <div className="stat-value">
              {String(stat.value).padStart(2, "0")}
              <ArrowUpRight size={19} />
            </div>
            <div className="stat-note">
              <span className={`tiny-dot ${stat.color}`} />
              {stat.note}
            </div>
          </Link>
        ))}
      </div>
      <div className="overview-main">
        <InventoryMap
          aircraft={data.aircraft}
          onExplore={() => {
            router.push("/aircraft");
          }}
        />
        <section className="panel attention-panel">
          <SectionHeading
            title="Needs your attention"
            action={
              <span className="count-tag">{data.tasks.filter((task) => !task.done).length}</span>
            }
          />
          <div className="task-list">
            {data.tasks.map((task) => (
              <div className={`task-row ${task.done ? "task-complete" : ""}`} key={task.id}>
                <button
                  type="button"
                  className="task-check"
                  aria-label={`${task.done ? "Reopen" : "Complete"} ${task.title}`}
                  aria-pressed={task.done}
                  onClick={() => dispatch({ type: "toggle-task", id: task.id })}
                >
                  {task.done ? <Check size={12} /> : null}
                </button>
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.detail}</p>
                  <span className={`task-priority ${task.priority.toLowerCase()}`}>
                    <span className="tiny-dot" />
                    {task.done ? "Completed" : `${task.priority} priority`}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="attention-footer">
            <CircleDot size={14} />
            Small actions. Better momentum.
          </div>
        </section>
      </div>
      <div className="overview-bottom">
        <section className="panel">
          <SectionHeading
            title="Recently added aircraft"
            subtitle="A closer look at your latest inventory."
            action={
              <Link className="text-link" href="/aircraft">
                View all <ArrowUpRight size={15} />
              </Link>
            }
          />
          <div className="recent-aircraft">
            {data.aircraft.slice(0, 4).map((aircraft) => (
              <button
                type="button"
                className="recent-row"
                key={aircraft.id}
                onClick={() => onAircraft(aircraft)}
              >
                <span
                  className={`plane-avatar ${aircraft.category === "Business" ? "avatar-blue" : ""}`}
                >
                  <Plane size={21} />
                </span>
                <div className="recent-title">
                  <strong>
                    {aircraft.manufacturer} {aircraft.model}
                  </strong>
                  <span>
                    {aircraft.year} <span>·</span> {aircraft.serial}
                  </span>
                </div>
                <div className="recent-location">
                  {aircraft.location}
                  <span>{aircraft.country}</span>
                </div>
                <div className="recent-price">
                  {aircraftTerms(aircraft)}
                  <span>Source-reported terms</span>
                </div>
                <Badge
                  tone={
                    aircraft.availability === "Confirmed"
                      ? "green"
                      : aircraft.availability === "Stale"
                        ? "orange"
                        : "neutral"
                  }
                >
                  {aircraft.availability}
                </Badge>
                <ArrowUpRight size={16} className="row-arrow" />
              </button>
            ))}
          </div>
        </section>
        <section className="panel activity-panel">
          <SectionHeading
            title="Workspace activity"
            action={<span className="subtle-label">DEMO</span>}
          />
          <div className="activity-list">
            <div className="activity-item">
              <span className="activity-icon orange">
                <Layers3 size={15} />
              </span>
              <div>
                <strong>Inventory ready to explore</strong>
                <p>{data.aircraft.length} aircraft with source information</p>
                <span>Workspace snapshot</span>
              </div>
            </div>
            <div className="activity-item">
              <span className="activity-icon green">
                <Crosshair size={15} />
              </span>
              <div>
                <strong>{matches.length} sourcing matches found</strong>
                <p>Based on your current buyer requirements</p>
                <span>Calculated from workspace data</span>
              </div>
            </div>
            <div className="activity-item">
              <span className="activity-icon blue">
                <UsersRound size={15} />
              </span>
              <div>
                <strong>Your network is taking shape</strong>
                <p>{data.contacts.length} contacts, all in one place</p>
                <span>Saved on this device</span>
              </div>
            </div>
          </div>
          <Link className="agent-prompt" href="/agents">
            <span className="agent-prompt-symbol">✳</span>
            <div>
              <strong>Put your agents to work</strong>
              <span>Run tasks and review the evidence</span>
            </div>
            <ArrowUpRight size={17} />
          </Link>
        </section>
      </div>
      <div className="page-footnote">
        <span className="tiny-dot green" /> Demo workspace · Fictional aircraft, organizations, and
        prices<span>Built for a clearer way forward.</span>
      </div>
    </>
  );
}
