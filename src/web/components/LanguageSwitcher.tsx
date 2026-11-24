import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, parseLocale, setLocale, t, useLocale } from "@/i18n";
import { cn } from "@/lib/utils";

/** Radio items for use inside an existing menu. Language names stay in their own language. */
export function LanguageRadioItems() {
  const locale = useLocale();
  return (
    <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(parseLocale(v) ?? "en")}>
      {LOCALES.map(({ value, label }) => (
        <DropdownMenuRadioItem key={value} value={value} lang={value}>
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** Standalone icon button (sign-in pages). */
export function LanguageToggle() {
  useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("Language")}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("Language")}</DropdownMenuLabel>
        <LanguageRadioItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Segmented choice for the Settings page. */
export function LanguagePicker() {
  const locale = useLocale();
  return (
    <div role="radiogroup" aria-label={t("Language")} className="grid grid-cols-2 gap-2 sm:max-w-xs">
      {LOCALES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          lang={value}
          aria-checked={locale === value}
          onClick={() => setLocale(value)}
          className={cn(
            "rounded-lg border p-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            locale === value && "border-primary bg-accent text-accent-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
