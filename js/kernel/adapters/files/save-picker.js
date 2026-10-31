/**
 * The file port #20's remediations save through (js/trust/core/remediation/ports.js,
 * FilePort), over the File System Access API: `showSaveFilePicker()`, a writable stream whose
 * `close()` has resolved, and the same handle's file read back. "Saved" in the Trust and
 * Recovery Center means that file, closed, read back, and counted (saved-file.js), never an
 * anchor or Utils.downloadFile download, so nothing here falls back to one: a page without
 * the picker answers unavailable, and the remediation says it couldn't save.
 *
 * - `pick` resolves null when the user cancels the picker (an AbortError), so a cancelled
 *   save goes back to the preview instead of failing the run.
 * - `write` writes each part in turn and resolves only once `close()` has, which is when the
 *   browser has moved the file into place; one that fails aborts the stream, so no partial
 *   file is left where the user chose.
 * - `read` reads the file the handle names now, from disk.
 *
 * `showSaveFilePicker` needs a click's user activation, which slice 4's views give it. The
 * composition root passes the page's own function in; nothing shipped makes one yet.
 */

/**
 * The picker, as the page has it: `window.showSaveFilePicker`
 * @typedef {(options: {suggestedName: string, types: Array<{description: string, accept: Record<string, string[]>}>}) => Promise<FileHandle>} ShowSaveFilePicker
 */

/**
 * What the picker hands back, as far as this uses it
 * @typedef {object} FileHandle
 * @property {() => Promise<{write: (part: string) => Promise<void>, close: () => Promise<void>, abort: () => Promise<void>}>} createWritable
 * @property {() => Promise<{text: () => Promise<string>}>} getFile
 */

/** The one kind of file these are */
const TYPES = Object.freeze([{ description: 'NewTabNote file', accept: { 'application/json': ['.json'] } }]);

/**
 * @param {{showSaveFilePicker?: ShowSaveFilePicker | null}} host - the page's window, or anything with its picker
 */
export function createSavePicker(host) {
  const picker = host && typeof host.showSaveFilePicker === 'function' ? host.showSaveFilePicker.bind(host) : null;
  return Object.freeze({
    /** Whether this page can show the picker at all */
    available: () => picker !== null,

    /**
     * The handle the user picked, or null when they cancelled
     * @param {{suggestedName: string}} options
     * @returns {Promise<FileHandle | null>}
     */
    async pick({ suggestedName }) {
      if (!picker) throw new DOMException('showSaveFilePicker is unavailable', 'NotSupportedError');
      try {
        return await picker({ suggestedName, types: TYPES.map(type => ({ ...type, accept: { ...type.accept } })) });
      } catch (error) {
        if (error && /** @type {{name?: unknown}} */ (error).name === 'AbortError') return null;
        throw error;
      }
    },

    /**
     * Writes `parts` to the file, resolving once the stream's close() has
     * @param {FileHandle} handle
     * @param {Iterable<string>} parts - written in turn, as the iterable makes them
     */
    async write(handle, parts) {
      const stream = await handle.createWritable();
      try {
        for (const part of parts) await stream.write(part);
      } catch (error) {
        await stream.abort().catch(() => {});
        throw error;
      }
      await stream.close();
    },

    /**
     * The file's text, read from disk now
     * @param {FileHandle} handle
     * @returns {Promise<string>}
     */
    async read(handle) {
      const file = await handle.getFile();
      return file.text();
    },
  });
}

/** @typedef {ReturnType<typeof createSavePicker>} SavePicker */
