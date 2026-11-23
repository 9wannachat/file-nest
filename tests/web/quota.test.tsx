import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@shared/types";
import { QuotaBanner, quotaState } from "@/components/quota";
import { UploadPanel } from "@/upload/UploadPanel";
import { UploadProvider, useUploads } from "@/upload/UploadProvider";

const user = (used: number, quota: number, extra: Partial<Me["user"]> = {}): Me["user"] => ({
  id: "u",
  email: "u@x",
  name: null,
  role: "member",
  quotaBytes: quota,
  usedBytes: used,
  trashedBytes: 0,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("quota state and banner", () => {
  it("levels: ok < 80% ≤ warn < 95% ≤ critical; unlimited is always ok", () => {
    expect(quotaState(user(79, 100)).level).toBe("ok");
    expect(quotaState(user(80, 100)).level).toBe("warn");
    expect(quotaState(user(95, 100)).level).toBe("critical");
    expect(quotaState(user(500, 100, { quotaUnlimited: true }))).toMatchObject({ level: "ok", remaining: null });
    expect(quotaState(user(120, 100)).remaining).toBe(0);
  });

  it("banner explains the situation and links to trash when it would help", () => {
    const { rerender } = render(
      <MemoryRouter>
        <QuotaBanner user={user(50, 100)} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <MemoryRouter>
        <QuotaBanner user={user(100, 100, { trashedBytes: 30 })} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Your storage is full");
    expect(screen.getByRole("link", { name: "Open trash" })).toHaveAttribute("href", "/trash");
  });
});

function Enq({ files }: { files: File[] }) {
  const { enqueue } = useUploads();
  return <button onClick={() => enqueue(files, null)}>go</button>;
}

describe("pre-upload quota check", () => {
  it("rejects files that would not fit, without contacting the server", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", f);
    render(
      <UploadProvider maxBytes={1000} remainingBytes={5}>
        <Enq files={[new File(["123"], "fits.txt"), new File(["456"], "too-much.txt")]} />
        <UploadPanel />
      </UploadProvider>,
    );
    await userEvent.setup().click(screen.getByText("go"));
    expect(await screen.findByText("Not enough storage left for this file")).toBeInTheDocument();
    // Only the first file reached the server.
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(1);
    const bodies = (f.mock.calls as unknown as [unknown, RequestInit | undefined][]).map(([, init]) => String(init?.body ?? ""));
    expect(bodies.some((b) => b.includes("fits.txt"))).toBe(true);
    expect(bodies.some((b) => b.includes("too-much"))).toBe(false);
  });
});
