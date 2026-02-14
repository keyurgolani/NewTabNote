/**
 * Search Indexer Web Worker
 * Processes notes and blocks to build a searchable index without blocking the main thread.
 */

self.onmessage = function (e) {
    const { type, data } = e.data;

    switch (type) {
        case 'INDEX_NOTES':
            const index = buildIndex(data.notes, data.blocks);
            self.postMessage({ type: 'INDEX_COMPLETE', data: index });
            break;
        case 'SEARCH':
            // Future: localized search within worker if index is large
            break;
    }
};

/**
 * Build a simple searchable index from notes and their blocks
 */
function buildIndex(notes, blocksByNote) {
    const index = [];

    notes.forEach(note => {
        const blocks = blocksByNote[note.id] || [];
        const content = blocks
            .map(b => b.content || '')
            .join(' ')
            .replace(/<[^>]*>?/gm, ''); // Strip HTML

        index.push({
            id: note.id,
            name: note.name || 'Untitled',
            content: content,
            tags: extractTags(content + ' ' + (note.name || '')),
            updatedAt: note.updatedAt
        });
    });

    return index;
}

/**
 * Extract tags from text content (#tag format)
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
