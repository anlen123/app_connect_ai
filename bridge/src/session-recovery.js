import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Recover v1.2 references only from unambiguous native evidence. Never silently
// replace an existing conversation with an empty agent or another terminal session.
export function recoverNative(session, legacyPiDir) {
  const users = session.events.filter(e => e.event === 'user');
  if (session.native) {
    if (session.kind === 'pi' && !existsSync(session.native.sessionFile || '')) {
      if (users.length) throw new Error('原 Pi 会话文件不存在，无法安全恢复上下文；历史记录仍保留');
      return undefined; // Pi does not flush an unused session file.
    }
    return session.native;
  }
  if (!users.length) return undefined;
  if (session.kind === 'codex') {
    const ids = new Set(session.events.filter(e => e.event === 'progress').map(e => e.detail?.threadId).filter(id => typeof id === 'string' && id));
    if (ids.size === 1) return { threadId: [...ids][0] };
  } else {
    const encoded = `--${session.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const directory = legacyPiDir || process.env.PI_CODING_AGENT_SESSION_DIR || resolve(homedir(), '.pi/agent/sessions', encoded);
    const matches = [];
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = resolve(directory, name);
      try {
        if (!statSync(path).isFile() || statSync(path).size > 32 * 1024 * 1024) continue;
        const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const header = entries[0];
        if (header?.type !== 'session' || header.cwd !== session.cwd || !entries.some(e => e.type === 'session_info' && e.name === 'LAN Agent')) continue;
        const nativeUsers = entries.filter(e => e.type === 'message' && e.message?.role === 'user').map(e => e.message);
        const start = nativeUsers.findIndex(m => Math.abs(m.timestamp - users[0].timestamp) < 10000 && userText(m) === users[0].text);
        if (start < 0 || start + users.length !== nativeUsers.length) continue;
        if (users.every((u, i) => userText(nativeUsers[start + i]) === u.text && Math.abs(nativeUsers[start + i].timestamp - u.timestamp) < 10000)) matches.push({ sessionFile: path, sessionId: header.id });
      } catch { /* A damaged/unrelated native file is not a recovery candidate. */ }
    }
    if (matches.length === 1) return matches[0];
  }
  throw new Error('旧会话没有可唯一确认的原生恢复信息，不能安全重启；请保留历史并检查原生会话文件');
}
function userText(message) {
  return typeof message.content === 'string' ? message.content : (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
