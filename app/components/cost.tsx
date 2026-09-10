import type { CostKnowledge } from "../../lib/burn-data";
import { formatUsd } from "../../lib/token-math";

// --- Cost: the basis qualifier and the four ways a day can be costed --------

/**
 * The qualifier that travels with every dollar figure on the page. It uses the
 * same pill mechanism as the exact/estimated fidelity labels because it answers
 * the same kind of question — how much to trust this number — and because a pill
 * stays attached to the figure when someone crops a screenshot. A footnote
 * would not.
 */
export function BasisPill() {
  return (
    <span className="pill counterfactual" title="Counterfactual at current standard API list rates; not actual subscription spending.">
      at API list
    </span>
  );
}

/** Large cost figure. Renders each CostKnowledge state as itself, never as $0. */
export function CostAmount({ cost, className }: { cost: CostKnowledge; className?: string }) {
  if (cost.kind === "not-measured") {
    return (
      <p className={className}>
        <span className="ledgerAmountInk costNil">&mdash;</span>
        <span className="ledgerUnit">nothing measured to cost</span>
      </p>
    );
  }

  if (cost.kind === "unknown") {
    return (
      <p className={className}>
        <span className="ledgerAmountInk costNil">Not priced</span>
        <span className="ledgerUnit">
          {cost.unpricedTokens.toLocaleString("en-US")} tokens with no rate
        </span>
      </p>
    );
  }

  const text = formatUsd(cost.usd);
  return (
    <p className={className}>
      {cost.kind === "lower-bound" && <span className="costBound">at least</span>}
      <span className="ledgerAmountStack">
        <span className="ledgerGhost" aria-hidden="true">
          {text}
        </span>
        <span className="ledgerAmountInk">{text}</span>
      </span>
    </p>
  );
}

/** Compact cost for table cells. Same four states, one line. */
export function CellCost({ cost }: { cost: CostKnowledge }) {
  if (cost.kind === "not-measured") {
    return <span className="muted" title="Estimates only — there was no measured usage to price">&mdash;</span>;
  }
  if (cost.kind === "unknown") {
    return (
      <span className="muted" title={`${cost.unpricedTokens.toLocaleString("en-US")} tokens with no rate card`}>
        not priced
      </span>
    );
  }
  return (
    <span title={cost.kind === "lower-bound" ? "Lower bound — some tokens on this day are unpriced" : undefined}>
      {cost.kind === "lower-bound" ? "≥ " : ""}
      {formatUsd(cost.usd)}
    </span>
  );
}

/** States plainly what the headline figure is missing, when it is missing any. */
export function UnpricedNote({ cost, unattributed }: { cost: CostKnowledge; unattributed: number }) {
  const unpriced = cost.kind === "unknown" || cost.kind === "lower-bound" ? cost.unpricedTokens : 0;
  if (unpriced === 0 && unattributed === 0) return null;

  return (
    <p className="ledgerWarn">
      <span className="pill unpriced">lower bound</span>
      {unpriced.toLocaleString("en-US")} tokens have no rate
      {unattributed >= unpriced
        ? " and no recorded model or type split"
        : unattributed > 0
        ? `, ${unattributed.toLocaleString("en-US")} of them with no recorded model or type split`
        : ""}
      . Their cost is unknown and is excluded from the priced subtotal. Unattributed tokens are also excluded from the type chart.
    </p>
  );
}
