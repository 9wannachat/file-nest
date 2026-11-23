import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@shared/types";
import { api, ApiError, setCsrfToken, UNAUTHENTICATED_EVENT } from "@/lib/api";

type AuthState = { status: "loading" } | { status: "anon" } | { status: "error"; message: string } | { status: "ready"; me: Me };

interface AuthCtx {
  state: AuthState;
  /** Full (re)load: may move to anon/error. Use on startup and explicit retry. */
  refresh: () => void;
  /** Background refresh of /api/me (e.g. quota after uploads): only applies success, never unmounts the app. */
  refreshSilently: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx | null>(null);

/** Fired when storage usage may have changed (uploads finished, items purged). */
export const USAGE_CHANGED_EVENT = "filenest:usage-changed";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(() => {
    api<Me>("/api/me")
      .then((me) => {
        setCsrfToken(me.csrfToken ?? "");
        setState({ status: "ready", me });
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setState({ status: "anon" });
        else setState({ status: "error", message: e instanceof Error ? e.message : "Failed to load" });
      });
  }, []);

  const refreshSilently = useCallback(() => {
    api<Me>("/api/me")
      .then((me) => {
        setCsrfToken(me.csrfToken ?? "");
        setState((cur) => (cur.status === "ready" ? { status: "ready", me } : cur));
      })
      .catch(() => {
        /* keep the current state; a real 401 is handled by UNAUTHENTICATED_EVENT */
      });
  }, []);

  useEffect(() => {
    refresh();
    const onUnauth = () => setState({ status: "anon" });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken("");
      setState({ status: "anon" });
    }
  }, []);

  const value = useMemo(() => ({ state, refresh, refreshSilently, logout }), [state, refresh, refreshSilently, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const c = useContext(AuthContext);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "ready") throw new Error("not signed in");
  return state.me;
}
