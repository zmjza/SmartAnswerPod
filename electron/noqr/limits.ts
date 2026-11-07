// Long safety ceilings only stop an operation that never reaches a verified
// state. They never refresh or recreate an answer page.
export const NOQR_ANSWER_BOOT_HARD_WAIT_MS = 240_000
export const NOQR_ANSWER_CARD_HARD_WAIT_MS = 240_000
export const NOQR_ANSWER_PAGE_ADVANCE_HARD_WAIT_MS = 240_000
export const NOQR_HISTORY_RESPONSE_HARD_WAIT_MS = 240_000
export const NOQR_MUTATION_RESPONSE_HARD_WAIT_MS = 240_000
export const NOQR_RETURN_HARD_WAIT_MS = 240_000
export const NOQR_SUBMIT_HARD_WAIT_MS = 240_000
// A submitted homework can remain "待批阅" for a long time. Do not hold the
// account forever when the site never exposes a fresh score; record the
// uncertainty and continue instead.
export const NOQR_SCORE_PENDING_WAIT_MS = 600_000

export function withNoqrHardDeadline<T>(
  task: Promise<T>,
  deadlineMs: number,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(50, Number(deadlineMs) || 0)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      finish(() => {
        Promise.resolve()
          .then(onTimeout)
          .then(resolve, reject)
      })
    }, timeoutMs)
    task.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}
