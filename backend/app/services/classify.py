"""Cheap classifiers that run alongside the LLM pass, not instead of it.

SYSTEM_DESIGN §3 asks for "cheap tense/aspect heuristics first, LLM fallback" and
"regex first pass for structured/special-category patterns". Our architecture batches
extraction and classification into one Gemini call for quota reasons (D16), so there is
no separate pass to put first. These run as a **cross-check** on the LLM's answer
instead, and they are deliberately one-directional:

- Sensitivity can only be raised, never lowered. If regex sees medication and the model
  said "low", the item becomes special_category. If regex sees nothing, the model's
  answer stands. Over-restricting is an annoyance, over-sharing is a violation
  (principle 1), so a disagreement resolves toward caution every time.
- Status disagreement does not overrule the model — it forces the item to review.
  A regex cannot reliably out-classify an LLM on tense, but it can notice that
  something is worth a human glance, which is the whole point of the review path.

This is the layer that would have caught the CV incident: "still writing" carries an
unambiguous progressive marker, and a claim of `completed` over that text is exactly
the disagreement worth interrupting for.
"""

from __future__ import annotations

import re

from app.models import AssertionStatus, Sensitivity

# Ordered least to most restrictive. Used to take a maximum, never a minimum.
SENSITIVITY_RANK: dict[Sensitivity, int] = {
    Sensitivity.low: 0,
    Sensitivity.medium: 1,
    Sensitivity.high: 2,
    Sensitivity.special_category: 3,
}

# How "complete" an assertion claims to be. Used by the P6 verification pass to detect
# a draft asserting more than the memory supports.
COMPLETENESS_RANK: dict[AssertionStatus, int] = {
    AssertionStatus.hypothetical: 0,
    AssertionStatus.planned: 1,
    AssertionStatus.abandoned: 1,
    AssertionStatus.third_party: 1,
    AssertionStatus.in_progress: 2,
    AssertionStatus.completed: 3,
}

# GDPR Art. 9 special categories plus the obvious health markers. Deliberately broad:
# a false positive costs the user one "keep beyond this chat" click, a false negative
# files a medical fact in a shareable block.
_SPECIAL_CATEGORY = re.compile(
    r"\b("
    r"\d+\s*mg\b|\bmg\b|dosage|dose|prescri\w*|diagnos\w*|symptom\w*|syndrome|disorder"
    r"|medication|antidepress\w*|therapy|therapist|psychiatr\w*|clinic\w*|surgery"
    r"|anxiety|depress\w*|adhd|autis\w*|cancer|diabet\w*|hiv|epilep\w*|asthma"
    r"|pregnan\w*|miscarriage|fertility|contracept\w*"
    r"|muslim|hindu|christian|jewish|sikh|buddhist|atheist|religio\w*|caste"
    r"|gay|lesbian|bisexual|queer|transgender|sexual orientation"
    r"|union member|trade union|convict\w*|arrest\w*|criminal record"
    r")\b",
    re.I,
)

_HIGH = re.compile(
    r"\b("
    r"salary|income|savings|debt|loan|mortgage|rent|bank|overdraft|bankrupt\w*"
    r"|divorce|separat\w*|affair|custody|breakup|broke up"
    r"|address|postcode|pin code|flat no|apartment"
    r"|visa|immigration|deport\w*|interview\w* at|resign\w*|fired|laid off"
    r")\b",
    re.I,
)

# Progressive and perfect-progressive aspect: the thing that separates "writing" from
# "wrote". These are the markers the CV failure case turned on.
_IN_PROGRESS = re.compile(
    r"\b(still|currently|at the moment|these days)\b"
    r"|\b(?:am|are|is|been|being)\s+\w+ing\b"
    r"|\bworking on\b|\bin the middle of\b|\bhalfway\b|\bnearly (?:done|finished)\b",
    re.I,
)

_COMPLETED = re.compile(
    r"\b(finished|completed|submitted|published|shipped|defended|graduated|accepted"
    r"|wrapped up|handed in|got it done|came out)\b",
    re.I,
)

_PLANNED = re.compile(
    r"\b(going to|plan(?:ning)? to|intend to|aim(?:ing)? to|will be|next (?:week|month|year"
    r"|term|semester)|about to|due to)\b",
    re.I,
)

_ABANDONED = re.compile(
    r"\b(gave up|giving up|dropped|abandoned|shelved|no longer|stopped|walked away)\b",
    re.I,
)

_HYPOTHETICAL = re.compile(
    r"\b(if i|were i to|might|maybe|perhaps|considering|thinking about|toying with"
    r"|would probably)\b",
    re.I,
)


def check_claim(
    asserted: AssertionStatus | None,
    source_statuses: list[AssertionStatus],
    stale: bool = False,
) -> tuple[bool, str | None]:
    """Does this sentence claim more completeness than its sources support?

    This is the P6 guarantee in one function, and it is deliberately pure: no model,
    no database, no I/O. Asking a model whether it just overstated something is the
    check that fails silently — it is the same model, with the same reason to think
    its sentence was fine. A rank comparison cannot be talked round.

    Living here rather than inline in the route is what makes it testable without
    quota. The route version could only be exercised by getting the model to
    overstate on demand, which it declines to do exactly when the prompt asks
    plainly — so the check that mattered most was the one never covered.

    Returns (overstates, problem) where problem also covers staleness, which is a
    weaker complaint than overstatement and is therefore only reported when the
    claim is otherwise accurate.
    """
    problems: list[str] = []
    overstates = False

    if asserted is not None and source_statuses:
        best = max(COMPLETENESS_RANK[s] for s in source_statuses)

        # Compare against the *most* complete source, not every source. A sentence can
        # legitimately rest on facts at different stages — "writing a paper, submission
        # planned next month" draws on an in_progress fact and a planned one and
        # describes both correctly. Flagging that would train the user to dismiss the
        # warning, which is the habituation failure (principle 4). An overstatement is
        # a claim that *no* source supports.
        if COMPLETENESS_RANK[asserted] > best:
            overstates = True
            worst = min(source_statuses, key=lambda s: COMPLETENESS_RANK[s])
            problems.append(
                f"written as {asserted.value.replace('_', ' ')}, but the memory "
                f"says {worst.value.replace('_', ' ')}"
            )

    if stale and not overstates:
        problems.append("the memory behind this has not been confirmed recently")

    return overstates, "; ".join(problems) or None


def sensitivity_floor(text: str) -> Sensitivity | None:
    """The least restrictive tier this text may be filed under, or None if unmarked."""
    if _SPECIAL_CATEGORY.search(text):
        return Sensitivity.special_category
    if _HIGH.search(text):
        return Sensitivity.high
    return None


def raise_sensitivity(model_says: Sensitivity, text: str) -> tuple[Sensitivity, str | None]:
    """Take the more restrictive of the model's answer and the regex floor."""
    floor = sensitivity_floor(text)
    if floor is None or SENSITIVITY_RANK[floor] <= SENSITIVITY_RANK[model_says]:
        return model_says, None
    return floor, (
        f"pattern match raised this from {model_says.value.replace('_', ' ')} "
        f"to {floor.value.replace('_', ' ')}"
    )


def status_candidates(text: str) -> set[AssertionStatus]:
    """Which statuses the surface grammar supports. May be empty, may be several."""
    found: set[AssertionStatus] = set()
    if _IN_PROGRESS.search(text):
        found.add(AssertionStatus.in_progress)
    if _COMPLETED.search(text):
        found.add(AssertionStatus.completed)
    if _PLANNED.search(text):
        found.add(AssertionStatus.planned)
    if _ABANDONED.search(text):
        found.add(AssertionStatus.abandoned)
    if _HYPOTHETICAL.search(text):
        found.add(AssertionStatus.hypothetical)
    return found


def status_disagreement(model_says: AssertionStatus, text: str) -> str | None:
    """A reason string when the grammar contradicts the model, else None.

    Only fires when the heuristic is confident *and* opposed: it saw markers, none of
    them support the model's answer, and the disagreement is about completeness rather
    than a near-miss. Returning None is the common and correct case.
    """
    found = status_candidates(text)
    if not found or model_says in found:
        return None

    model_rank = COMPLETENESS_RANK[model_says]
    heuristic_peak = max(COMPLETENESS_RANK[s] for s in found)
    if model_rank <= heuristic_peak:
        return None

    supported = ", ".join(sorted(s.value.replace("_", " ") for s in found))
    return (
        f"the wording reads as {supported}, but it was classified as "
        f"{model_says.value.replace('_', ' ')}"
    )
