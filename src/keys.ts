const namedKeys = new Set([
  "return",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);
const aliases: Readonly<Record<string, string>> = {
  command: "cmd",
  meta: "cmd",
  control: "ctrl",
  alt: "option",
  enter: "return",
  esc: "escape",
};
const modifierKeys = new Set(["cmd", "ctrl", "option", "shift", "fn"]);

/** Parse one key or a chord such as Cmd+Shift+K; never a sequence of keys. */
export function parseKeyChord(value: unknown): {
  key: string;
  modifiers: string[];
  chord: string;
} {
  if (typeof value !== "string" || value.length > 80)
    throw new Error("Use one key or a shortcut such as Cmd+K.");
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => {
      const key = part.trim();
      return aliases[key] ?? key;
    });
  const key = parts.pop() ?? "";
  if (
    (!namedKeys.has(key) && !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(key)) ||
    parts.some((part) => !modifierKeys.has(part)) ||
    new Set(parts).size !== parts.length
  )
    throw new Error(
      "Use one key or a shortcut such as Cmd+K; key sequences are unsupported.",
    );
  return { key, modifiers: parts, chord: [...parts, key].join("+") };
}

/** These keys keep editing in the same control; focus-changing keys do not. */
export function preservesEditTarget(
  key: string,
  modifiers: readonly string[],
): boolean {
  return (
    modifiers.every(
      (modifier) => modifier === "shift" || modifier === "option",
    ) &&
    [
      "left",
      "right",
      "up",
      "down",
      "home",
      "end",
      "backspace",
      "delete",
    ].includes(key)
  );
}
