export function normalizeShortcut(shortcut: string, mac = false) {
  const aliases: Record<string,string> = { Ctrl:'Control', Cmd:'Command', Option:'Alt', CommandOrControl:mac?'Command':'Control' };
  const parts=shortcut.split('+').map(part=>aliases[part]||part);
  const modifiers=['Command','Control','Alt','Shift','Super'];
  return [...modifiers.filter(modifier=>parts.includes(modifier)),...parts.filter(part=>!modifiers.includes(part))].join('+');
}
