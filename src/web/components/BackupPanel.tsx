/**
 * Backup & sync: move the shortlist, notes and decisions to another device,
 * or merge a partner's file into this browser's. Nothing is written until the
 * person presses Apply; the merge rules live in `userState/backup`.
 */
import { memo, useMemo, useState, type ChangeEvent } from "react";
import {
  applyImport,
  describeBackup,
  exportUserState,
  parseBackup,
  planImport,
  type ImportMode,
  type UserStateBackup,
} from "../userState/backup";
import { useUserStateStore } from "../userState/UserStateContext";
import styles from "./BackupPanel.module.css";

export interface BackupPanelProps {
  /** Called after an import has been written to the store. The app reloads itself to pick the new state up. */
  onImported?: () => void;
}

const reload = () => window.location.reload();

const stamp = (now: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/**
 * Memoised, and reads the store only when asked: it sits in the sidebar, where
 * every hover on the map or the table re-renders its parent.
 */
export const BackupPanel = memo(function BackupPanel({ onImported = reload }: BackupPanelProps) {
  const store = useUserStateStore();
  const [exportNote, setExportNote] = useState("");
  const [pasted, setPasted] = useState("");
  const [backup, setBackup] = useState<UserStateBackup | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [includePreferences, setIncludePreferences] = useState(false);

  // What an export would hold, counted when the panel is opened rather than on every render.
  const [mine, setMine] = useState(() => exportUserState(store));

  const download = () => {
    const text = JSON.stringify(exportUserState(store), null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `rental-decisions-${stamp(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportUserState(store), null, 2));
      setExportNote("Copied");
      window.setTimeout(() => setExportNote(""), 2000);
    } catch {
      setExportNote("Copying is not available here. Use Download file instead.");
    }
  };

  const read = (text: string) => {
    const result = parseBackup(text);
    if (result.ok) {
      setBackup(result.backup);
      setError("");
    } else {
      setBackup(null);
      setError(result.error);
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      read(await file.text());
    } catch {
      setBackup(null);
      setError("Could not read that file. Try pasting its text instead.");
    }
    // Picking the same file again after a cancel must still be a change.
    event.target.value = "";
  };

  const cancel = () => {
    setBackup(null);
    setError("");
    setPasted("");
  };

  // The preview. What is stored can change after it is drawn (a note saved as
  // focus leaves it for the Apply button), so Apply plans again from what is
  // stored at that moment and never writes this copy.
  const plan = useMemo(
    () => (backup ? planImport(store, backup, { mode, includePreferences }) : null),
    [store, backup, mode, includePreferences],
  );

  const apply = () => {
    if (!backup) return;
    applyImport(store, planImport(store, backup, { mode, includePreferences }));
    onImported();
  };

  /** Replace deletes what the file lacks: say how much before it happens. */
  const removes = plan != null && plan.changes.some((change) => change.removed > 0);

  return (
    <details className={styles.card} onToggle={(event) => { if (event.currentTarget.open) setMine(exportUserState(store)); }}>
      <summary className={styles.summary}>
        <span className={styles.title}>Backup &amp; sync</span>
        <span className={styles.lede}>Move your shortlist, notes and decisions to another device, or merge your partner's.</span>
      </summary>

      <section className={styles.section} aria-label="Export">
        <h3 className={styles.heading}>Export</h3>
        <p className={styles.count}>{describeBackup(mine)}</p>
        <div className={styles.row}>
          <button type="button" onClick={download}>Download file</button>
          <button type="button" className="secondary" onClick={() => void copy()}>Copy as text</button>
          <span className={styles.note} role="status">{exportNote}</span>
        </div>
      </section>

      <section className={styles.section} aria-label="Import">
        <h3 className={styles.heading}>Import</h3>
        <label className={styles.field}>
          Backup file
          <input type="file" accept=".json,application/json" onChange={(event) => void onFile(event)} />
        </label>
        <label className={styles.field}>
          Or paste its text
          <textarea rows={3} value={pasted} onChange={(event) => setPasted(event.target.value)} />
        </label>
        <div className={styles.row}>
          <button type="button" className="secondary" disabled={pasted.trim() === ""} onClick={() => read(pasted)}>Read</button>
        </div>
        {error !== "" && <p className={styles.error} role="alert">{error}</p>}

        {plan && (
          <div className={styles.plan}>
            <fieldset className={styles.modes}>
              <legend className={styles.legend}>How to bring it in</legend>
              <label><input type="radio" name="backup-mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge into mine</label>
              <label><input type="radio" name="backup-mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace mine</label>
            </fieldset>
            {mode === "merge" && (
              <label className={styles.check}>
                <input type="checkbox" checked={includePreferences} onChange={(event) => setIncludePreferences(event.target.checked)} />
                Also take their weights, filters and places
              </label>
            )}
            {plan.changes.length === 0 ? (
              <p className={styles.note}>Nothing in this file would change anything here.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">What</th><th scope="col">New</th><th scope="col">Changed</th>
                      {removes && <th scope="col">Removed</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.map((change) => (
                      <tr key={change.key}>
                        <th scope="row">{change.label}</th>
                        <td>+{change.added}</td>
                        <td>{change.changed}</td>
                        {removes && <td className={change.removed > 0 ? styles.removed : undefined}>{change.removed > 0 ? `−${change.removed}` : 0}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {removes && (
              <p className={styles.error} role="alert">
                Replacing deletes {plan.changes.reduce((sum, change) => sum + change.removed, 0)} of your own entries that are not in this file. Merge keeps them.
              </p>
            )}
            <div className={styles.row}>
              <button type="button" onClick={apply}>Apply</button>
              <button type="button" className="secondary" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <p className={styles.fine}>
        The file contains your notes and anything you typed. It never leaves your devices unless you send it.
      </p>
    </details>
  );
});
