/**
 * Cross-session course claim ledger for one automation run.
 *
 * Two-phase protocol so a course is only ever treated as "covered" after it
 * was actually downloaded:
 * - reserve(): first session to see a course wins; later sessions skip it.
 * - confirm(): called after the owner's session successfully downloaded the
 *   course. Only confirmed courses count as covered.
 * - release(): called when the owner's session fails or is cancelled before
 *   confirming, so another session can still pick the course up. This keeps
 *   the course state fresh: a course that was never downloaded is never
 *   reported as already covered.
 */
export class AutomationClaimLedger {
  private readonly reserved = new Map<string, string>();
  private readonly confirmed = new Set<string>();

  /** Reserve a course for a G-number. Returns false when already taken. */
  reserve(courseId: string, gnumber: string): boolean {
    if (this.reserved.has(courseId)) return false;
    this.reserved.set(courseId, gnumber);
    return true;
  }

  ownerOf(courseId: string): string | undefined {
    return this.reserved.get(courseId);
  }

  isConfirmed(courseId: string): boolean {
    return this.confirmed.has(courseId);
  }

  confirm(courseId: string): void {
    if (this.reserved.has(courseId)) this.confirmed.add(courseId);
  }

  /** Release one reservation (course failed or session cancelled). */
  release(courseId: string): boolean {
    this.confirmed.delete(courseId);
    return this.reserved.delete(courseId);
  }

  /**
   * Release every unconfirmed reservation owned by a G-number (e.g. its
   * session crashed). Returns the released course ids.
   */
  releaseByOwner(gnumber: string): string[] {
    const released: string[] = [];
    for (const [courseId, owner] of this.reserved) {
      if (owner === gnumber && !this.confirmed.has(courseId)) {
        this.reserved.delete(courseId);
        released.push(courseId);
      }
    }
    return released;
  }

  confirmedCount(): number {
    return this.confirmed.size;
  }
}
