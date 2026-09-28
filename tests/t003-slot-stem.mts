import assert from 'node:assert/strict'
import { englishSlotStem, englishMatchStem, contentHash } from '../electron/core/hash.ts'

const first = englishSlotStem(' 共享语篇 ', 9, 1, '1. 小题')
assert.equal(first, '共享语篇\n[父题型 9][子题 1] 小题')
assert.notEqual(contentHash('single', first, ['甲', '乙']),
  contentHash('single', englishSlotStem('另一语篇', 9, 1, '1. 小题'), ['甲', '乙']))
assert.equal(englishMatchStem('共享词表', 2, '2. 左项'), '共享词表\n[匹配槽 2] 左项')
console.log('T003 英语子题身份通过')
