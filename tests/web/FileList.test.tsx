import { render, screen } from "@testing-library/react";
import type React from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DriveItem } from "@shared/types";
import { FileList, type ItemAction } from "@/components/FileList";
import { TooltipProvider } from "@/components/ui/tooltip";

const sort = { key: "name" as const, dir: "asc" as const };
const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

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
    wrap(<FileList items={items} actionsFor={actionsFor} onOpen={onOpen} sort={sort} onSort={() => {}} />);
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
    wrap(<FileList items={items} actionsFor={() => [{ id: "a", label: "A", icon: null, onSelect() {} }]} onOpen={() => {}} sort={sort} onSort={() => {}} />);
    expect(screen.getByLabelText("Public link")).toBeInTheDocument();
    expect(screen.getByLabelText("Shared with 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for a.pdf" })).toBeInTheDocument();
  });
});

describe("FileList sorting and selection", () => {
  it("keeps folders first, sorts files, and toggles selection with Space and checkboxes", async () => {
    const more: DriveItem[] = [
      ...items,
      { ...(items[1] as Extract<DriveItem, { kind: "file" }>), id: "x2", name: "b.pdf", size: 10 },
    ];
    let selected = new Set<string>();
    const onSelectedChange = vi.fn((s: Set<string>) => (selected = s));
    const { rerender } = wrap(
      <FileList items={more} actionsFor={() => []} onOpen={() => {}} sort={{ key: "size", dir: "desc" }} onSort={() => {}} selected={selected} onSelectedChange={onSelectedChange} />,
    );
    const names = screen.getAllByRole("listitem").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["Folder Docs", "File a.pdf", "File b.pdf"]);
    const user = userEvent.setup();
    screen.getAllByRole("listitem")[1]!.focus();
    await user.keyboard(" ");
    expect([...selected]).toEqual(["file:x1"]);
    rerender(
      <TooltipProvider>
        <FileList items={more} actionsFor={() => []} onOpen={() => {}} sort={{ key: "size", dir: "desc" }} onSort={() => {}} selected={selected} onSelectedChange={onSelectedChange} />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(selected.size).toBe(3);
  });
});
