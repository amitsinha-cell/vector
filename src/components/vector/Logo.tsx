export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-label="Vector logo" role="img">
      <defs>
        <linearGradient id="vg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--primary)" />
          <stop offset="1" stopColor="var(--chart-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="11" fill="url(#vg)" />
      <path d="M11 12 L20 29 L29 12" fill="none" stroke="var(--primary-foreground)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="29" cy="12" r="2.4" fill="var(--primary-foreground)" />
    </svg>
  );
}
