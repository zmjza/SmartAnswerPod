import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const file = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/大学英语当前试卷/大学英语当前试卷-本地脱敏测试案例.html');
const html = readFileSync(file, 'utf8');
const count = (pattern) => [...html.matchAll(pattern)].length;

assert.equal(count(/class="e-q-panel typebox"/g), 5);
assert.equal(count(/class="e-q-body"/g), 15);
assert.equal(count(/<select /g), 10);
assert.equal(count(/<form /g), 36);
for (const type of ['1', '7', '8', '9', '11']) {
  assert.ok(html.includes('data-questiontype="' + type + '"'));
}
for (const sample of ['Match the Chinese with English.', 'My sister is a student', 'Read the text and decide']) {
  assert.ok(html.includes(sample), '题目正文缺失：' + sample);
}
for (const secret of ['王思腾', 'xtoken', 'studentWorkId', 'subQuestionId', 'data-id=', 'data-url=', 'https://', 'http://', 'type="hidden"', 'action="/study']) {
  assert.ok(!html.includes(secret), '敏感或外部内容残留：' + secret);
}
assert.equal(count(/<script>/g), 1);
const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
new vm.Script(script);
for (const external of ['fetch(', 'XMLHttpRequest', 'sendBeacon', '.submit(']) assert.ok(!script.includes(external));
console.log('大学英语本地案例：结构、内容、脱敏、离线脚本检查通过');
