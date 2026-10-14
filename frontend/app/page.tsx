import {
  ArrowRight,
  Download,
  EyeOff,
  GitBranch,
  History,
  Layers,
  Lock,
  Route,
  Scale,
  ShieldCheck,
  Trash2,
  UserCheck,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/landing/Logo";
import { Feature, Section, SectionHeading } from "@/components/landing/Section";
import { Button } from "@/components/ui/button";
import { Chip, SourceChip } from "@/components/ui/chip";

const REPO = "https://github.com/VeerbhadraMahant/memory-manager-IIIT-hc";

export const metadata: Metadata = {
  title: "Negotiated AI Memory — memory you negotiate, not memory that piles up silently",
  description:
    "A chat where AI memory is negotiated by you: see what is remembered as it forms, correct it, scope it to a session, and see which memories shaped every reply.",
  openGraph: {
    title: "Negotiated AI Memory",
    description: "Memory you negotiate, not memory that piles up silently.",
    images: ["/brand/og.png"],
  },
};

export default function Landing() {
  return (
    <div className="bg-bg text-ink-invert">
      <a
        href="#top"
        className="sr-only rounded-input bg-surface px-4 py-3 text-body-sm font-medium text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to the content
      </a>

      {/* ───────── nav: 64px, 1px hairline, teal links, one ghost pill ───────── */}
      <header className="border-b border-outline-strong">
        <nav
          aria-label="Primary"
          className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-5 md:px-20"
        >
          <Logo />
          <div className="flex items-center gap-1 sm:gap-4">
            <a href="#how" className="tap hidden items-center px-2 text-body-sm text-accent hover:opacity-70 sm:inline-flex">
              How it works
            </a>
            <a href="#principles" className="tap hidden items-center px-2 text-body-sm text-accent hover:opacity-70 md:inline-flex">
              Principles
            </a>
            <a href={REPO} className="tap hidden items-center px-2 text-body-sm text-accent hover:opacity-70 md:inline-flex">
              Source
            </a>
            <Link
              href="/app"
              className="tap inline-flex items-center whitespace-nowrap rounded-pill border border-ink-invert px-5 text-body-sm font-medium text-ink-invert transition-colors hover:bg-action hover:text-on-action"
            >
              Open workspace
            </Link>
          </div>
        </nav>
      </header>

      <main id="top">
        {/* ───────── hero: the single painted moment ───────── */}
        <div className="relative isolate overflow-hidden bg-lavender text-hero-ink">
          {/* Decorative — the meaning is in the headline. Anchored bottom-right so the
              peaks bleed off the right edge; on narrow screens it sits under the text. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/hero.svg"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 -z-10 h-full w-full object-cover object-[75%_100%] md:object-right-bottom"
          />
          <div className="mx-auto w-full max-w-[1200px] px-5 pb-72 pt-16 md:px-20 md:pb-40 md:pt-24">
            <div className="max-w-[34rem]">
              <p className="meta text-hero-ink-muted">
                Memory you <strong className="font-bold text-hero-ink">negotiate</strong>
              </p>
              <h1 className="mt-4 text-display font-light text-hero-ink">
                Memory that is <strong className="font-bold">agreed</strong>, not silently piled up.
              </h1>
              <p className="mt-6 max-w-[30rem] text-body-lg font-light text-hero-ink">
                A chat where you see what is being remembered as it forms, correct it, keep it to one
                conversation, and see exactly which memories shaped each reply.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link
                  href="/app"
                  className="tap inline-flex items-center gap-2 rounded-input bg-bg px-6 text-body-sm font-medium text-ink-invert transition-colors hover:bg-sunken"
                >
                  Open the workspace
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
                <a href="#how" className="tap inline-flex items-center text-body-sm font-medium text-hero-ink underline underline-offset-4">
                  How it works
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* ───────── how it works: four flat features ───────── */}
        <Section id="how">
          <SectionHeading
            emphasis
            sub="Four rules that the interface and the database both enforce — not a settings page that promises them."
          >
            Every memory is a conversation, not a log entry
          </SectionHeading>
          <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4 lg:gap-10">
            <Feature icon={<UserCheck />} title="It proposes, you decide" where="services/policy.py">
              After a turn, facts worth keeping appear as review cards. Accept, edit, re-scope or
              discard each one. Only low-risk facts you stated yourself are kept without asking.
            </Feature>
            <Feature icon={<Scale />} title="Stated is not inferred" where="services/classify.py">
              Every memory says whether you said it or the model worked it out. Inferred facts always
              ask first, and sensitivity can be raised by a check — never quietly lowered.
            </Feature>
            <Feature icon={<Layers />} title="Scope is real" where="services/retrieval.py">
              A memory kept to one session is filtered out of every other chat in the database query
              itself, so a front-end bug cannot leak it.
            </Feature>
            <Feature icon={<EyeOff />} title="Off the record means off" where="services/extraction.py">
              A message marked off the record is never read for memory. The extraction step returns
              before the model ever sees it.
            </Feature>
          </div>
        </Section>

        {/* ───────── product peek: the review card ───────── */}
        <Section className="pt-0">
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
            <div className="rounded-card border border-outline-strong bg-surface p-6" aria-label="Example review card">
              <p className="meta text-ink-muted">Review · 1 of 3</p>
              <p className="mt-3 text-body-lg font-light text-ink">
                Takes 20mg of sertraline, started in March
              </p>
              <blockquote className="mt-3 border-l border-outline-strong pl-3 text-body-sm text-ink-muted">
                “…taking 20mg of sertraline since March.”
              </blockquote>
              <div className="mt-4 flex flex-wrap gap-2">
                <SourceChip source="stated" />
                <Chip tone="alert">Special category</Chip>
                <Chip>This chat only</Chip>
                <Chip>Health</Chip>
              </div>
              <p className="mt-4 text-body-sm text-ink-muted">
                Special category — kept to this session unless you choose to keep it.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" tabIndex={-1}>
                  Keep beyond this chat
                </Button>
                <Button variant="outline" size="sm" tabIndex={-1}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" tabIndex={-1}>
                  Discard
                </Button>
              </div>
            </div>
            <div>
              <h2 className="text-headline-lg font-light">You see it before it is kept</h2>
              <p className="mt-4 max-w-md text-body-md text-ink-invert-muted">
                Health, money and relationships are never filed away silently. They arrive in the
                conversation with the sentence they came from and the reason they need you — and the
                safe choice, keeping it to this chat, is the default.
              </p>
              <ul className="mt-6 space-y-3 text-body-sm text-ink-invert-muted">
                <li className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />Low confidence files into the most restrictive block, not a neutral one.</li>
                <li className="flex gap-3"><Route className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />Each reply lists the memories that were retrieved — and the ones that were withheld.</li>
              </ul>
            </div>
          </div>
        </Section>

        {/* ───────── terminal: the claim check ───────── */}
        <Section className="pt-0">
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
            <div className="lg:order-2">
              <h2 className="text-headline-lg font-light">Unfinished work is never written up as finished</h2>
              <p className="mt-4 max-w-md text-body-md text-ink-invert-muted">
                A paper you are still writing is stored as <code className="font-mono text-body-sm text-accent">in_progress</code>.
                For high-stakes drafts every claim is compared with what the memory actually says — in
                code, not by asking the model to grade its own homework.
              </p>
            </div>
            <div className="overflow-hidden rounded-input border border-outline bg-sunken lg:order-1">
              <div className="flex items-center gap-2 border-b border-outline px-4 py-3" aria-hidden="true">
                <span className="size-2 rounded-pill bg-danger" />
                <span className="size-2 rounded-pill bg-stated" />
                <span className="size-2 rounded-pill bg-accent" />
                <span className="meta ml-3 text-ink-muted">verified-draft</span>
              </div>
              <pre className="overflow-x-auto p-6 font-mono text-label-sm font-light text-ink" tabIndex={0}>
{`instruction  "Write my bio for the CHI submission"

claim 1  "has published a paper on memory negotiation"
         asserted   completed
         memory     in_progress  "Writing a CHI paper…"
`}<span className="text-danger">{`         ✗ overstates — needs your confirmation`}</span>{`

claim 2  "is writing a paper on memory negotiation"
`}<span className="text-stated">{`         ✓ matches the memory`}</span>{`
`}</pre>
            </div>
          </div>
        </Section>

        {/* ───────── principles ───────── */}
        <Section id="principles" className="pt-0">
          <SectionHeading sub="The parts of the product that exist so that you stay in charge of it.">
            Built so you can audit it
          </SectionHeading>
          <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3 lg:gap-x-10 lg:gap-y-14">
            <Feature icon={<Lock />} title="Private blocks">
              Withhold a whole category — health, finance — from every prompt. The memories stay
              visible and editable to you; the model simply never receives them.
            </Feature>
            <Feature icon={<Trash2 />} title="A deletion preview">
              Before you delete, see what dies with it and what only loses support. Past answers are
              not rewritten, and the count of affected replies is shown.
            </Feature>
            <Feature icon={<History />} title="Facts go stale, not wrong">
              An in-progress memory nobody has confirmed for two weeks is re-checked rather than
              stated as current. One tap says it is still true.
            </Feature>
            <Feature icon={<GitBranch />} title="Provenance for everything">
              Every memory points to the message it came from, with the exact phrase. There are no
              orphaned facts.
            </Feature>
            <Feature icon={<Layers />} title="Switch models, keep the memory">
              Change the model mid-conversation. Memory and retrieval live outside the provider, so
              the new one starts from the same ledger.
            </Feature>
            <Feature icon={<Download />} title="Your data is yours">
              Export everything stored about you as JSON, or erase your account and its memories
              entirely, from your profile.
            </Feature>
          </div>
        </Section>

        {/* ───────── closing call ───────── */}
        <Section className="border-t border-outline pt-24 text-center md:pt-32">
          <h2 className="mx-auto max-w-2xl text-headline-lg font-light text-stated">
            Start a conversation you can audit.
          </h2>
          <p className="mx-auto mt-4 max-w-md text-body-md text-ink-invert-muted">
            Sign in, say something with a mix of things in it, and watch what is proposed.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/app"
              className="tap inline-flex items-center gap-2 rounded-input bg-action px-6 text-body-sm font-medium text-on-action transition-colors hover:brightness-90"
            >
              Open the workspace
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <a
              href={REPO}
              className="tap inline-flex items-center rounded-input border border-outline-strong px-6 text-body-sm font-medium text-ink-invert transition-colors hover:bg-ink-invert/[0.08]"
            >
              Read the source
            </a>
          </div>
        </Section>
      </main>

      <footer className="border-t border-outline px-5 py-10 md:px-20">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <Logo className="text-ink-invert" />
          <p className="text-body-sm text-ink-invert-muted">
            An HCI project, SIGCHI-supported. Your memory is stored per account.
          </p>
          <div className="flex gap-6 text-body-sm">
            <Link href="/app" className="tap inline-flex items-center text-accent hover:opacity-70">Workspace</Link>
            <a href={REPO} className="tap inline-flex items-center text-accent hover:opacity-70">Source</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
