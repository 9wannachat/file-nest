import { Monitor, Moon, Sun } from "lucide-react";
import { useId, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t, useLocale, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/theme";

export const THEME_OPTIONS: { value: Theme; label: MessageKey; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Radio items for use inside an existing menu. */
export function ThemeRadioItems() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuRadioItem key={value} value={value}>
          <Icon /> {t(label)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** Standalone icon button (login / not-authorized pages). */
export function ThemeToggle() {
  const { resolved } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("Theme")}>
          {resolved === "dark" ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("Theme")}</DropdownMenuLabel>
        <ThemeRadioItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SEGMENT_ORDER: Theme[] = ["system", "light", "dark"];

/**
 * Inline "Theme  [system | light | dark]" row: one click, no submenu.
 * A radiogroup with roving focus (arrow keys move and select, like native radios).
 */
export function ThemeSegmented({ className, inMenu = false }: { className?: string; inMenu?: boolean }) {
  const { theme, setTheme } = useTheme();
  useLocale();
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const opts = SEGMENT_ORDER.map((v) => THEME_OPTIONS.find((o) => o.value === v)!);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = opts.length;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // keep the surrounding menu from moving focus
    const j = (next + n) % n;
    setTheme(opts[j]!.value);
    refs.current[j]?.focus();
  };

  return (
    <div className={cn("flex items-center justify-between gap-3", inMenu && "px-2 py-1.5", className)}>
      <span id={labelId} className={cn("text-sm", !inMenu && "font-medium")}>
        {t("Theme")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/50 p-0.5">
        {opts.map(({ value, label, icon: Icon }, i) => {
          const active = theme === value;
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(label)}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTheme(value)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className={cn(
                    "tap-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4",
                    active && "bg-background text-foreground shadow-sm ring-1 ring-border",
                  )}
                >
                  <Icon aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t(label)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
