/** Supabase connects lazily inside the client, so there's nothing to open. */
export function db(): void {
  /* no-op — kept so route handlers can keep calling db() uniformly */
}
