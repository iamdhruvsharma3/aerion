"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError } from "@/lib/api";
import { workspaceSchema, type Workspace } from "@/lib/schema";
import { emptyWorkspace, type WorkspaceAction } from "@/lib/workspace";

type Session = { mode: "local" | "supabase"; workspaceId: string; actorId: string };
type Context = {
  data: Workspace;
  ready: boolean;
  storageError: string;
  saving: boolean;
  session: Session | null;
  dispatch: (action: WorkspaceAction) => Promise<boolean>;
  refresh: () => Promise<void>;
};
const WorkspaceContext = createContext<Context | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [storageError, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const revision = useRef(-1);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const adopt = useCallback((result: { data: Workspace; revision: number }) => {
    const parsed = workspaceSchema.parse(result.data);
    if (result.revision >= revision.current) {
      revision.current = result.revision;
      setData(parsed);
    }
  }, []);
  const refresh = useCallback(async () => {
    const result = await api<{ data: Workspace; revision: number }>("/api/workspace");
    adopt(result);
  }, [adopt]);
  const initialize = useCallback(async () => {
    setError("");
    setNeedsLogin(false);
    try {
      const [current, result] = await Promise.all([
        api<Session>("/api/session"),
        api<{ data: Workspace; revision: number }>("/api/workspace"),
      ]);
      setSession(current);
      adopt(result);
      setReady(true);
    } catch (error) {
      setNeedsLogin(error instanceof ApiError && error.status === 401);
      setError(error instanceof Error ? error.message : "Workspace could not be loaded.");
    }
  }, [adopt]);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  const dispatch = useCallback(
    (action: WorkspaceAction): Promise<boolean> => {
      pending.current++;
      setSaving(true);
      setError("");
      const task = queue.current.then(async () => {
        try {
          const result = await api<{ data: Workspace; revision: number }>("/api/workspace", {
            method: "POST",
            body: JSON.stringify({ action, revision: revision.current }),
          });
          adopt(result);
          return true;
        } catch (error) {
          setError(error instanceof Error ? error.message : "This change was not saved.");
          if (error instanceof ApiError && error.status === 409) await refresh().catch(() => {});
          return false;
        } finally {
          pending.current--;
          setSaving(pending.current > 0);
        }
      });
      queue.current = task;
      return task;
    },
    [adopt, refresh],
  );
  const value = useMemo(
    () => ({ data, ready, storageError, saving, session, dispatch, refresh }),
    [data, ready, storageError, saving, session, dispatch, refresh],
  );
  return (
    <WorkspaceContext value={value}>
      {ready ? (
        children
      ) : (
        <WorkspaceGate error={storageError} needsLogin={needsLogin} retry={initialize} />
      )}
    </WorkspaceContext>
  );
}

function WorkspaceGate({
  error,
  needsLogin,
  retry,
}: {
  error: string;
  needsLogin: boolean;
  retry: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/auth/sign-in", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      await retry();
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-gate">
      <div className="gate-brand">
        aerion<span>.</span>
      </div>
      <div className="eyebrow muted">YOUR OPERATING WORKSPACE</div>
      <h1>
        {needsLogin ? "Welcome back." : error ? "Let’s reconnect." : "Preparing your workspace."}
      </h1>
      <p>
        {needsLogin
          ? "Sign in to access your aircraft, sources, and opportunities."
          : error || "Connecting to your saved aircraft intelligence."}
      </p>
      {needsLogin ? (
        <form className="modal-form" onSubmit={signIn}>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {loginError ? (
            <p className="form-error" role="alert">
              {loginError}
            </p>
          ) : null}
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : error ? (
        <button type="button" className="button button-primary" onClick={() => void retry()}>
          Retry connection
        </button>
      ) : (
        <div className="connection-loader" />
      )}
    </div>
  );
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace requires WorkspaceProvider");
  return context;
}
