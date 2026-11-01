import type { NoqrHistoryRecord } from './history.ts'

export function newNoqrHistoryCache() {
  return new Map<string, NoqrHistoryRecord[]>()
}
