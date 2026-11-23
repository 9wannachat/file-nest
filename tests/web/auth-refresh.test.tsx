import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/auth";

function Probe() {
  const { state, refreshSilently } = useAuth();
  return (
    <div>
      <span data-testid="s">{state.status === "ready" ? `ready:${state.me.user.usedBytes}` : state.status}</span>
      <button onClick={refreshSilently}>silent</button>
    </div>
  );
}

const me = (used: number) =>
  new Response(JSON.stringify({ user: { id: "u", email: "a@b.c", name: null, role: "member", quotaBytes: 10, usedBytes: used }, csrfToken: "x", limits: { maxUploadBytes: 1 } }), {
    status: 200,
  });

afterEach(() => vi.unstubAllGlobals());

describe("silent refresh", () => {
  it("updates usage on success and never leaves the ready state on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(me(1)).mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(me(7));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText("ready:1")).toBeInTheDocument();
    for (let i = 0; i < 2; i++) {
      await act(async () => screen.getByText("silent").click());
      await act(async () => {});
      expect(screen.getByTestId("s").textContent).toBe("ready:1"); // network error / 5xx: shell stays mounted
    }
    await act(async () => screen.getByText("silent").click());
    expect(await screen.findByText("ready:7")).toBeInTheDocument();
  });
});
