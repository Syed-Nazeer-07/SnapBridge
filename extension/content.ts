import { eligibleUrl, MAX_BYTES, MAX_IMAGE_BYTES, type SendJob } from '../shared/protocol';
import { getAdapter, composerText, insertPrompt, until, wait } from './adapters';
// Reinjection is safe, but never install two message listeners into the same document.
const guard = globalThis as typeof globalThis & { __snapflowInstalled?: boolean };
if (!guard.__snapflowInstalled) {
  guard.__snapflowInstalled = true;
  let active = false;
  const attempted = new Set<string>();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !eligibleUrl(location.href)) return false;
    if (message?.type === 'snapflow:ping') { reply({ ok: true }); return false; }
    if (message?.type !== 'snapflow:prepare') return false;
    const job = message.job as SendJob;
    if (!job || typeof job.jobId !== 'string' || typeof job.prompt !== 'string' || job.prompt.length > 20_000 || !Array.isArray(job.images)) { reply({ ok: false, error: 'Invalid transfer.' }); return false; }
    if (active || attempted.has(job.jobId)) { reply({ ok: false, error: 'Duplicate transfer refused. Check the conversation.' }); return false; }
    active = true; attempted.add(job.jobId);
    void prepare(job).then(evidence => reply({ ok: true, outcome: 'prepared', evidence })).catch(e => reply({ ok: false, error: `${e.message} Queue retained. Check the browser draft before retrying. Use manual export if needed.`.slice(0, 1000) })).finally(() => { active = false; });
    return true;
  });
}
async function prepare(job: SendJob): Promise<string> {
  if (location.href !== job.tab.url || !eligibleUrl(location.href)) throw new Error('The selected conversation has changed. Select the tab again.');
  const adapter = getAdapter(location.hostname);
  const composer = adapter.composer();
  if (!composer) throw new Error(`${adapter.name}'s message composer is unavailable. Sign in, open the conversation, and try again.`);
  if (composerText(composer).trim() || adapter.attachmentCount()) throw new Error('The conversation already has an unsent draft or attachments. Send or clear that draft first.');

  if (job.images.length) {
    const transfer = new DataTransfer(); let total = 0;
    for (const image of job.images) {
      if (typeof image.base64 !== 'string' || image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[-a-zA-Z0-9_.]+\.png$/.test(image.name)) throw new Error('Invalid screenshot transfer.');
      const raw = atob(image.base64); const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
      total += bytes.length;
      if (total > MAX_BYTES || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Screenshot transfer exceeded safe limits or contained an invalid PNG.');
      transfer.items.add(new File([bytes], image.name, { type: 'image/png' }));
    }
    const input = await adapter.fileInput();
    if (!input.multiple && transfer.files.length > 1) throw new Error('This attachment control only accepts one file. Use manual export for this batch.');
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    void chrome.runtime.sendMessage({ type: 'snapflow:progress', jobId: job.jobId, message: `Waiting for ${job.images.length} attachment${job.images.length === 1 ? '' : 's'} to finish uploading…` }).catch(() => {});
    let stable = 0;
    await until(() => {
      if (location.href !== job.tab.url) throw new Error('The conversation navigated during upload.');
      if (adapter.hasUploadError()) throw new Error('The website reported an attachment error or account limit. Finish the draft manually.');
      const ready = adapter.attachmentCount() === job.images.length && !adapter.uploading();
      if (!ready) { stable = 0; return false; }
      if (!stable) stable = Date.now(); return Date.now() - stable >= 1200;
    }, 90_000, 'Attachments could not be verified as ready. The draft may contain partial uploads; finish it manually.');
  }
  if (location.href !== job.tab.url || adapter.composer() !== composer || composerText(composer).trim()) throw new Error('The draft changed while attachments were uploading. SnapFlow left it intact; finish in the browser.');
  if (job.prompt) insertPrompt(composer, job.prompt);
  const button = await until(() => { const b = adapter.sendButton(); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : false; }, 15_000, 'The send button is unavailable. Finish the draft manually.');
  if (location.href !== job.tab.url || (job.images.length && (adapter.attachmentCount() < job.images.length || adapter.uploading())) || adapter.hasUploadError()) throw new Error('Conversation or attachments changed before submission. Finish the draft manually.');
  if (composerText(adapter.composer() || composer).trim() !== job.prompt.trim()) throw new Error('The draft changed before submission. SnapFlow will not overwrite it.');
  // Preparation stops here. SnapFlow never clicks the website's Send button.
  await wait(400);
  if (location.href !== job.tab.url || adapter.composer() !== composer || composerText(composer).trim() !== job.prompt.trim() || adapter.attachmentCount() !== job.images.length || adapter.uploading() || adapter.hasUploadError()) throw new Error('The draft changed before it could be verified. Review it in your browser.');
  composer.focus();
  return `${job.images.length} attachment${job.images.length === 1 ? '' : 's'} and the message are ready for your review. Nothing was submitted.`;
}
