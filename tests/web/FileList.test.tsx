import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DriveItem } from "@shared/types";
import { FileList, type ItemAction } from "@/components/FileList";

const items: DriveItem[] = [
  { id: "f1", kind: "folder", name: "Docs", parentId: null, createdAt: 0, updatedAt: 0, trashedAt: null },
  {
    id: "x1",
    kind: "file",
    name: "a.pdf",
    size: 2048,
    contentType: "application/pdf",
    inline: true,
    folderId: null,
    createdAt: 0,
    updatedAt: 0,
    trashedAt: null,
    isOwner: true,
    owner: { id: "u", email: "u@example.test", name: "U" },
    sharedWithCount: 1,
    hasPublicLink: true,
  },
];

describe("FileList", () => {
  it("supports keyboard: arrows, Enter, F2, Delete", async () => {
    const onOpen = vi.fn();
    const rename = vi.fn();
    const trash = vi.fn();
    const actionsFor = (): ItemAction[] => [
      { id: "rename", label: "Rename", icon: null, onSelect: rename },
      { id: "trash", label: "Move to trash", icon: null, onSelect: trash },
    ];
    render(<FileList items={items} actionsFor={actionsFor} onOpen={onOpen} />);
    const user = userEvent.setup();
    const rows = screen.getAllByRole("listitem");
    rows[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(items[1]);
    await user.keyboard("{F2}");
    expect(rename).toHaveBeenCalled();
    await user.keyboard("{Delete}");
    expect(trash).toHaveBeenCalled();
  });

  it("labels public/shared state and offers an actions button per row", () => {
    render(<FileList items={items} actionsFor={() => [{ id: "a", label: "A", icon: null, onSelect() {} }]} onOpen={() => {}} />);
    expect(screen.getByLabelText("Public link")).toBeInTheDocument();
    expect(screen.getByLabelText("Shared with 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for a.pdf" })).toBeInTheDocument();
  });
});
