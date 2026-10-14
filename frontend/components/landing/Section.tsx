import { cn } from "@/lib/utils";

/** 1200px column, 128px between bands on desktop (the style's section gap). */
export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={cn("px-5 py-20 md:px-20 md:py-32", className)}>
      <div className="mx-auto w-full max-w-[1200px]">{children}</div>
    </section>
  );
}

/** Centered section heading. `emphasis` is the one mint heading on a page: the style
 *  reserves mint for the heading that should be read first. */
export function SectionHeading({
  children,
  sub,
  emphasis,
  align = "center",
}: {
  children: React.ReactNode;
  sub?: React.ReactNode;
  emphasis?: boolean;
  align?: "center" | "left";
}) {
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      <h2
        className={cn(
          "text-headline-lg font-normal",
          emphasis ? "text-ink" : "text-ink-invert",
        )}
      >
        {children}
      </h2>
      {sub && <p className="mt-4 text-body-md text-ink-invert-muted">{sub}</p>}
    </div>
  );
}

/** Icon in a 32px ring — the style's icon container (the one place a full pill is allowed
 *  besides tags). Stroke is teal, 1.5px. */
export function IconRing({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex size-10 items-center justify-center rounded-pill border border-accent text-accent [&_svg]:size-5 [&_svg]:stroke-[1.5]">
      {children}
    </span>
  );
}

/** No card fill: on this surface the negative space is the card. */
export function Feature({
  icon,
  title,
  children,
  where,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  /** Where the rule is enforced, in the code — the claim made checkable. */
  where?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <IconRing>{icon}</IconRing>
      <h3 className="text-body-lg text-ink-invert">{title}</h3>
      <p className="text-body-sm text-ink-invert-muted">{children}</p>
      {where && <p className="meta mt-auto pt-1 text-ink-invert-muted">Enforced in {where}</p>}
    </div>
  );
}
