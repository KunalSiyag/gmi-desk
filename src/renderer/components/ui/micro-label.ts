/**
 * GMI's micro-label: small uppercase monospace with wide tracking, muted ("RECENT", "PRICING", "YOU PAY"). The one
 * definition for the whole app: use this class string (with `cn`, a later text colour wins) or <MicroLabel> from
 * ./misc. Its own module so brand components can use it without importing misc.tsx (which imports Dino).
 */
export const microLabel = 'font-mono text-3xs font-medium uppercase tracking-[0.16em] text-muted-foreground';
