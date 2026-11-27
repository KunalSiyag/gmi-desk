// Chat's streams moved to the GMI gateway (harness.md §4.8). Kept only for test/auth/connect-inference.test.ts,
// which imports ROUTER_URL from here; delete once that import points at services/gateway/body-router.
export { ROUTER_URL } from '../gateway/body-router';
