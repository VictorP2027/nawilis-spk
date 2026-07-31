import type { PipelineState } from './types.js';

/**
 * The legal state-transition graph.
 *
 * ENFORCEMENT RULE (non-negotiable): every state change is a
 * `findOneAndUpdate` whose filter includes the expected current state.
 * Never `updateOne({_id})` on `state`. That compare-and-swap is the only
 * thing that makes concurrent push workers safe against double-transition.
 *
 *   captured → extracted → needs_review → validated → queued → pushing → pushed → confirmed
 *       │          │            │  ▲                    ▲        │          │         │
 *       │          │            └──┘ edit loop          │        │          │         │
 *       │          └→ needs_review (all docs)   retry ──┤        │          │         │
 *       │                                      failed ←─┘        │          │         │
 *       └──────────→ manual_intervention ←──────┴───────────────┴──────────┘         │
 *                          │                                                          │
 *                          ├→ validated (fixed)      confirmed → amend_pending ←──────┘
 *                          ├→ voided (terminal)                       │
 *                          └→ superseded (terminal)                   └→ pushing
 */
export const TRANSITIONS: Record<PipelineState, readonly PipelineState[]> = {
  captured: ['extracted', 'manual_intervention', 'voided'],
  extracted: ['needs_review', 'manual_intervention'],
  needs_review: ['validated', 'needs_review', 'manual_intervention', 'voided', 'superseded'],
  // Validated data parks in the DB; it is NOT queued for Turboly until a mechanic
  // is assigned. A customer who declines the work goes voided from here.
  validated: ['awaiting_assignment', 'needs_review', 'manual_intervention'],
  awaiting_assignment: ['queued', 'manual_intervention', 'voided', 'superseded'],
  queued: ['pushing', 'manual_intervention', 'failed'],
  pushing: ['pushed', 'failed', 'manual_intervention'],
  pushed: ['confirmed', 'failed', 'manual_intervention'],
  confirmed: ['amend_pending'],
  failed: ['queued', 'manual_intervention', 'voided'],
  manual_intervention: ['validated', 'queued', 'voided', 'superseded'],
  amend_pending: ['pushing', 'manual_intervention'],
  voided: [],
  superseded: [],
};

export function canTransition(from: PipelineState, to: PipelineState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: PipelineState,
    public readonly to: PipelineState,
  ) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
