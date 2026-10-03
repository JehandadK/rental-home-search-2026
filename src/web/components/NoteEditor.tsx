/**
 * Free-text notes and a booked viewing for one listing. Typing stays local
 * and is saved after a short pause or when the editor loses focus, so the
 * table does not re-render on every keystroke.
 */
import { useEffect, useId, useRef, useState } from "react";
import { formatViewing, type ListingNote, type NoteDraft } from "../../domain/notes";
import styles from "./NoteEditor.module.css";

const SAVE_DELAY_MS = 500;

interface Props {
  note: ListingNote | undefined;
  onSave: (draft: NoteDraft) => void;
  className?: string;
}

export function NoteEditor({ note, onSave, className }: Props) {
  const id = useId();
  const [text, setText] = useState(note?.text ?? "");
  const [viewingAt, setViewingAt] = useState(note?.viewingAt ?? "");
  const saved = useRef<NoteDraft>({ text: note?.text ?? "", viewingAt: note?.viewingAt ?? null });
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const flush = (draft: NoteDraft = { text, viewingAt: viewingAt || null }) => {
    if (draft.text === saved.current.text && draft.viewingAt === saved.current.viewingAt) return;
    saved.current = draft;
    onSaveRef.current(draft);
  };

  // Save after a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => flush({ text, viewingAt: viewingAt || null }), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });

  // Never lose a draft when the row collapses mid-sentence.
  const latest = useRef<NoteDraft>({ text, viewingAt: viewingAt || null });
  latest.current = { text, viewingAt: viewingAt || null };
  useEffect(() => () => flush(latest.current), []);

  return (
    <div className={`${styles.editor} ${className ?? ""}`} onClick={(e) => e.stopPropagation()}>
      <label htmlFor={`${id}-text`} className={styles.label}>
        📝 My notes
        {note?.updatedAt && <small>saved {note.updatedAt.slice(0, 10)}</small>}
      </label>
      <textarea
        id={`${id}-text`}
        className={styles.text}
        rows={3}
        placeholder="What the agent said, what you saw at the viewing, what to ask next…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => flush()}
      />
      <div className={styles.viewing}>
        <label htmlFor={`${id}-viewing`}>📅 Viewing</label>
        <input
          id={`${id}-viewing`}
          type="datetime-local"
          value={viewingAt}
          onChange={(e) => {
            setViewingAt(e.target.value);
            flush({ text, viewingAt: e.target.value || null });
          }}
        />
        {viewingAt && (
          <>
            <span className={styles.when}>{formatViewing(viewingAt)}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setViewingAt("");
                flush({ text, viewingAt: null });
              }}
            >
              clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
