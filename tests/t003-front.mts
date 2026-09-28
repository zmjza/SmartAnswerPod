import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageCountForCourses, pageForCourse, pageSlice } from '../electron/core/course-pager.ts'
import * as pager from '../electron/core/course-pager.ts'
import * as kaida from '../src/useKaida.ts'

test('学生选择按本地身份保持，不因重排或短暂缺项落到别人身上', () => {
  const rows = [{ local_id: 'a' }, { local_id: 'b' }]
  assert.equal(kaida.resolveSelectedStudentId?.('b', rows), 'b')
  assert.equal(kaida.resolveSelectedStudentId?.('b', [...rows].reverse()), 'b')
  assert.equal(kaida.resolveSelectedStudentId?.('b', [rows[0]]), 'b')
  assert.equal(kaida.resolveSelectedStudentId?.('', rows), 'a')
})

test('完整课程列表按七门分页，缩减时页码收敛', () => {
  const courses = Array.from({ length: 8 }, (_, i) => `课程${i + 1}`)
  assert.equal(pageCountForCourses([], 7), 1)
  assert.deepEqual(pageSlice([], 7, 1), [])
  assert.equal(pageCountForCourses(courses.slice(0, 7), 7), 1)
  assert.equal(pageCountForCourses(courses, 7), 2)
  assert.deepEqual(pageSlice(courses, 7, 2), ['课程8'])
  assert.deepEqual(pageSlice(courses.slice(0, 7), 7, 2), courses.slice(0, 7))
  const fifteen = Array.from({ length: 15 }, (_, i) => `课程${i + 1}`)
  assert.equal(pageCountForCourses(fifteen.slice(0, 14), 7), 2)
  assert.equal(pageCountForCourses(fifteen, 7), 3)
  assert.deepEqual(pageSlice(fifteen, 7, 3), ['课程15'])
})

test('同名课程按稳定 key 定位页码', () => {
  const courses = Array.from({ length: 8 }, (_, i) => ({ name: i === 7 ? '同名课' : `课程${i}`, key: `key-${i}` }))
  courses[0].name = '同名课'
  assert.equal(pageForCourse(courses, 7, 'key-7'), 2)
  assert.equal(pageForCourse(courses, 7, '同名课'), 1)
})

test('作业分页跨两组保持原顺序和分组标题', () => {
  const groups = [
    { title: '网上记分作业', rows: ['A', 'B', 'C'] },
    { title: '阶段性测验', rows: ['D', 'E'] },
  ]
  assert.deepEqual(pager.pageGroups?.(groups, 4, 1), [
    { title: '网上记分作业', rows: ['A', 'B', 'C'] },
    { title: '阶段性测验', rows: ['D'] },
  ])
  assert.deepEqual(pager.pageGroups?.(groups, 4, 2), [{ title: '阶段性测验', rows: ['E'] }])
  assert.deepEqual(pager.pageGroups?.(groups, 4, 1).flatMap((group) => group.rows), ['A', 'B', 'C', 'D'])
  assert.deepEqual(pager.pageGroups?.(groups, 4, 3), [{ title: '阶段性测验', rows: ['E'] }])
  assert.deepEqual(pager.pageGroups?.([], 4, 1), [])
})
