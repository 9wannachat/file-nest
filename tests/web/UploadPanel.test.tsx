import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadPanel } from "@/upload/UploadPanel";
import { UploadProvider, useUploads } from "@/upload/UploadProvider";

function Enq({ files }: { files: File[] }) {
  const { enqueue } = useUploads();
  return <button onClick={() => enqueue(files, null)}>go</button>;
}

afterEach(() => vi.unstubAllGlobals());

describe("upload panel", () => {
  it("shows a per-file error and retries through the same flow", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code: "quota_exceeded", message: "Storage quota exceeded" } }), { status: 413 });
      }),
    );
    render(
      <UploadProvider maxBytes={1000}>
        <Enq files={[new File(["hi"], "hi.txt", { type: "text/plain" })]} />
        <UploadPanel />
      </UploadProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("go"));
    expect(await screen.findByText("Storage quota exceeded")).toBeInTheDocument();
    expect(calls).toBe(1);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Retry/ }));
    });
    await screen.findByText("Storage quota exceeded");
    expect(calls).toBe(2);
  });

  it("rejects files above the limit before contacting the server", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    render(
      <UploadProvider maxBytes={1}>
        <Enq files={[new File(["too big"], "big.bin")]} />
        <UploadPanel />
      </UploadProvider>,
    );
    await userEvent.setup().click(screen.getByText("go"));
    expect(await screen.findByText(/larger than the upload limit/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
});
