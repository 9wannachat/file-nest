import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/theme";

let systemDark = false;
let listeners: ((e: { matches: boolean }) => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.head.innerHTML = '<meta name="theme-color" content="#000">';
  systemDark = false;
  listeners = [];
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    get matches() {
      return q.includes("dark") ? systemDark : false;
    },
    media: q,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.restoreAllMocks());

function Probe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="t">{`${theme}/${resolved}`}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  it("defaults to System and follows the OS live", async () => {
    systemDark = true;
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId("t").textContent).toBe("system/dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await act(async () => {
      systemDark = false;
      listeners.forEach((l) => l({ matches: false }));
    });
    expect(screen.getByTestId("t").textContent).toBe("system/light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("explicit choice overrides the OS, persists one key, mirrors a cookie and theme-color", async () => {
    systemDark = true;
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await userEvent.setup().click(screen.getByText("light"));
    expect(screen.getByTestId("t").textContent).toBe("light/light");
    expect(localStorage.getItem("filenest-theme")).toBe("light");
    expect(Object.keys(localStorage)).toEqual(["filenest-theme"]);
    expect(document.cookie).toContain("fn_theme=light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0f766e");
  });

  it("restores the saved choice", () => {
    localStorage.setItem("filenest-theme", "dark");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId("t").textContent).toBe("dark/dark");
  });
});
