/**
 * 表情存储/暂存单测：路径、目录提示、GIF 校验、MD5、outgoing 暂存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StickerStore, stickerPaths, md5Hex, validateGifBytes } from '../../scripts/lib/sticker/sticker-store.mjs';

/**
 * 构造一个 1x1 GIF（只用于文件校验，不发送）。
 * @returns {Buffer} GIF bytes。
 */
function testGif() {
  return Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'binary');
}

/**
 * 建一个临时项目与客户端目录。
 * @returns {Promise<{ root: string, config: any }>} 环境。
 */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'wxbot-sticker-'));
  // 多一层 version 目录，使 exeDir 向上 3 级正好回到 root
  const exe = path.join(root, 'state', 'wechat-hook-client', '4.1.10.27', 'Weixin.exe');
  await mkdir(path.dirname(exe), { recursive: true });
  await writeFile(exe, 'test');
  return {
    root,
    config: {
      hook: { wechatExecutable: 'state/wechat-hook-client/4.1.10.27/Weixin.exe' },
      sticker: { enabled: true, libraryDir: 'state/stickers/library', maxStickers: 50 },
    },
  };
}

test('stickerPaths：按 Hook 的 exe 路径向上 3 级计算 outgoing', async () => {
  const { root, config } = await setup();
  const paths = stickerPaths(config, root);
  assert.equal(paths.outgoing, path.join(root, 'state', 'stickers', 'outgoing'));
  assert.equal(paths.library, path.join(root, 'state', 'stickers', 'library'));
});

test('StickerStore：目录提示包含名字与时机，只包含启用项', async () => {
  const { root, config } = await setup();
  const store = new StickerStore({ config, root });
  const raw = testGif();
  const md5 = md5Hex(raw);
  await mkdir(path.join(root, 'state', 'stickers', 'library'), { recursive: true });
  await writeFile(path.join(root, 'state', 'stickers', 'library', md5 + '.gif'), raw);
  await store.save({
    version: 1,
    stickers: [
      { id: 's_1', name: '开心', occasion: '对方夸我', file: `state/stickers/library/${md5}.gif`, md5, len: raw.length, width: 1, height: 1, enabled: true },
      { id: 's_2', name: '停用', occasion: '不该出现', file: `state/stickers/library/${md5}.gif`, md5, len: raw.length, width: 1, height: 1, enabled: false },
    ],
  });
  const text = await store.promptCatalog();
  assert.match(text, /s_1/);
  assert.match(text, /开心/);
  assert.match(text, /对方夸我/);
  assert.doesNotMatch(text, /s_2/);
});

test('StickerStore：stage 校验 GIF/MD5 并复制到 outgoing', async () => {
  const { root, config } = await setup();
  const store = new StickerStore({ config, root });
  const raw = testGif();
  const md5 = md5Hex(raw);
  const library = path.join(root, 'state', 'stickers', 'library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, md5 + '.gif'), raw);
  await store.save({
    version: 1,
    stickers: [{ id: 's_1', name: '开心', occasion: '夸我', file: `state/stickers/library/${md5}.gif`, md5, len: raw.length, width: 1, height: 1, enabled: true }],
  });
  const staged = await store.stage('s_1');
  assert.equal(staged.fields.md5, md5);
  assert.equal(staged.fields.len, raw.length);
  assert.equal(staged.path, path.join(root, 'state', 'stickers', 'outgoing', md5 + '.gif'));
  assert.deepEqual(await readFile(staged.path), raw);
});

test('StickerStore：拒绝非 GIF / MD5 不匹配 / 未找到', async () => {
  const { root, config } = await setup();
  const store = new StickerStore({ config, root });
  const raw = Buffer.from('not a gif');
  const library = path.join(root, 'state', 'stickers', 'library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'bad.gif'), raw);
  await store.save({
    version: 1,
    stickers: [{ id: 's_bad', name: '坏', occasion: '', file: 'state/stickers/library/bad.gif', md5: md5Hex(raw), len: raw.length, width: 1, height: 1, enabled: true }],
  });
  await assert.rejects(() => store.stage('s_bad'), /STICKER_NOT_GIF/);
  await assert.rejects(() => store.stage('missing'), /STICKER_NOT_FOUND/);
  assert.equal(validateGifBytes(testGif()), null);
  assert.equal(validateGifBytes(Buffer.alloc(0)), 'STICKER_FILE_EMPTY');
  assert.equal(validateGifBytes(Buffer.from('not a gif')), 'STICKER_NOT_GIF');
});
