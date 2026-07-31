export * from './sink.js';
export * from './selmap.js';
export * from './locators.js';
export * from './session.js';
export * from './rpaSink.js';
export * from './apiSink.js';
export * from './manualSink.js';
export * from './payload.js';

import { RpaSink } from './rpaSink.js';
import { ApiSink, type ApiConfig } from './apiSink.js';
import { ManualSink } from './manualSink.js';
import { TurbolySession } from './session.js';
import type { ServiceOrderSink } from './sink.js';
import type { PushMode } from '../types.js';

export interface SinkFactoryConfig {
  mode: PushMode;
  branchCode: string;
  baseUrl: string;
  stateDir: string;
  userAgentSuffix: string;
  screenshotDir?: string;
  api?: ApiConfig;
}

/**
 * Build the active ingress sink. Swapping worlds (W1/W2/W3) is this one call.
 */
export async function createSink(cfg: SinkFactoryConfig): Promise<ServiceOrderSink> {
  switch (cfg.mode) {
    case 'api':
      if (!cfg.api) throw new Error('PUSH_MODE=api requires api config');
      return new ApiSink(cfg.api);
    case 'rpa': {
      const session = new TurbolySession({
        baseUrl: cfg.baseUrl,
        stateDir: cfg.stateDir,
        userAgentSuffix: cfg.userAgentSuffix,
        branchCode: cfg.branchCode,
      });
      await session.start();
      return new RpaSink(session, { screenshotDir: cfg.screenshotDir });
    }
    case 'manual':
    default:
      return new ManualSink();
  }
}
