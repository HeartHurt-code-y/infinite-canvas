export const CANVAS_SHORTCUTS = {
  group: ["mod+g", "alt+g"],
  storyboard: ["mod+alt+g"],
  ungroup: ["mod+shift+g", "alt+shift+g"],
  connect: ["mod+l"],
  duplicate: ["mod+d"],
  generate: ["mod+enter"],
  add: ["tab"],
  zoomIn: ["mod+=", "mod++", "mod+shift++", "mod+shift+="],
  zoomOut: ["mod+-"],
  fit: ["mod+0"],
  move: ["v"],
  hand: ["h"],
  format: ["alt+shift+f"],
  undo: ["mod+z"],
  redo: ["mod+shift+z", "mod+y"],
  search: ["mod+f"],
  delete: ["delete", "backspace"],
  copy: ["mod+c"],
  paste: ["mod+v"],
} as const;

export type CanvasShortcut = keyof typeof CANVAS_SHORTCUTS;

const shortcuts = new Map<string, CanvasShortcut>(
  (Object.keys(CANVAS_SHORTCUTS) as CanvasShortcut[]).flatMap(action =>
    CANVAS_SHORTCUTS[action].map(combo => [combo, action] as const),
  ),
);

export function canvasShortcutFor(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
  const mod = event.ctrlKey || event.metaKey ? "mod+" : "";
  const alt = event.altKey ? "alt+" : "";
  const shift = event.shiftKey ? "shift+" : "";
  const key = event.key.toLowerCase();
  // Option can produce a symbol on macOS even though the letter key was pressed.
  const letter = event.altKey && !/^[a-z]$/.test(key) ? /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() : undefined;
  return shortcuts.get(mod + alt + shift + (letter ?? key));
}
