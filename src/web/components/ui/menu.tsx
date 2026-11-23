import { ContextMenu as CM, DropdownMenu as DM } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const content =
  "z-50 min-w-48 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900";
const item =
  "relative flex min-h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-[highlighted]:bg-slate-100 data-[disabled]:opacity-50 dark:data-[highlighted]:bg-slate-800 [&_svg]:size-4 [&_svg]:text-slate-500";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export function DropdownMenuContent({ className, ...p }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={4} align="end" className={cn(content, className)} {...p} />
    </DM.Portal>
  );
}
export function DropdownMenuItem({ className, destructive, ...p }: React.ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return <DM.Item className={cn(item, destructive && "text-red-600 [&_svg]:text-red-600", className)} {...p} />;
}
export const DropdownMenuSeparator = () => <DM.Separator className="my-1 h-px bg-slate-200 dark:bg-slate-800" />;

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;
export function ContextMenuContent({ className, ...p }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal>
      <CM.Content className={cn(content, className)} {...p} />
    </CM.Portal>
  );
}
export function ContextMenuItem({ className, destructive, ...p }: React.ComponentProps<typeof CM.Item> & { destructive?: boolean }) {
  return <CM.Item className={cn(item, destructive && "text-red-600 [&_svg]:text-red-600", className)} {...p} />;
}
export const ContextMenuSeparator = () => <CM.Separator className="my-1 h-px bg-slate-200 dark:bg-slate-800" />;
