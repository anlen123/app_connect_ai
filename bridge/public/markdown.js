import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';

// Provider text is untrusted. Never insert raw model HTML or allow active elements.
export function renderMarkdown(node, text, copy) {
  const html = marked.parse(String(text), { gfm: true, breaks: true, async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'img', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  node.replaceChildren(fragment);
  for (const a of node.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const pre of node.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'code-copy'; button.textContent = '复制';
    button.onclick = () => copy(code.textContent); pre.append(button);
  }
}
