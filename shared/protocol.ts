import { z } from 'zod';
export const PORT = 47831;
export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const eligibleUrl = (url: string): boolean => {
  try { const u = new URL(url); return u.protocol === 'https:' && ['chatgpt.com', 'gemini.google.com'].includes(u.hostname) && !u.port; } catch { return false; }
};
export const TabSchema = z.object({ id: z.number().int().nonnegative(), title: z.string().max(240), url: z.string().max(2048).refine(eligibleUrl), provider: z.enum(['ChatGPT', 'Gemini']) }).strict();
export type TargetTab = z.infer<typeof TabSchema>;
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pair'), code: z.string().regex(/^[a-f0-9]{48}$/) }).strict(),
  z.object({ type: z.literal('native-auth'), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('auth'), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('tabs'), tabs: z.array(TabSchema).max(100) }).strict(),
  z.object({ type: z.literal('result'), jobId: z.string().uuid(), ok: z.boolean(), outcome: z.literal('prepared').optional(), error: z.string().max(1000).optional(), evidence: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal('progress'), jobId: z.string().uuid(), message: z.string().max(300) }).strict(),
  z.object({ type: z.literal('ping') }).strict()
]);
export interface Screenshot { id: string; name: string; createdAt: number; bytes: number; width: number; height: number; thumbnail: string }
export interface ImageFile { id: string; name: string; base64: string }
export interface SendJob { type: 'prepare'; jobId: string; tab: TargetTab; images: ImageFile[]; prompt: string }
export const SettingsSchema = z.object({ shortcut: z.string().min(3).max(80), alwaysOnTop: z.boolean(), captureMode: z.enum(['instant', 'adjust']).default('instant'), setupComplete: z.boolean().default(false) }).strict();
export type Settings = z.infer<typeof SettingsSchema>;
export interface PreparedBatch { ids: string[]; tabId: number; url: string; promptDigest: string; time: number }
export interface AppState {
  images: Screenshot[]; tabs: TargetTab[]; connected: boolean; pairingCode: string;
  prepared: PreparedBatch | null; settings: Settings; busy: boolean; status: string; error: boolean; bytes: number;
}
export interface CaptureSource { dataUrl: string; width: number; height: number; displayId: number; captureMode: 'instant' | 'adjust' }
export interface SnapflowAPI {
  state(): Promise<AppState>;
  capture(): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  clear(): Promise<void>;
  preview(id: string): Promise<string>;
  prepare(tabId: number, prompt: string): Promise<void>;
  clearPrepared(prompt: string): Promise<boolean>;
  fallback(tabId: number | null, prompt: string): Promise<string>;
  settings(settings: Settings): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  resize(expanded: boolean): Promise<void>;
  unpair(): Promise<void>;
  extensionFolder(): Promise<string>;
  revealExtension(): Promise<void>;
  onState(listener: (state: AppState) => void): () => void;
  captureSource(): Promise<CaptureSource>;
  finishCapture(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  cancelCapture(): Promise<void>;
}
declare global { interface Window { snapflow: SnapflowAPI } }
