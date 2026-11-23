import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me } from "@shared/types";
import { api, ApiError, setCsrfToken, UNAUTHENTICATED_EVENT } from "@/lib/api";

type AuthState = { status: "loading" } | { status: "anon" } | { status: "error"; message: string } | { status: "ready"; me: Me };

const AuthContext = createContext<{ state: AuthState; refresh: () => void; logout: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const refresh = () => {
    api<Me>("/api/me")
      .then((me) => {
        setCsrfToken(me.csrfToken);
        setState({ status: "ready", me });
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setState({ status: "anon" });
        else setState({ status: "error", message: e instanceof Error ? e.message : "Failed to load" });
      });
  };

  useEffect(() => {
    refresh();
    const onUnauth = () => setState({ status: "anon" });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, []);

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken("");
      setState({ status: "anon" });
    }
  };

  return <AuthContext.Provider value={{ state, refresh, logout }}>{children}</AuthContext.Provider>;
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
