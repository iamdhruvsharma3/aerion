"use client";
import { useEffect, useState } from "react";
import { ArrowDownToLine, Database, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { workspaceSchema, type Workspace } from "@/lib/schema";
import { downloadText } from "@/lib/format";
import { useWorkspace } from "./workspace-provider";

export function WorkspaceSettings() {
  const { data, session, dispatch, saving } = useWorkspace();
  const [backup, setBackup] = useState<Workspace | null>(null);
  const [message, setMessage] = useState("");
  const [modelReady, setModelReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("aerion:workspace:v1");
      if (raw) {
        const parsed = workspaceSchema.safeParse(JSON.parse(raw));
        if (parsed.success) setBackup(parsed.data);
        else
          setMessage(
            "An older browser backup exists but needs repair before migration. It has been preserved.",
          );
      }
    } catch {
      setMessage("Browser storage is unavailable. Server records are unaffected.");
    }
    api<{ modelReady: boolean }>("/api/sources")
      .then((result) => setModelReady(result.modelReady))
      .catch(() => {});
  }, []);
  const empty = !(
    data.aircraft.length ||
    data.requirements.length ||
    data.contacts.length ||
    data.deals.length
  );
  return (
    <div className="settings-content">
      <div>
        <span>Workspace</span>
        <strong>Aerion · Private founder workspace</strong>
      </div>
      <div>
        <span>Data storage</span>
        <strong>
          <Database size={15} /> PostgreSQL · saved on the server
        </strong>
      </div>
      <div>
        <span>Access</span>
        <strong>
          {session?.mode === "local" ? "Development · this machine only" : "Supabase authenticated"}
        </strong>
      </div>
      <div>
        <span>Extraction</span>
        <strong>
          {modelReady
            ? "Local parser + AI provider configured"
            : "Local parser ready · AI not connected"}
        </strong>
      </div>
      <p>
        Original documents, extracted observations, review decisions, and opportunity evidence stay
        in your workspace. Local development starts the extraction worker automatically.
      </p>
      {backup && empty ? (
        <div className="browser-migration">
          <strong>Your earlier browser workspace is available.</strong>
          <p>
            {backup.aircraft.length} aircraft · {backup.requirements.length} buyer requirements ·{" "}
            {backup.contacts.length} contacts. This may include the original fictional demo records.
            The browser copy will be preserved.
          </p>
          <button
            type="button"
            disabled={saving}
            className="button button-secondary"
            onClick={async () => {
              if (await dispatch({ type: "migrate", workspace: backup })) {
                setBackup(null);
                setMessage(
                  "Browser records migrated to PostgreSQL. The original browser copy has been preserved.",
                );
              }
            }}
          >
            <Upload size={16} />
            Import earlier browser workspace
          </button>
        </div>
      ) : backup ? (
        <p>
          Your earlier browser backup is preserved. Migration is available only into an empty
          workspace.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <button
        type="button"
        className="button button-secondary"
        onClick={() =>
          downloadText("aerion-workspace.json", JSON.stringify(data, null, 2), "application/json")
        }
      >
        <ArrowDownToLine size={16} />
        Export inventory and CRM backup
      </button>
      <p className="settings-backup-note">
        This JSON contains CRM records and evidence references. Back up PostgreSQL separately to
        retain original documents, extraction history, and review records.
      </p>
      {session?.mode === "supabase" ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={async () => {
            await api("/api/auth/sign-out", { method: "POST" });
            window.location.reload();
          }}
        >
          Sign out
        </button>
      ) : null}
    </div>
  );
}
