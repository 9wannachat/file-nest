import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash } from "node:crypto";
import { Toaster } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadPanel } from "@/upload/UploadPanel";
import { fileFingerprint, UploadProvider } from "@/upload/UploadProvider";

afterEach(() => vi.unstubAllGlobals());

describe("large uploads in the browser", () => {
  it("fingerprints exactly like the MCP client: SHA-256(first MiB ‖ last MiB ‖ size)", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const want = createHash("sha256").update(big.subarray(0, 1024 * 1024)).update(big.subarray(2 * 1024 * 1024)).update(String(big.length)).digest("hex");
    expect(await fileFingerprint(new Blob([big]))).toBe(want);
    const small = new TextEncoder().encode("hello");
    expect(await fileFingerprint(new Blob([small]))).toBe(createHash("sha256").update(small).update("5").digest("hex"));
  });

  it("lists unfinished uploads, refuses a different file, and can discard one", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/uploads/resumable")
          return new Response(JSON.stringify({ uploads: [{ uploadId: "u1", name: "movie.mov", size: 12, mime: null, folderId: null, partSize: 4, partCount: 3, createdAt: 0, expiresAt: 0 }] }));
        return new Response(JSON.stringify({ state: "aborted" }));
      }),
    );
    render(
      <UploadProvider maxBytes={1000} resumable>
        <UploadPanel />
        <Toaster />
      </UploadProvider>,
    );
    expect(await screen.findByText("movie.mov")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Choose movie.mov to continue uploading"), new File(["other"], "movie.mov"));
    expect(await screen.findByText(/Choose the same file: movie.mov/)).toBeInTheDocument();
    expect(screen.getByText("movie.mov")).toBeInTheDocument(); // still listed
    await user.click(screen.getByRole("button", { name: "Discard movie.mov" }));
    expect(screen.queryByText("movie.mov")).not.toBeInTheDocument();
    expect(calls).toContain("POST /api/uploads/u1/abort");
  });
});
