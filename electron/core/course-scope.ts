export type CourseScope = 'all' | 'selected'
export type SelectedRunReadiness = 'scanning' | 'empty' | 'ready'

export function selectCoursesForRun<T extends { name: string; key?: string }>(courses: T[], scope: CourseScope, selectedNames: string[]): T[] {
  if (scope === 'all') return [...courses]
  const selected = new Set(selectedNames)
  return courses.filter((course) => selected.has(course.key || course.name) || selected.has(course.name))
}

export function selectedRunReadiness(students: { awaiting: boolean; selectedCount: number }[]): SelectedRunReadiness {
  if (!students.length || students.some((student) => !student.awaiting)) return 'scanning'
  return students.some((student) => student.selectedCount > 0) ? 'ready' : 'empty'
}
