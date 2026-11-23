export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="14" fill="#0f766e" />
      <path d="M14 22a4 4 0 0 1 4-4h9l4 4h15a4 4 0 0 1 4 4v4H14z" fill="#99f6e4" />
      <path d="M12 30h40l-3.2 14.4A4 4 0 0 1 44.9 48H19.1a4 4 0 0 1-3.9-3.6z" fill="#fff" />
      <path d="M19 40c6 3 20 3 26 0M21 44c5 2 17 2 22 0" stroke="#0f766e" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
      <Logo />
      <span>
        File<span className="text-brand-700 dark:text-brand-500">Nest</span>
      </span>
    </span>
  );
}
