import { mkdirSync, writeFileSync, renameSync, chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export function validatePairingCode(value) {
  if (typeof value !== 'string') throw new Error('配对码必须是文本');
  const code = value.trim(), length = Array.from(code).length;
  if (length < 12 || length > 256 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error('配对码需要 12–256 个字符，不能包含换行或控制字符；建议使用较长的随机短语');
  return code;
}
export function savePairingCode(dataDir, value) {
  const code = validatePairingCode(value); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = resolve(dataDir, 'token'), temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, code + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, target); chmodSync(target, 0o600);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { savePairingCode(resolve(process.env.DATA_DIR || `${process.env.HOME}/.local/share/lan-agent`), readFileSync(0, 'utf8')); console.log('自定义配对码已保存（未显示明文）。运行中的服务需要手动重启才能生效；旧码会失效。'); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
