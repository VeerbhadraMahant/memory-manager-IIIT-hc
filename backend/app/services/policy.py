"""How a raw extraction candidate becomes a stored item.

This module is where three of the design principles actually take effect, so the
thresholds are named constants rather than inline magic numbers — they are meant to
be argued with.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models import ReviewState, Scope, Sensitivity, SourceType

# Principle 2, interruption budget. Auto-accept is deliberately narrow: only facts
# the user *said*, that we are confident about, in the least sensitive tier. Everything
# else earns a prompt. Consent fatigue destroys the thing consent protects, but so does
# auto-accepting something the user would have objected to.
AUTO_ACCEPT_MIN_CONFIDENCE = 0.85
AUTO_ACCEPT_SENSITIVITY = {Sensitivity.low}

# D3, asymmetric error costs. Below this, we do not trust the block assignment at all
# and file the item in the fallback block, which is the *most* restrictive one.
TRUST_BLOCK_ABOVE = 0.60

# Principle 3, friction proportional to irreversibility. Sensitive-but-legitimate
# disclosures are not blocked and not warned about — they are simply not persisted by
# default. The user can promote them, which is a decision made with the item in front
# of them rather than mid-sentence.
SESSION_BY_DEFAULT = {Sensitivity.high, Sensitivity.special_category}


@dataclass
class Disposition:
    review_state: ReviewState
    scope: Scope
    needs_review: bool
    block_name: str
    # Shown verbatim on the review card. The user should never have to guess why an
    # item is in front of them, and "why is this here" is the first question a
    # consent prompt has to answer to avoid becoming a reflex click.
    reason: str


def decide(
    *,
    source_type: SourceType,
    sensitivity: Sensitivity,
    confidence: float,
    proposed_block: str,
    known_blocks: set[str],
    fallback_block: str,
) -> Disposition:
    reasons: list[str] = []

    # --- block assignment -------------------------------------------------
    block = proposed_block if proposed_block in known_blocks else fallback_block
    if block != proposed_block:
        reasons.append(f"'{proposed_block}' isn't one of your blocks")
    if confidence < TRUST_BLOCK_ABOVE and block != fallback_block:
        block = fallback_block
        reasons.append("low confidence, filed in the most restrictive block")

    # --- scope ------------------------------------------------------------
    scope = Scope.session if sensitivity in SESSION_BY_DEFAULT else Scope.persistent
    if scope is Scope.session:
        reasons.append(f"{sensitivity.value.replace('_', ' ')} — this session only unless you keep it")

    # --- review vs. auto-accept -------------------------------------------
    if source_type is SourceType.inferred:
        reasons.append("inferred, not something you said")
        return Disposition(ReviewState.pending, scope, True, block, "; ".join(reasons))

    if sensitivity not in AUTO_ACCEPT_SENSITIVITY:
        if not reasons:
            reasons.append(f"{sensitivity.value.replace('_', ' ')} category")
        return Disposition(ReviewState.pending, scope, True, block, "; ".join(reasons))

    if confidence < AUTO_ACCEPT_MIN_CONFIDENCE:
        reasons.append(f"confidence {confidence:.2f}")
        return Disposition(ReviewState.pending, scope, True, block, "; ".join(reasons))

    return Disposition(
        ReviewState.auto_accepted, scope, False, block,
        "stated, low sensitivity, high confidence — accepted without interrupting you",
    )
