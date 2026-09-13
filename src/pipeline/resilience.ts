import { TwinExpiredError, TwinStubError } from '../apps/types.js';
import type { TraceContext } from '../observability/tracer.js';

/** A run that lost a twin twice. The attempt is `degraded` and counted as a failure (PRD 7.1, E27). */
export class DegradedRunError extends Error {
  constructor(readonly app: string) {
    super(`${app} twin expired twice; attempt degraded`);
    this.name = 'DegradedRunError';
  }
}

/** On a 410, extend the twin and retry once. A stub hit fails loudly (E28). */
export async function withTwinRetry<T>(app: string, name: string, fn: () => Promise<T>, extend: () => Promise<void>, trace: TraceContext): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TwinStubError) {
      trace.tool(name, { app }, undefined, `stub hit ${err.path}`);
      throw err;
    }
    if (!(err instanceof TwinExpiredError)) throw err;
    trace.tool(name, { app }, undefined, 'twin returned 410; extending and retrying once');
    await extend();
    try {
      return await fn();
    } catch (again) {
      if (again instanceof TwinExpiredError) {
        trace.tool(name, { app }, undefined, 'twin returned 410 again; attempt degraded');
        throw new DegradedRunError(app);
      }
      throw again;
    }
  }
}
