/**
 * 控制台安全辅助单测（CSRF / Host / Origin / 路径穿越 / 日志脱敏）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedHost,
  isAllowedOrigin,
  isStaticAssetName,
  safeLogText,
  tokenEquals,
} from '../../scripts/lib/console/console-security.mjs';

test('isAllowedHost 只接受本机控制台端口', () => {
  assert.equal(isAllowedHost('127.0.0.1:3210', 3210), true);
  assert.equal(isAllowedHost('LOCALHOST:3210', 3210), true);
  assert.equal(isAllowedHost('[::1]:3210', 3210), true);
  assert.equal(isAllowedHost('127.0.0.1:3211', 3210), false);
  assert.equal(isAllowedHost('evil.example:3210', 3210), false);
  assert.equal(isAllowedHost(undefined, 3210), false);
});

test('isAllowedOrigin 放行无 Origin 的同源导航，拒绝外站', () => {
  assert.equal(isAllowedOrigin(undefined, 3210), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3210', 3210), true);
  assert.equal(isAllowedOrigin('http://localhost:3210', 3210), true);
  assert.equal(isAllowedOrigin('http://evil.example', 3210), false);
});

test('tokenEquals 常量时间比较，长度不同即拒绝', () => {
  assert.equal(tokenEquals('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(tokenEquals('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(tokenEquals('a'.repeat(63), 'a'.repeat(64)), false);
  assert.equal(tokenEquals('', ''), false);
  assert.equal(tokenEquals(undefined, 'a'), false);
});

test('isStaticAssetName 只允许白名单扩展名且禁止路径穿越', () => {
  assert.equal(isStaticAssetName('app.js'), true);
  assert.equal(isStaticAssetName('style.css'), true);
  assert.equal(isStaticAssetName('../app.js'), false);
  assert.equal(isStaticAssetName('a/b.js'), false);
  assert.equal(isStaticAssetName('index.exe'), false);
});

test('safeLogText 去掉查询串与 64-hex', () => {
  assert.equal(safeLogText('/api/x?token=abc'), '/api/x');
  assert.equal(safeLogText('/a/' + 'f'.repeat(64)), '/a/[64hex已隐藏]');
});
