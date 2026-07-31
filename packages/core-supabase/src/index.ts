export * from './client.js';
export * from './store.js';
export * from './ingest.js';

// Re-export the storage-agnostic domain so the web app imports from one place.
export {
  SpkIntakeInput, toNawilisRow, NAWILIS_COLUMNS, isUsedInServiceOrder,
  REF_BRANCHES, REF_SERVICES,
  type SpkDoc, type Finding, type SpkIntakeInputT,
} from '@spk/core';
