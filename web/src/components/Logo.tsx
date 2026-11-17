import { cn } from '../lib/utils';

/** Kanbot mark: four board columns with a card moving right. Inline SVG, so it follows the theme. Swap it here only. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Kanbot" className={cn('h-8 w-8 shrink-0 select-none', className)}>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="hsl(var(--primary))" />
      <g fill="none" stroke="hsl(var(--primary-foreground))" strokeWidth="2" strokeLinecap="round" opacity="0.55">
        <path d="M8 8v16M13.3 8v16M18.6 8v16M24 8v16" />
      </g>
      <rect x="5.5" y="9" width="5" height="5" rx="1.2" fill="hsl(var(--primary-foreground))" />
      <rect x="10.8" y="15" width="5" height="5" rx="1.2" fill="hsl(var(--primary-foreground))" />
      <rect x="21.5" y="18" width="5" height="5" rx="1.2" fill="hsl(var(--primary-foreground))" />
    </svg>
  );
}
