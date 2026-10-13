import Link from "next/link";

/** The mark is public/brand/mark.svg inlined, so it needs no request and takes the
 *  surrounding text colour for the wordmark. */
export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2.5 ${className ?? ""}`} aria-label="Negotiated AI Memory, home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mark.svg" alt="" width={28} height={28} className="size-7" />
      <span className="hidden whitespace-nowrap text-body-md font-medium min-[420px]:inline">Negotiated AI Memory</span>
    </Link>
  );
}
