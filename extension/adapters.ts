export interface SiteAdapter {
  name: string;
  composer(): HTMLElement | null;
  sendButton(): HTMLButtonElement | null;
  fileInput(): Promise<HTMLInputElement>;
  attachmentCount(): number;
  uploading(): boolean;
  turns(): HTMLElement[];
  turnHasImages(turn: HTMLElement, count: number): boolean;
  hasUploadError(): boolean;
  responses(): HTMLElement[];
  hasSubmissionError(): boolean;
}
export const visible = (element: Element | null): element is HTMLElement => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until<T>(get: () => T | null | false | undefined, timeout: number, message: string): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = get(); if (value) return value; await wait(150); }
  throw new Error(message);
}
const first = <T extends HTMLElement>(selectors: string) => [...document.querySelectorAll<T>(selectors)].find(visible) || null;
const queryInput = () => [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(input => !input.accept || /image|\.png|\*/i.test(input.accept)) || null;
const region = (composer: HTMLElement | null) => composer?.closest('form') || composer?.closest('rich-textarea')?.parentElement?.parentElement || composer?.parentElement?.parentElement || null;
function controlsCount(root: Element | null, selectors: string) { return root ? [...root.querySelectorAll(selectors)].filter(visible).length : 0; }
function baseFileInput(name: string) {
  const input = queryInput();
  if (!input) throw new Error(`${name}'s file attachment control is unavailable. Open the attachment menu once, then try again, or use Export for manual send.`);
  return Promise.resolve(input);
}
const chatgpt: SiteAdapter = {
  name: 'ChatGPT',
  composer: () => first<HTMLElement>('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea'),
  sendButton: () => first<HTMLButtonElement>('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]'),
  fileInput: () => baseFileInput('ChatGPT'),
  attachmentCount() {
    const root = region(this.composer());
    return Math.max(controlsCount(root, 'button[aria-label="Remove file"], button[aria-label="Remove image"], button[aria-label="Remove attachment"], button[data-testid="remove-file"]'), controlsCount(root, '[data-testid="file-thumbnail"], img[alt="Uploaded image"]'));
  },
  uploading() { return !!region(this.composer())?.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid="upload-progress"]'); },
  turns: () => [...document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]')].map(el => el.closest<HTMLElement>('article') || el),
  turnHasImages: (turn, count) => turn.querySelectorAll('img').length >= count,
  responses: () => [...document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"] .markdown')],
  hasSubmissionError: () => [...document.querySelectorAll('[role="alert"], [data-testid="conversation-error"], .text-token-text-error')].some(e => visible(e) && /something went wrong|failed|unable|error|limit|too many|try again/i.test(e.textContent || '')),
  hasUploadError: () => [...document.querySelectorAll('[role="alert"]')].some(e => visible(e) && /upload|attachment|file.*(fail|limit|large)|unable to/i.test(e.textContent || ''))
};
const gemini: SiteAdapter = {
  name: 'Gemini',
  composer: () => first<HTMLElement>('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]'),
  sendButton: () => first<HTMLButtonElement>('button[aria-label="Send message"], button.send-button, button[data-test-id="send-button"]'),
  async fileInput() {
    let input = queryInput(); if (input) return input;
    const add = first<HTMLButtonElement>('button[aria-label="Upload files"], button[aria-label="Add files"], button[aria-label="Add files and tools"]');
    add?.click(); await wait(250);
    const upload = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(el => visible(el) && /^Upload files$/i.test(el.textContent?.trim() || ''));
    // Opening a native picker from a synthetic click may be blocked; no security workarounds.
    upload?.click(); await wait(250);
    return baseFileInput('Gemini');
  },
  attachmentCount() {
    const root = region(this.composer());
    return Math.max(controlsCount(root, 'button[aria-label*="Remove file"], button[aria-label*="Remove image"], button[aria-label*="Remove attachment"]'), controlsCount(root, '.file-preview-container, .image-preview-container, [data-test-id="uploaded-file"]'));
  },
  uploading() { return !!region(this.composer())?.querySelector('[role="progressbar"], [aria-busy="true"], mat-progress-spinner'); },
  turns: () => [...document.querySelectorAll<HTMLElement>('user-query')],
  turnHasImages: (turn, count) => turn.querySelectorAll('img, [data-test-id="file-preview"]').length >= count,
  responses: () => [...document.querySelectorAll<HTMLElement>('model-response .markdown, model-response .markdown-main-panel')],
  hasSubmissionError: () => [...document.querySelectorAll('[role="alert"], .response-error-message')].some(e => visible(e) && /something went wrong|failed|unable|error|limit|too many|try again/i.test(e.textContent || '')),
  hasUploadError: () => [...document.querySelectorAll('[role="alert"], .upload-error')].some(e => visible(e) && /upload|attachment|file|limit/i.test(e.textContent || ''))
};
export function getAdapter(hostname: string) { if (hostname === 'chatgpt.com') return chatgpt; if (hostname === 'gemini.google.com') return gemini; throw new Error('This website is not supported.'); }
export function composerText(element: HTMLElement) { return element instanceof HTMLTextAreaElement ? element.value : element.innerText; }
export function insertPrompt(element: HTMLElement, prompt: string) {
  element.focus();
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(element, prompt); element.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // execCommand preserves the editor's undo stack and triggers framework input handlers.
    const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range);
    if (!document.execCommand('insertText', false, prompt)) throw new Error('The website blocked message insertion. Finish the draft manually.');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  if (composerText(element).trim() !== prompt.trim()) throw new Error('The website did not accept the full prompt. Draft retained; finish manually.');
}
