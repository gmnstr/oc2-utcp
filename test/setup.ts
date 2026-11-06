import { setDefaultTimeout } from "bun:test";

/**
 * Bun's default per-test budget is 5000 ms. The in-memory suites finish in one
 * to two seconds on an idle machine, but under load a single test can cross
 * that line and fail as a supposed code defect — which is exactly how a
 * verification run misreports "harness integrity" failures. One explicit
 * default, far above the observed worst case (~2 s for `gaps.test.ts` on an
 * idle container), removes that ambiguity without loosening any assertion:
 * the suites that genuinely need more (the real-host integration and
 * permission tests) still pass their own budgets at the call site.
 */
setDefaultTimeout(60_000);
