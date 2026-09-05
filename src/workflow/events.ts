export type WorkflowEventName =
  | 'login:start'
  | 'login:success'
  | 'login:failure'
  | 'courses:discovered'
  | 'files:discovery:start'
  | 'files:discovery:progress'
  | 'files:discovery:complete'
  | 'files:metadata:progress'
  | 'files:metadata:complete'
  | 'files:ready'
  | 'instructions:discovery:start'
  | 'instructions:discovery:progress'
  | 'instructions:discovery:complete'
  | 'instructions:write:start'
  | 'instructions:write:progress'
  | 'instructions:write:complete'
  | 'download:start'
  | 'download:progress'
  | 'download:complete'
  | 'download:error'
  | 'download:skip'
  | 'download:rejected'
  | 'summary:ready';

export interface WorkflowEvent<T = unknown> {
  type: WorkflowEventName;
  payload: T;
}

