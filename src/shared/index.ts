// Vendored copy of `@clawborrator/shared` from the hub_v1 repo. Source
// of truth: https://github.com/clawborrator/hub_v1/tree/main/shared/src.
// These types describe the hub's REST + WS wire shapes; kept in sync
// by hand. Drift surfaces as a typecheck failure here when a hub
// deploy ships a newer schema than the CLI was built against.

export * from './api-types.js';
export * from './ws-protocol.js';
