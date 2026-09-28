export function pageCountForCourses<T>(courses: T[], pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize))
  return Math.max(1, Math.ceil(courses.length / size))
}

export function pageSlice<T>(courses: T[], pageSize: number, page: number): T[] {
  const size = Math.max(1, Math.floor(pageSize))
  const current = Math.min(Math.max(1, Math.floor(page)), pageCountForCourses(courses, size))
  return courses.slice((current - 1) * size, current * size)
}

export function pageForCourse(courses: { name: string; key?: string }[] | string[], pageSize: number, identity: string): number {
  const byKey = courses.findIndex((course) => typeof course !== 'string' && course.key === identity)
  const index = byKey >= 0 ? byKey : courses.findIndex((course) => (typeof course === 'string' ? course : course.name) === identity)
  return index < 0 ? 1 : Math.floor(index / Math.max(1, Math.floor(pageSize))) + 1
}

export function pageGroups<T>(groups: { title: string; rows: T[] }[], pageSize: number, page: number): { title: string; rows: T[] }[] {
  const all = groups.flatMap((group) => group.rows.map((row) => ({ title: group.title, row })))
  const visible = pageSlice(all, pageSize, page)
  return visible.reduce<{ title: string; rows: T[] }[]>((result, item) => {
    const last = result.at(-1)
    if (last?.title === item.title) last.rows.push(item.row)
    else result.push({ title: item.title, rows: [item.row] })
    return result
  }, [])
}
