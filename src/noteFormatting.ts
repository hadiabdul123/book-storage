import Highlight from "@tiptap/extension-highlight";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
export const noteFormatting = () => [Highlight.configure({ multicolor: true }), TextStyle, Color, FontSize];
export function safeNoteColor(value: unknown): value is string {
  return typeof value === "string" && (/^#[a-f0-9]{6}$/i.test(value) || /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(value));
}
