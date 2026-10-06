import type { PendingDecision } from "../terminal/types";

/**
 * Guards the one gesture that can run a command on somebody's computer.
 *
 * A swipe is only taken as an answer when:
 *
 *   - the decision screen for *this very request* has actually been drawn —
 *     not an error screen that happens to hide a pending request, and not an
 *     older request that has since been replaced;
 *   - it has been on the display for a moment (`ARM_MS`). A swipe that was
 *     already under way when a new request popped up must not approve it;
 *   - no other answer is still on its way (a double swipe sends one answer);
 *   - the request was not answered already. A reconnecting stream may deliver
 *     the same request again, and the answer must not be sent twice.
 */
export const DECISION_ARM_MS = 800;

export class DecisionGate {
  #shown: PendingDecision | null = null;
  #shownAt = 0;
  #inFlight = false;
  readonly #answered = new Set<string>();

  /** Call after a draw: what the decision screen now shows, or null. */
  displayed(pending: PendingDecision | null, now: number): void {
    if (pending === this.#shown) return;
    this.#shown = pending;
    this.#shownAt = now;
  }

  /** True when a request with this id was already answered from here. */
  answered(pending: PendingDecision | null): boolean {
    return Boolean(pending?.id && this.#answered.has(pending.id));
  }

  /** Claims the right to send one answer for `pending`; false means ignore the swipe. */
  begin(pending: PendingDecision | null, now: number): boolean {
    if (!pending || pending.kind !== "permission") return false;
    if (this.#inFlight) return false;
    if (pending !== this.#shown) return false;
    if (now - this.#shownAt < DECISION_ARM_MS) return false;
    if (this.answered(pending)) return false;
    this.#inFlight = true;
    this.#shown = null;
    if (pending.id) this.#answered.add(pending.id);
    return true;
  }

  /** The answer has been delivered or has failed. */
  end(): void { this.#inFlight = false; }

  get busy(): boolean { return this.#inFlight; }
}
