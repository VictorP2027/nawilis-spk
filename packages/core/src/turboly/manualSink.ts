import type { ServiceOrderSink, PushContext, PushResult, VerifyResult, TurbolyServiceOrderPayload } from './sink.js';
import type { SpkDoc } from '../types.js';

/**
 * W3 — no automation. Records that a human must enter the SO, and stores the
 * doc number they write back. Also serves as rungs 2/3 of the degradation
 * ladder: when the browser can't be driven, we still capture and produce a
 * keyboard-ordered worksheet for the HO recovery desk (built in the web app).
 *
 * pushServiceOrder here is a no-op that parks the record for manual handling.
 */
export class ManualSink implements ServiceOrderSink {
  readonly mode = 'manual' as const;

  async pushServiceOrder(_payload: TurbolyServiceOrderPayload, _ctx: PushContext): Promise<PushResult> {
    return {
      ok: false,
      serviceOrderNo: null,
      workOrderNo: null,
      verified: null,
      failureClass: 'data',
      error: 'MANUAL_MODE: awaiting human entry into Turboly',
    };
  }

  async verifyByToken(_doc: SpkDoc): Promise<VerifyResult> {
    // In manual mode, verification is the human typing the Turboly doc no back
    // into the console; there is nothing to read programmatically.
    return { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };
  }

  async canary(): Promise<{ ok: boolean; controlHash: string }> {
    return { ok: true, controlHash: 'manual' };
  }
}
