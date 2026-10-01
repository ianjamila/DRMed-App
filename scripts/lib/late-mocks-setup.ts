// Opt-in vitest setup (only loaded by scripts/lib/vitest.late-mocks.config.ts,
// i.e. `npm run test:stress -- --late-mocks <ms>`). The normal config never
// lists it, and it is not named *.test.ts, so `vitest run` never picks it up.
//
// Why it exists: a test that asserts synchronously right after
// `await user.click(...)` on state that only lands after a mocked server action
// resolves (and its post-await transition commits) passes on a fast machine and
// flakes under CPU load. Making every mockResolvedValue / mockResolvedValueOnce
// resolve LATE_MOCKS_MS late turns that load-dependent flake into a
// deterministic failure, so such races are found without needing a loaded box.
//
// NOT delayed: vi.spyOn, automocks (vi.mock without a factory), and
// mockReturnValue(Promise...) - only vi.fn()'s mockResolvedValue/Once are.
//
// Tests that drive fake timers (vi.useFakeTimers) may hang or fail with this
// on, because the delay is a real setTimeout - run those with it off.
import { vi } from "vitest";

const ms = Number(process.env.LATE_MOCKS_MS ?? 0);

if (Number.isFinite(ms) && ms > 0) {
  const late = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  type Loose = { mockResolvedValue: unknown; mockResolvedValueOnce: unknown; mockImplementation: (f: () => unknown) => unknown; mockImplementationOnce: (f: () => unknown) => unknown };
  const realFn = vi.fn.bind(vi) as unknown as (...args: unknown[]) => Loose;
  (vi as { fn: unknown }).fn = (...args: unknown[]) => {
    const mock = realFn(...args);
    mock.mockResolvedValue = (value: unknown) => mock.mockImplementation(() => late(value));
    mock.mockResolvedValueOnce = (value: unknown) => mock.mockImplementationOnce(() => late(value));
    return mock;
  };
}
