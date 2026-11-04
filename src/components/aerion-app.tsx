"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ClipboardList,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Crosshair,
  Database,
  FlaskConical,
  LayoutDashboard,
  Mail,
  Banknote,
  Activity,
  Menu,
  PanelLeftClose,
  Plane,
  Radar,
  Search,
  Settings2,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { Modal } from "./ui";
import { Overview } from "./overview";
import { AircraftView } from "./aircraft-view";
import { RequirementsView } from "./requirements-view";
import { MatchesView } from "./matches-view";
import { ContactsView, DealsView } from "./operations-views";
import { AgentsView } from "./agents-view";
import { IntelligenceView } from "./intelligence-view";
import { ExecutionView } from "./execution-view";
import { SourcesView } from "./sources-view";
import { WorkspaceSettings } from "./workspace-settings";
import { AircraftDetail } from "./aircraft-detail";
import { ContactModal, ImportModal, RequirementModal } from "./forms";
import type { Aircraft } from "@/lib/schema";
import { api } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import type { ExecutionAttention } from "@/lib/execution/schema";
const DiscoveryView = dynamic(
  () => import("./discovery-view").then((module) => module.DiscoveryView),
  { loading: () => <p>Opening lead discovery…</p> },
);
const CommunicationInbox = dynamic(
  () => import("./communication-inbox").then((module) => module.CommunicationInbox),
  { loading: () => <p>Opening communications…</p> },
);
const RevenueView = dynamic(() => import("./revenue-view").then((module) => module.RevenueView), {
  loading: () => <p>Opening client engagements and revenue…</p>,
});
const OperationsView = dynamic(
  () => import("./operations-status").then((module) => module.OperationsView),
  { loading: () => <p>Reading current operating state…</p> },
);

const navigation = [
  { id: "overview", name: "Overview", href: "/", icon: LayoutDashboard },
  { id: "aircraft", name: "Aircraft inventory", href: "/aircraft", icon: Plane },
  { id: "requirements", name: "Buyer requirements", href: "/requirements", icon: UsersRound },
  { id: "matches", name: "Aircraft matches", href: "/matches", icon: Crosshair },
  { id: "execution", name: "Execution desk", href: "/execution", icon: ClipboardList },
  { id: "deals", name: "Deal room", href: "/deals", icon: Workflow },
  { id: "revenue", name: "Engagements & revenue", href: "/revenue", icon: Banknote },
  { id: "communication", name: "Communications", href: "/communication", icon: Mail },
  { id: "contacts", name: "Contacts", href: "/contacts", icon: UsersRound },
  { id: "discovery", name: "Lead discovery", href: "/discovery", icon: Search },
  { id: "intelligence", name: "Market intelligence", href: "/intelligence", icon: Radar },
  { id: "agents", name: "Agent center", href: "/agents", icon: Bot },
  { id: "sources", name: "Source library", href: "/sources", icon: Database },
  { id: "operations", name: "Operations", href: "/operations", icon: Activity },
] as const;
export type View = (typeof navigation)[number]["id"];

function Logo() {
  return (
    <span className="brand">
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M4 25L16 4L28 25H20L16 17L12 25H4Z" fill="currentColor" />
        <path d="M12 28L16 21L20 28H12Z" fill="currentColor" opacity=".4" />
      </svg>
      <span>
        aerion<span className="brand-period">.</span>
      </span>
    </span>
  );
}

export function AerionApp({ view }: { view: View }) {
  const { data, storageError, saving, session } = useWorkspace();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modal, setModal] = useState<
    "import" | "requirement" | "contact" | "search" | "notifications" | "settings" | null
  >(null);
  const [aircraft, setAircraft] = useState<Aircraft | null>(null);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [attention, setAttention] = useState<ExecutionAttention | null>(null);
  const [attentionError, setAttentionError] = useState("");
  const attentionOpen = modal === "notifications";
  useEffect(() => {
    const controller = new AbortController();
    function update() {
      api<ExecutionAttention>("/api/execution", { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) {
            setAttention(value);
            setAttentionError("");
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setAttentionError(
              error instanceof Error ? error.message : "Due actions could not be loaded.",
            );
        });
    }
    update();
    window.addEventListener("focus", update);
    window.addEventListener("aerion-execution-updated", update);
    return () => {
      controller.abort();
      window.removeEventListener("focus", update);
      window.removeEventListener("aerion-execution-updated", update);
    };
  }, []);
  useEffect(() => {
    if (attentionOpen) window.dispatchEvent(new Event("aerion-execution-updated"));
  }, [attentionOpen]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setModal("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const title = navigation.find((item) => item.id === view)?.name ?? "Overview";
  const query = search.toLowerCase();
  const searchAircraft = data.aircraft
    .filter((item) =>
      `${item.manufacturer} ${item.model} ${item.serial}`.toLowerCase().includes(query),
    )
    .slice(0, 5);
  const searchRequirements = data.requirements
    .filter((item) => `${item.client} ${item.aircraftModel}`.toLowerCase().includes(query))
    .slice(0, 3);
  function closeSearch() {
    setModal(null);
    setSearch("");
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside id="workspace-sidebar" className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <Link href="/" aria-label="Aerion home">
            <Logo />
          </Link>
          <button
            type="button"
            className="mobile-close icon-button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <PanelLeftClose size={19} />
          </button>
        </div>
        <button type="button" className="workspace-switch" onClick={() => setModal("settings")}>
          <span className="workspace-icon">A</span>
          <span>
            <strong>Aerion workspace</strong>
            <small>
              {session?.mode === "local" ? "Local operating workspace" : "Private workspace"}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-group-label">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {navigation.slice(0, 7).map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`nav-item ${view === item.id ? "nav-active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={18} />
              <span>{item.name}</span>
              {item.id === "aircraft" ? (
                <span className="nav-count">{data.aircraft.length}</span>
              ) : item.id === "matches" ? (
                <span className="nav-dot" />
              ) : null}
            </Link>
          ))}
          <div className="nav-group-label intelligence-label">INTELLIGENCE</div>
          {navigation.slice(7).map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`nav-item ${view === item.id ? "nav-active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={18} />
              <span>{item.name}</span>
              {item.id === "agents" ? <span className="nav-new">12</span> : null}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-symbol">✳</span>
            <strong>A clearer way forward.</strong>
            <p>
              Built for the people who
              <br />
              connect the world.
            </p>
            <Link href="/agents">
              Explore Aerion agents <ArrowRight size={14} />
            </Link>
          </div>
          <button
            type="button"
            className="nav-item settings-link"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={18} />
            <span>Workspace settings</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">DS</span>
            <div>
              <strong>Dhruv Sharma</strong>
              <span>Founder workspace</span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Open workspace settings"
              onClick={() => setModal("settings")}
            >
              <ChevronDown size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-expanded={mobileOpen}
              aria-controls="workspace-sidebar"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="global-search-button"
              aria-label="Search workspace"
              onClick={() => setModal("search")}
            >
              <Search size={16} />
              <span>Search anything…</span>
              <kbd>
                <Command size={11} />K
              </kbd>
            </button>
            <span className="demo-chip">
              <FlaskConical size={12} />
              {saving
                ? "Saving…"
                : session?.mode === "local"
                  ? "Local database"
                  : "Private workspace"}
            </span>
            <span className="topbar-divider" />
            <button
              type="button"
              className="icon-button notification-button"
              aria-label="View attention items"
              onClick={() => setModal("notifications")}
            >
              <Bell size={18} />
              {data.tasks.some((task) => !task.done) || attention?.total ? <span /> : null}
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {storageError ? (
            <div className="storage-notice" role="alert">
              {storageError}
            </div>
          ) : null}
          {view === "overview" ? (
            <Overview
              onAircraft={setAircraft}
              onImport={() => setModal("import")}
              onRequirement={() => setModal("requirement")}
            />
          ) : view === "aircraft" ? (
            <AircraftView onAircraft={setAircraft} onImport={() => setModal("import")} />
          ) : view === "requirements" ? (
            <RequirementsView onCreate={() => setModal("requirement")} />
          ) : view === "matches" ? (
            <Suspense fallback={<p>Preparing your matches…</p>}>
              <MatchesView onAircraft={setAircraft} notify={setToast} />
            </Suspense>
          ) : view === "execution" ? (
            <Suspense fallback={<p>Opening the execution desk…</p>}>
              <ExecutionView />
            </Suspense>
          ) : view === "deals" ? (
            <DealsView notify={setToast} />
          ) : view === "contacts" ? (
            <ContactsView onCreate={() => setModal("contact")} />
          ) : view === "communication" ? (
            <Suspense fallback={<p>Opening communications…</p>}>
              <CommunicationInbox />
            </Suspense>
          ) : view === "revenue" ? (
            <Suspense fallback={<p>Opening engagements and revenue…</p>}>
              <RevenueView />
            </Suspense>
          ) : view === "operations" ? (
            <OperationsView />
          ) : view === "discovery" ? (
            <Suspense fallback={<p>Opening lead discovery…</p>}>
              <DiscoveryView />
            </Suspense>
          ) : view === "intelligence" ? (
            <Suspense fallback={<p>Preparing your intelligence desk…</p>}>
              <IntelligenceView />
            </Suspense>
          ) : view === "agents" ? (
            <AgentsView />
          ) : (
            <SourcesView onAircraft={setAircraft} onImport={() => setModal("import")} />
          )}
        </main>
      </div>
      {aircraft ? <AircraftDetail aircraft={aircraft} onClose={() => setAircraft(null)} /> : null}
      {modal === "import" ? (
        <ImportModal onClose={() => setModal(null)} onSuccess={setToast} />
      ) : modal === "requirement" ? (
        <RequirementModal onClose={() => setModal(null)} onSuccess={setToast} />
      ) : modal === "contact" ? (
        <ContactModal onClose={() => setModal(null)} onSuccess={setToast} />
      ) : modal === "search" ? (
        <Modal
          title="Find your next move"
          description="Search aircraft, buyer requirements, and workspace pages."
          onClose={closeSearch}
        >
          <div className="command-search">
            <Search size={18} />
            <input
              aria-label="Search workspace"
              placeholder="Aircraft, serial number, buyer…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="command-results">
            <span className="eyebrow muted">AIRCRAFT</span>
            {searchAircraft.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  closeSearch();
                  setAircraft(item);
                }}
              >
                <Plane size={17} />
                <span>
                  {item.manufacturer} {item.model}
                  <small>{item.serial}</small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
            {searchRequirements.length > 0 ? (
              <span className="eyebrow muted">BUYER REQUIREMENTS</span>
            ) : null}
            {searchRequirements.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  closeSearch();
                  router.push(`/matches?requirement=${encodeURIComponent(item.id)}`);
                }}
              >
                <UsersRound size={17} />
                <span>
                  {item.client}
                  <small>{item.aircraftModel}</small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
            {!search ? (
              <>
                <span className="eyebrow muted">QUICK NAVIGATION</span>
                {navigation.slice(0, 3).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      closeSearch();
                      router.push(item.href);
                    }}
                  >
                    <item.icon size={17} />
                    <span>{item.name}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </>
            ) : null}
            {search && searchAircraft.length + searchRequirements.length === 0 ? (
              <p className="no-results">
                No records match “{search}”. Try a model or organization name.
              </p>
            ) : null}
          </div>
        </Modal>
      ) : modal === "notifications" ? (
        <Modal
          title="Your attention, well placed"
          description="A few small actions to keep things moving."
          onClose={() => setModal(null)}
        >
          <div className="notification-list">
            {attentionError ? (
              <p role="alert" className="form-error">
                {attentionError}
              </p>
            ) : null}
            {!attention && !attentionError ? <p role="status">Loading due follow-ups…</p> : null}
            {attention?.items.map((item) => (
              <Link
                className="execution-notification"
                key={item.id}
                href={`/execution?requirement=${encodeURIComponent(item.requirementId)}&tab=actions`}
                onClick={() => setModal(null)}
              >
                <span className="notification-task-dot" />
                <div>
                  <strong>{item.title}</strong>
                  <p>
                    {item.client} · {item.kind} · due {dateLabel(item.dueDate)}
                  </p>
                </div>
                <ArrowRight size={16} />
              </Link>
            ))}
            {attention && attention.total > attention.items.length ? (
              <p className="execution-caption">
                Showing the earliest {attention.items.length} of {attention.total} due items. Open
                each requirement for all actions.
              </p>
            ) : null}
            {data.tasks
              .filter((task) => !task.done)
              .map((task) => (
                <button
                  type="button"
                  key={task.id}
                  onClick={() => {
                    setModal(null);
                    const item = data.aircraft.find((a) => a.id === task.aircraftId);
                    if (item) setAircraft(item);
                  }}
                >
                  <span className="notification-task-dot" />
                  <div>
                    <strong>{task.title}</strong>
                    <p>{task.detail}</p>
                  </div>
                  <ArrowRight size={16} />
                </button>
              ))}
            {attention &&
            !attentionError &&
            attention.total === 0 &&
            data.tasks.every((task) => task.done) ? (
              <p className="no-results">You’re all caught up. A little room to look ahead.</p>
            ) : null}
          </div>
        </Modal>
      ) : modal === "settings" ? (
        <Modal
          title="Your Aerion workspace"
          description="A personal space to build your aircraft transaction workflow."
          onClose={() => setModal(null)}
        >
          <WorkspaceSettings />
        </Modal>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast}
          <button type="button" aria-label="Dismiss notification" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
