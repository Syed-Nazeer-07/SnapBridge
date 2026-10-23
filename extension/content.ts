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
    if (message?.type !== 'snapflow:send') return false;
    const job = message.job as SendJob;
    if (!job || typeof job.jobId !== 'string' || typeof job.prompt !== 'string' || job.prompt.length > 20_000 || !Array.isArray(job.images)) { reply({ ok: false, error: 'Invalid transfer.' }); return false; }
    if (active || attempted.has(job.jobId)) { reply({ ok: false, error: 'Duplicate transfer refused. Check the conversation.' }); return false; }
    active = true; attempted.add(job.jobId);
    void send(job).then(evidence => reply({ ok: true, evidence })).catch(e => reply({ ok: false, error: `${e.message} Queue retained. Check the conversation before retrying. Use manual export if needed.`.slice(0, 1000) })).finally(() => { active = false; });
    return true;
  });
}
async function send(job: SendJob): Promise<string> {
  if (location.href !== job.tab.url || !eligibleUrl(location.href)) throw new Error('The selected conversation has changed. Select the tab again.');
  const adapter = getAdapter(location.hostname);
  const composer = adapter.composer();
  if (!composer) throw new Error(`${adapter.name}'s message composer is unavailable. Sign in, open the conversation, and try again.`);
  if (composerText(composer).trim() || adapter.attachmentCount()) throw new Error('The conversation already has an unsent draft or attachments. Send or clear that draft first.');
  const initialTurns = adapter.turns();
  const initialSet = new Set(initialTurns);
  const initialResponses = new Set(adapter.responses());
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
      const ready = adapter.attachmentCount() >= job.images.length && !adapter.uploading();
      if (!ready) { stable = 0; return false; }
      if (!stable) stable = Date.now(); return Date.now() - stable >= 1200;
    }, 90_000, 'Attachments could not be verified as ready. The draft may contain partial uploads; finish it manually.');
  }
  if (job.prompt) insertPrompt(composer, job.prompt);
  const button = await until(() => { const b = adapter.sendButton(); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : false; }, 15_000, 'The send button is unavailable. Finish the draft manually.');
  if (location.href !== job.tab.url || (job.images.length && (adapter.attachmentCount() < job.images.length || adapter.uploading())) || adapter.hasUploadError()) throw new Error('Conversation or attachments changed before submission. Finish the draft manually.');
  if (composerText(adapter.composer() || composer).trim() !== job.prompt.trim()) throw new Error('The draft changed before submission. SnapFlow will not overwrite it.');
  void chrome.runtime.sendMessage({ type: 'snapflow:progress', jobId: job.jobId, message: 'Submitting once and waiting for the website to acknowledge the message…' }).catch(() => {});
  button.click(); // Exactly one submission attempt. Never retry a click on an uncertain outcome.
  await until(() => {
    if (adapter.hasSubmissionError()) throw new Error('The website reported a submission error. The message may appear as an unsent or failed turn; check the conversation.');
    const current = adapter.composer();
    const turns = adapter.turns();
    const turn = turns.find(t => !initialSet.has(t));
    if (!turn || turns.length <= initialTurns.length || !current || composerText(current).trim() || adapter.attachmentCount()) return false;
    const promptConfirmed = !job.prompt || (turn.innerText || '').replace(/\s+/g, ' ').includes(job.prompt.trim().replace(/\s+/g, ' '));
    const acknowledged = adapter.responses().some(response => !initialResponses.has(response) && visibleResponse(response) && !!(turn.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING));
    return promptConfirmed && acknowledged && (!job.images.length || adapter.turnHasImages(turn, job.images.length));
  }, 30_000, 'Submission was attempted but could not be confirmed. Do not resend until you check the conversation.');
  await wait(1000);
  if (adapter.hasSubmissionError()) throw new Error('The website reported a submission error after creating the user turn. Check the conversation before retrying.');
  return `${adapter.name} added the expected new user turn and acknowledged it with response content.`;
}

function visibleResponse(element: HTMLElement) {
  const text = (element.innerText || '').trim();
  return element.getClientRects().length > 0 && text.length > 0 && !/^(thinking|loading|generating|please wait|\.\.\.|…)[.!…\s]*$/i.test(text);
}
