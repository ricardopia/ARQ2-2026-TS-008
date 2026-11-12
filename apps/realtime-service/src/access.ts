import type { AccessResult } from './session.js';
import { accessCheckDuration } from './metrics.js';

/**
 * Asks Core API whether the user has an effective role on the board
 * (spec 3.5 internal access check). Fails closed on any error.
 */
export function createAccessChecker(coreApiUrl: string, internalToken: string, timeoutMs = 3000) {
  return async function checkAccess(boardId: string, userId: string): Promise<AccessResult> {
    const end = accessCheckDuration.startTimer();
    try {
      const res = await fetch(
        `${coreApiUrl}/internal/boards/${encodeURIComponent(boardId)}/access/${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-token': internalToken }, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (res.status === 200) return 'ok';
      if (res.status === 404) return 'forbidden';
      return 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      end();
    }
  };
}
