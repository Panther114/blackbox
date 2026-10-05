/**
 * Process-local workflow lock.
 *
 * Scope: this lock serializes concurrent agent-service calls (MCP) inside one
 * process. The GUI additionally enforces a single app instance, and CLI runs
 * are user-driven, so cross-process locking is intentionally not used — a
 * lock file would add stale-lock failure modes for no expected benefit.
 */
let activeOwner: string | null = null;

export class WorkflowBusyError extends Error {
  constructor(owner: string | null) {
    super(`A Blackboard workflow is already running${owner ? ` (${owner})` : ''}. Try again when it finishes.`);
    this.name = 'WorkflowBusyError';
  }
}

export function acquireWorkflowLock(owner: string): () => void {
  if (activeOwner) throw new WorkflowBusyError(activeOwner);
  activeOwner = owner;
  return () => {
    if (activeOwner === owner) activeOwner = null;
  };
}

export function getWorkflowLockStatus(): { busy: boolean; owner?: string } {
  return activeOwner ? { busy: true, owner: activeOwner } : { busy: false };
}
