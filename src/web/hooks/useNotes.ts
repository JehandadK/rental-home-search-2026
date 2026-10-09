/**
 * The user's notes and booked viewings, persisted through the user-state
 * store and keyed by listingKey like the decision marks.
 */
import { useCallback } from "react";
import { withNote, type NoteDraft, type NoteMap } from "../../domain/notes";
import { decodeNotes } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useNotes() {
  const [notes, setNotes] = usePersistentState<NoteMap>(USER_STATE_KEYS.notes, decodeNotes);

  /** Save one listing's note; a blank draft removes it. */
  const setNote = useCallback((key: string, draft: NoteDraft) => {
    setNotes((current) => withNote(current, key, draft));
  }, [setNotes]);

  return { notes, setNote };
}
