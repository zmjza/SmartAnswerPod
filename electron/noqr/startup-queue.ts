import { NoqrSessionError } from './session.ts'

const startupQueues = new Map<string, Promise<void>>()

/**
 * Serialize same-account page/session startup while leaving other accounts and
 * already-ready answer pages free to run concurrently.
 */
export function withNoqrStartupLock<T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = startupQueues.get(key) || Promise.resolve()
  let release = () => {}
  const slot = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => slot)
  startupQueues.set(key, tail)

  const running = previous.catch(() => undefined).then(() => {
    if (signal?.aborted) throw new NoqrSessionError('stopped', '任务已停止')
    return task()
  })
  return running.finally(() => {
    release()
    if (startupQueues.get(key) === tail) startupQueues.delete(key)
  })
}
