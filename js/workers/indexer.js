/**
 * Search Indexer Web Worker
 * Processes notes and blocks to build a searchable index without blocking the main thread.
 * Supports full rebuilds (INDEX_NOTES), incremental updates (UPDATE_NOTE), and removals (REMOVE_NOTE).
 */

/** @type {Array<{noteId: string, name: string, content: string, tags: string[], updatedAt: number}>} */
let currentIndex = [];

self.onmessage = function (e) {
    const { type, data } = e.data;

    switch (type) {
        case 'INDEX_NOTES': {
            currentIndex = buildIndex(data.notes, data.blocks);
            self.postMessage({ type: 'INDEX_COMPLETE', data: currentIndex });
            break;
        }
        case 'UPDATE_NOTE': {
            const entry = buildNoteEntry(data.note, data.blocks);
            const existingIdx = currentIndex.findIndex(item => item.noteId === entry.noteId);
            if (existingIdx !== -1) {
                currentIndex[existingIdx] = entry;
            } else {
                currentIndex.push(entry);
            }
            self.postMessage({ type: 'INDEX_UPDATED', data: { entry } });
            break;
        }
        case 'REMOVE_NOTE': {
            const noteId = data.noteId;
            currentIndex = currentIndex.filter(item => item.noteId !== noteId);
            self.postMessage({ type: 'INDEX_REMOVED', data: { noteId } });
            break;
        }
        case 'SEARCH':
            // Future: localized search within worker if index is large
            break;
    }
};

/**
 * Build a single index entry for one note and its blocks
 * @param {Object} note
 * @param {Array<Object>} blocks
 * @returns {{noteId: string, name: string, content: string, tags: string[], updatedAt: number}}
 */
function buildNoteEntry(note, blocks) {
    const content = (blocks || [])
        .map(b => b.content || '')
        .join(' ')
        .replace(/<[^>]*>?/gm, ''); // Strip HTML

    return {
        noteId: note.id,
        name: note.name || 'Untitled',
        content: content,
        tags: extractTags(content + ' ' + (note.name || '')),
        updatedAt: note.updatedAt
    };
}

/**
 * Build a simple searchable index from notes and their blocks
 * @param {Array<Object>} notes
 * @param {Object} blocksByNote - Map of noteId to blocks array
 * @returns {Array<{noteId: string, name: string, content: string, tags: string[], updatedAt: number}>}
 */
function buildIndex(notes, blocksByNote) {
    return notes.map(note => buildNoteEntry(note, blocksByNote[note.id] || []));
}

/**
 * Extract tags from text content (#tag format)
 * @param {string} text
 * @returns {string[]}
 */
function extractTags(text) {
    if (!text) return [];
    const tagRegex = /#([\w-]+)/g;
    const matches = text.matchAll(tagRegex);
    const tags = new Set();
    for (const match of matches) {
        tags.add(match[1].toLowerCase());
    }
    return Array.from(tags);
}
