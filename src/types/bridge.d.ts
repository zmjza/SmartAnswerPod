export {}
type QrSnapshotPayload = {
  localId: string
  courseName: string
  homeworkName: string
  version: number
  image: string
  capturedAt: string
  appVersion: string
  status: '等待扫码'
}
type UpdateStatePayload = { phase: 'unavailable' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'; version?: string; message?: string; progress?: number }
declare global {
  interface Window {
    kaida?: {
      snapshot: () => Promise<unknown>
      onSnapshot: (cb: (s: unknown) => void) => () => void
      onProgress: (cb: (s: unknown) => void) => () => void
      getSettings: () => Promise<Record<string, unknown>>
      saveSettings: (p: unknown) => Promise<{ ok: boolean; error?: string }>
      onSettingsChanged: (cb: (s: unknown) => void) => () => void
      testConn: () => Promise<{ ok: boolean; error?: string }>
      testConnectivity: () => Promise<{ results: { model: string; ok: boolean; status: string; elapsedMs: number; reason?: string; httpStatus?: number }[]; summary: string; testedAt: string }>
      testConnectivityModel: (model: string) => Promise<{ results: { model: string; ok: boolean; status: string; elapsedMs: number; reason?: string; httpStatus?: number }[]; summary: string; testedAt: string }>
      onConnectivityProgress: (cb: (s: unknown) => void) => () => void
      listAccounts: () => Promise<{ local_id: string; name: string; account: string }[]>
      addAccount: (row: unknown) => Promise<{ ok: boolean; error?: string }>
      updateAccount: (id: string, row: unknown) => Promise<{ ok: boolean; error?: string }>
      removeAccount: (id: string) => Promise<{ ok: boolean }>
      removeAllAccounts: (ids: string[]) => Promise<{ ok: boolean; removed: number; error?: string }>
     importExcel: () => Promise<{ ok: boolean; error?: string; count?: number }>
      parsePastedAccounts: (text: string) => Promise<{ ok: boolean; rows: { name: string; username: string; password: string }[]; errors: { line: number; text: string; reason: string }[]; skippedHeaders: number }>
      confirmPastedAccounts: (rows: { name: string; username: string; password: string }[]) => Promise<{ ok: boolean; imported: number; error?: string }>
      importJson: () => Promise<{ ok: boolean; error?: string; fileName?: string; fileSize?: number; durationMs?: number; added?: number; merged?: number; conflict?: number; skipped?: number; failed?: number }>
      bankAccessStatus: () => Promise<{ ok: boolean; lockedUntil: number; remainingAttempts: number }>
      unlockBank: (password: string) => Promise<{ ok: boolean; lockedUntil: number; remainingAttempts: number }>
      listBankQuestions: (query: { page: number; pageSize: number; courseName?: string; searchMode?: 'fuzzy' | 'exact'; searchText?: string }) => Promise<{ ok: boolean; error?: string; rows: { id: string; qtype: string; stem: string; options: string[]; answer_texts: string[]; course_names: string[]; updated_at: string }[]; total: number; page: number; pageSize: number }>
      listBankCourses: () => Promise<{ ok: boolean; error?: string; courses: string[] }>
      deleteBankQuestions: (ids: string[]) => Promise<{ requestedIds: string[]; deletedIds: string[]; failed: { id: string; reason: string }[]; readbackConfirmed: boolean; error?: string }>
      loginRefresh: (accountIds?: string[]) => Promise<{ ok: boolean; error?: string }>
      startStudent: (id: string) => Promise<{ ok: boolean; error?: string }>
      stopAllStudents: () => Promise<{ ok: boolean }>
      applyStudentSettingsToAll: (id: string) => Promise<{ ok: boolean; updated?: number; failed?: string[]; error?: string }>
      setDisplay: (id: string, mode: string) => Promise<{ ok: boolean; visible: boolean | null; error?: string }>
      setWorkMode: (id: string, mode: string) => Promise<{ ok: boolean; error?: string }>
      setCourseScope: (id: string, scope: string) => Promise<{ ok: boolean; error?: string }>
      setSelectedCourses: (id: string, keys: string[]) => Promise<{ ok: boolean; error?: string; selected?: number; selectedNames?: string[]; selectedKeys?: string[] }>
      startSelectedCourses: () => Promise<{ ok: boolean; error?: string }>
      getHomeworkHistory: (id: string, courseName: string, homeworkName: string) => Promise<{ ok: boolean; error?: string; items: { attempt: number; submittedAt: string; status: string; score: number | null; completed: boolean; viewable: boolean; displayState: 'viewable' | 'ungraded' | 'unfinished' | 'continue_only' | 'no_view' }[] }>
      getHistoryPaperImage: (id: string, courseName: string, homeworkName: string, submittedAt: string) => Promise<{ ok: boolean; error?: string; image?: string }>
      setAnswerRoundLimit: (id: string, limit: number) => Promise<{ ok: boolean; error?: string }>
      openVisual: (id: string) => Promise<{ ok: boolean; error?: string }>
      getQrSnapshot: (id: string) => Promise<{ ok: boolean; error?: string; snapshot?: QrSnapshotPayload }>
      refreshQrSnapshot: (id: string) => Promise<{ ok: boolean; error?: string; snapshot?: QrSnapshotPayload }>
      copyQrSnapshot: (id: string, version: number) => Promise<{ ok: boolean; error?: string }>
      verifyDone: (id: string) => Promise<{ ok: boolean; error?: string }>
     stop: (id: string) => Promise<void>
      minimizeWindow: () => Promise<{ ok: boolean }>
      maximizeWindow: () => Promise<{ ok: boolean; maximized?: boolean }>
      closeWindow: () => Promise<{ ok: boolean }>
      checkForUpdates: () => Promise<UpdateStatePayload>
      updateState: () => Promise<UpdateStatePayload>
      downloadUpdate: () => Promise<UpdateStatePayload>
      installUpdate: () => Promise<UpdateStatePayload>
      onUpdateStatus: (cb: (s: unknown) => void) => () => void
    }
  }
}
