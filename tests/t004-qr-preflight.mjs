import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { qrPreflight, REVIEWED_QR_SOURCES } from './helpers/t004-qr-preflight.mjs'
import * as preflightModule from './helpers/t004-qr-preflight.mjs'

// Synthetic sources exercise the matcher; they are never school allowlist entries.
const sources = {
  doHomework: 'function doHomework(ele) { if ("" ) { alert("test warning"); return false; } if (isStudent === "False") { handleHref(ele); return false; } if (validateCheckStatus()) { handleHref(ele); return false; } if (isIndustryCollege === "True") { return false; } showQRCodeDialog(ele); return false; }',
  throttleHref: 'function throttleHref() { throw new Error("must not call"); }',
  validateCheckStatus: 'function validateCheckStatus() { return getItem("validateResult_"); }',
  getItem: 'function getItem(key) { return localStorage.getItem(key); }',
  showQRCodeDialog: 'function showQRCodeDialog() { throw new Error("must not call"); }',
  popQRCodeDialog: 'function popQRCodeDialog() { throw new Error("must not call"); }',
  checkQRCode: 'function checkQRCode() { throw new Error("must not call"); }',
  handleHref: 'function handleHref() { throw new Error("must not call"); }',
  refreshQRCode: 'function refreshQRCode() { throw new Error("must not call"); }',
  setItem: 'function setItem() { throw new Error("must not call"); }',
  openurl: 'function openurl() { throw new Error("must not call"); }',
}

function inspect({ changed = {}, flags = {}, keys = [], button = {}, qrCode = null, templates = sources, cameraState = '' } = {}) {
  const context = vm.createContext({ isStudent: 'True', isIndustryCollege: 'False', qrCode, ...flags,
    localStorage: { length: keys.length, key: index => keys[index] },
    document: {
      querySelector: () => ({ getAttribute: name => name === 'onclick' ? 'return doHomework(this);' : null,
        hasAttribute: () => false, classList: { contains: () => false }, ...button }),
      querySelectorAll: () => [],
    } })
  context.window = context
  for (const [name, source] of Object.entries({ ...sources, ...changed }))
    vm.runInContext('window[' + JSON.stringify(name) + '] = (' + source + ')', context)
  context.templates = templates
  context.cameraState = cameraState
  return vm.runInContext('(' + qrPreflight.toString() + ')(templates, cameraState)', context)
}

function inspectIndustry({ changed = {}, flags = {}, ...options } = {}) {
  const templates = preflightModule.REVIEWED_INDUSTRY_QR_SOURCES
  return inspect({ templates, cameraState: 'denied', ...options,
    changed: { ...templates, ...changed }, flags: { isIndustryCollege: 'True', token: 'private-test-token', ...flags } })
}

test('matches reviewed complete sources without invoking any school helper', () => {
  assert.equal(inspect().safe, true)
})

test('the complete eleven observed templates pass in a VM without calling their bodies', () => {
  assert.equal(Object.keys(REVIEWED_QR_SOURCES).length, 11)
  const changed = { ...REVIEWED_QR_SOURCES,
    showQRCodeDialog: REVIEWED_QR_SOURCES.showQRCodeDialog.replace('[private-digits]', '20200101') }
  assert.equal(inspect({ changed, templates: REVIEWED_QR_SOURCES }).safe, true)
  assert.equal(inspect({ changed: { ...changed, refreshQRCode: changed.refreshQRCode.replace('checkQRCode($ele);', 'handleHref($ele);') },
    templates: REVIEWED_QR_SOURCES }).safe, false)
  assert.equal(inspect({ changed: { ...changed, setItem: 'undefined' }, templates: REVIEWED_QR_SOURCES }).safe, false)
})

test('only the reviewed unreachable alert literal may vary; its guard must remain empty', () => {
  const doHomework = REVIEWED_QR_SOURCES.doHomework
  const templates = { ...sources, doHomework }
  assert.equal(inspect({ templates, changed: { doHomework: doHomework.replace('alert("")', 'alert("safe test warning")') } }).safe, true)
  assert.equal(inspect({ templates, changed: { doHomework: doHomework.replace('if ("")', 'if ("blocked")') } }).safe, false)
})

test('only the known dated comment is ignored; executable numbers remain exact', () => {
  const showQRCodeDialog = REVIEWED_QR_SOURCES.showQRCodeDialog
  const templates = { ...sources, showQRCodeDialog }
  const actual = showQRCodeDialog.replace('[private-digits]', '20200101')
  assert.equal(inspect({ templates, changed: { showQRCodeDialog: actual } }).safe, true)
  assert.equal(inspect({ templates, changed: { showQRCodeDialog: actual.replace('3000', '1') } }).safe, false)
  assert.equal(inspect({ templates, changed: { showQRCodeDialog: actual.replace('by zt', 'unknown comment') } }).safe, false)
})

test('the observed two-hour cache expiry must remain exactly 7200000', () => {
  const checkQRCode = REVIEWED_QR_SOURCES.checkQRCode
  const templates = { ...sources, checkQRCode }
  assert.equal(inspect({ templates, changed: { checkQRCode } }).safe, true)
  assert.equal(inspect({ templates, changed: { checkQRCode: checkQRCode.replaceAll('7200000', '1') } }).safe, false)
})

test('rejects absent or incomplete reviewed templates', () => {
  assert.equal(inspect({ templates: null }).safe, false)
  assert.equal(inspect({ templates: {} }).safe, false)
})

test('rejects keyword camouflage, local flags, prompts and extra navigation', () => {
  for (const doHomework of [
    'function doHomework(ele) { const note="isStudent isIndustryCollege validateResult_ showQRCodeDialog"; if (false) return false; handleHref(ele); }',
    sources.doHomework.replace('if (isStudent', 'var isStudent = "False"; if (isStudent'),
    sources.doHomework.replace('if ("" )', 'if ("blocked" )'),
    sources.doHomework.replace('showQRCodeDialog(ele);', 'showQRCodeDialog(ele); handleHref(ele);'),
  ]) assert.equal(inspect({ changed: { doHomework } }).safe, false)
})

test('rejects cache, nonstudent, industry and old QR state', () => {
  for (const keys of [['validateResult_test'], ['qrcode_validateResult_test']]) assert.equal(inspect({ keys }).safe, false)
  for (const flags of [{ isStudent: 'False' }, { isStudent: true }, { isIndustryCollege: 'True' }, { isIndustryCollege: false }])
    assert.equal(inspect({ flags }).safe, false)
  for (const qrCode of ['old-code', { url: 'old-code' }]) assert.equal(inspect({ qrCode }).safe, false)
})

test('industry diagnostics expose only type/enumeration and token presence', () => {
  for (const [value, expected] of [['', 'string:empty'], ['False', 'string:False'], ['True', 'string:True'],
    ['private arbitrary value', 'string:other'], [true, 'boolean:boolean'], [null, 'object:null'], [undefined, 'undefined:undefined']]) {
    const result = inspect({ flags: { isIndustryCollege: value, token: 'private-token-value' } })
    assert.equal(result.industryKind, expected)
    assert.equal(result.hasFaceToken, true)
    assert.ok(!JSON.stringify(result).includes('private'))
    if (value !== 'False') assert.equal(result.safe, false)
  }
  assert.equal(inspect().hasFaceToken, false)
})

test('industry requires all observed sources, denied camera and no old face record', () => {
  assert.equal(Object.keys(preflightModule.REVIEWED_INDUSTRY_QR_SOURCES || {}).length, 21)
  assert.equal(Object.keys(REVIEWED_QR_SOURCES).length, 11, 'ordinary QR templates stay unchanged')
  const result = inspectIndustry()
  assert.equal(result.safe, true)
  assert.equal(result.industrySourcesMatch, true)
  assert.equal(result.cameraDenied, true)
  assert.equal(result.noFaceRecord, true)
  assert.ok(!JSON.stringify(result).includes('private'))
  for (const cameraState of ['', 'prompt', 'granted', undefined, null, true, 'Denied'])
    assert.equal(inspectIndustry({ cameraState }).safe, false)
  for (const key of ['faceCheckRecordId', 'FaceToken', 'faceFutureRecord']) {
    const result = inspectIndustry({ keys: [key] })
    assert.equal(result.safe, false)
    assert.equal(result.noFaceRecord, false)
  }
  for (const flags of [{ token: '' }, { token: undefined }, { isStudent: 'False' }, { isIndustryCollege: true }])
    assert.equal(inspectIndustry({ flags }).safe, false)
  assert.equal(inspectIndustry({ templates: REVIEWED_QR_SOURCES }).safe, false)
  assert.equal(inspect({ flags: { isIndustryCollege: 'False' }, keys: ['faceCheckRecordId'] }).safe, true)
})

test('industry rejects modified or missing automatic and user-only callback sources', () => {
  const templates = preflightModule.REVIEWED_INDUSTRY_QR_SOURCES || {}
  for (const name of ['doFaceInit', 'checkFaceQRCode', 'doFaceCheck', 'doFaceAgreement', 'startVideo',
    'getUserMedia', 'success', 'error', 'getImageBlob', 'postCheck']) {
    assert.equal(typeof templates[name], 'string', name + ' must have a reviewed complete source')
    assert.equal(inspectIndustry({ changed: { [name]: templates[name].replace('{', '{ handleHref();') } }).safe, false, name)
    assert.equal(inspectIndustry({ changed: { [name]: 'undefined' } }).safe, false, name)
  }
})

test('rejects changed cache or QR helper and disabled/rewired button', () => {
  for (const name of ['getItem', 'validateCheckStatus', 'showQRCodeDialog', 'popQRCodeDialog', 'checkQRCode', 'throttleHref', 'handleHref', 'refreshQRCode', 'setItem', 'openurl']) {
    const changed = { [name]: sources[name].replace('{', '{ handleHref();') }
    assert.equal(inspect({ changed }).safe, false)
  }
  assert.equal(inspect({ button: { getAttribute: () => 'handleHref(this); return doHomework(this);' } }).safe, false)
  assert.equal(inspect({ button: { hasAttribute: () => true } }).safe, false)
})

test('the real course gate checks the second preview and rejects that course', async () => {
  const file = readFileSync(new URL('./t004-real-preqr.mjs', import.meta.url), 'utf8')
  const gate = file.slice(file.indexOf('async function findSafeCourse('), file.indexOf('\nasync function verifySchoolStateUnchanged('))
  let visited = 0
  let denied = 0
  const previews = [inspect(), inspect({ changed: { doHomework: 'function doHomework() { handleHref(); }' } })]
    .map((result, index) => ({ result, url: () => 'https://l.shou.org.cn/study/assignment-preview.aspx?homeWorkId=test-' + index, isClosed: () => false }))
  const browser = { pages: () => previews,
    newCDPSession: async page => ({ send: async (method, params) => {
      if (method === 'Browser.setPermission') {
        assert.equal(params.setting, 'denied')
        assert.equal(params.permission.name, 'camera')
        denied++
        return {}
      }
      assert.equal(method, 'Runtime.evaluate')
      assert.equal(params.awaitPromise, true)
      visited++
      return { result: { value: page.result } }
    }, detach: async () => {} }) }
  const sandbox = vm.createContext({ URL, process: { env: {} }, previewPreflight: qrPreflight, qrPreflight,
    REVIEWED_INDUSTRY_QR_SOURCES: sources, __t004: { contexts: new Map([['test-student', browser]]) } })
  const findSafeCourse = vm.runInContext('(' + gate + ')', sandbox)
  const product = { app: { evaluate: (fn, arg) => fn(null, arg) } }
  const student = { local_id: 'test-student', courses: [{ groups: [{ rows: previews.map(page => ({ status: 'todo', previewHref: page.url() })) }] }] }
  assert.equal((await findSafeCourse(product, student)).index, -1)
  assert.equal(visited, 2, 'course gate must not accept after only its first safe preview')
  assert.equal(denied, 2, 'each preview must deny camera before inspecting school flow')
})
