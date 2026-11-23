import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DriveItem } from "@shared/types";
import { useItemActions } from "@/components/useItemActions";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const file: DriveItem = {
  id: "f1",
  kind: "file",
  name: "clip.mp4",
  size: 1,
  contentType: "video/mp4",
  inline: true,
  folderId: null,
  createdAt: 0,
  updatedAt: 0,
  trashedAt: null,
  isOwner: true,
  owner: { id: "u", email: "u@x", name: null },
  sharedWithCount: 0,
  hasPublicLink: false,
};

let nav: ReturnType<typeof useNavigate>;
function Host({ mode = "drive" as const, items = [file] }: { mode?: "drive" | "trash"; items?: DriveItem[] }) {
  nav = useNavigate();
  const { dialogs } = useItemActions(mode, () => {}, items, true);
  return dialogs;
}

describe("?preview= deep link", () => {
  it("opens from the URL and closes again when the param goes away (Back)", async () => {
    render(
      <MemoryRouter initialEntries={["/", "/?preview=f1"]} initialIndex={1}>
        <Host />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("dialog", { name: "clip.mp4" })).toBeInTheDocument();
    await act(async () => nav(-1));
    expect(screen.queryByRole("dialog", { name: "clip.mp4" })).toBeNull();
  });

  it("is ignored in Trash and reports a missing file", async () => {
    const { toast } = await import("sonner");
    render(
      <MemoryRouter initialEntries={["/trash?preview=f1"]}>
        <Host mode="trash" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    render(
      <MemoryRouter initialEntries={["/?preview=nope"]}>
        <Host items={[file]} />
      </MemoryRouter>,
    );
    expect(toast.error).toHaveBeenCalled();
  });
});
