import type { Editor } from "@tiptap/react";
import { safeNoteFontSize } from "./richText";
export function NoteFormatButtons({ editor }: { editor: Editor | null }) {
  return <>
    <button aria-label="Underline" aria-pressed={editor?.isActive("underline") || false} onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
    <button aria-label="Highlight text" aria-pressed={editor?.isActive("highlight") || false} onClick={() => editor?.chain().focus().toggleHighlight({ color: "#f4cc60" }).run()}><mark>Highlight</mark></button>
    <label className="note-text-color">Text color<input aria-label="Note text color" type="color" defaultValue="#293541" onChange={e => editor?.chain().focus().setColor(e.target.value).run()} /></label>
    <label className="note-text-size">Text size<input type="number" min={10} max={64} step={1} placeholder="px" aria-label="Note text size" onKeyDown={e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const size = `${e.currentTarget.value}px`;
      if (safeNoteFontSize(size)) editor?.chain().focus().setFontSize(size).run();
    }} onBlur={e => {
      const size = `${e.currentTarget.value}px`;
      if (safeNoteFontSize(size)) editor?.commands.setFontSize(size);
      e.currentTarget.value = "";
    }} /></label>
    <button type="button" className="text-button" aria-label="Reset note text size" onClick={() => editor?.chain().focus().unsetFontSize().run()}>Reset size</button>
    <button aria-label="Add link" onClick={() => {
      const href = prompt("Link address (https://… or mailto:…)", editor?.getAttributes("link").href || "https://");
      if (href === null) return;
      if (!href.trim()) { editor?.chain().focus().unsetLink().run(); return; }
      if (!/^(https?:\/\/|mailto:)[^\s]+$/i.test(href.trim())) { alert("Enter an https://, http:// or mailto: address."); return; }
      editor?.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
    }}>Link</button>
  </>;
}
