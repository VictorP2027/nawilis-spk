import { config } from './config.js';

export type AlertLevel = 'page' | 'ops' | 'info';

export interface Alert {
  level: AlertLevel;
  code: string;
  message: string;
  branchCode?: string;
  data?: Record<string, unknown>;
}

/**
 * Alert routing. `page` = wake an engineer; `ops` = HO recovery desk / supervisors;
 * `info` = log only. WhatsApp is the real channel for branch supervisors — they
 * live in it; a dashboard nobody opens is not a notification channel.
 */
export async function fireAlert(a: Alert): Promise<void> {
  const line = `[ALERT:${a.level}] ${a.code}${a.branchCode ? ` (${a.branchCode})` : ''}: ${a.message}`;
  // Always log.
  if (a.level === 'page') console.error(line, a.data ?? '');
  else console.warn(line, a.data ?? '');

  if ((a.level === 'ops' || a.level === 'page') && config.alert.whatsappEnabled && config.alert.whatsappUrl) {
    // Utility-template send via a WhatsApp Business Platform provider.
    await fetch(config.alert.whatsappUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.alert.whatsappToken}` },
      body: JSON.stringify({ code: a.code, level: a.level, branch: a.branchCode, message: a.message }),
    }).catch((e) => console.error('WhatsApp alert failed:', e));
  }
}
