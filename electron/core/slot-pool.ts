import { slotCountsInToolbar, type SlotState } from './states.ts'

export class SlotPool {
  limit: number
  private slots = new Map<string, SlotState>()
  private queueTickets = new Map<string, number>()
  private nextQueueTicket = 1
  constructor(limit: number) {
    this.limit = limit
  }

  setLimit(n: number) {
    this.limit = Math.max(1, n)
  }

  get(id: string): SlotState {
    return this.slots.get(id) ?? 'queued'
  }

  has(id: string): boolean {
    return this.slots.has(id)
  }

  toolbarCount(): number {
    let n = 0
    for (const s of this.slots.values()) if (slotCountsInToolbar(s)) n++
    return n
  }

  request(id: string): SlotState {
    const cur = this.slots.get(id)
    if (cur === 'launching' || cur === 'occupied' || cur === 'occupying_verify' || cur === 'closing') return cur
    if (this.toolbarCount() >= this.limit) {
      if (cur === 'queued') return 'queued'
      this.slots.set(id, 'queued')
      this.queueTickets.set(id, this.nextQueueTicket++)
      return 'queued'
    }
    if (cur === 'queued' && this.earliestQueuedId() !== id) return 'queued'
    this.queueTickets.delete(id)
    this.slots.set(id, 'launching')
    return 'launching'
  }

  occupy(id: string) {
    this.slots.set(id, 'occupied')
  }

  occupyingVerify(id: string) {
    this.slots.set(id, 'occupying_verify')
  }

  closing(id: string) {
    this.queueTickets.delete(id)
    this.slots.set(id, 'closing')
  }

  release(id: string): boolean {
    const changed = this.slots.get(id) !== 'released'
    this.queueTickets.delete(id)
    this.slots.set(id, 'released')
    return changed
  }

  /** 暂停/需验证不得把名额让给排队号 */
  promoteQueued(): string | null {
    if (this.toolbarCount() >= this.limit) return null
    const selected = this.earliestQueuedId()
    if (selected) {
      this.queueTickets.delete(selected)
      this.slots.set(selected, 'launching')
      return selected
    }
    return null
  }

  private earliestQueuedId(): string | null {
    let selected: string | null = null
    let selectedTicket = Number.POSITIVE_INFINITY
    for (const [id, state] of this.slots) {
      if (state !== 'queued') continue
      const ticket = this.queueTickets.get(id) ?? Number.POSITIVE_INFINITY
      if (ticket < selectedTicket) {
        selected = id
        selectedTicket = ticket
      }
    }
    return selected
  }
}
