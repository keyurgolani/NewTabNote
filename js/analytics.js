/**
 * Analytics Manager - handles data aggregation for stats and insights. It counts what the new
 * tab's note list lists (js/kernel/core/application/note-list.js), and reads each note's
 * blocks through the page's document client; App gives it both with connect().
 */
class AnalyticsManager {
    constructor() {
        /** @type {{view(name: string): ReadonlyArray<any>} | null} */
        this.noteList = null;
        /** @type {((noteId: string) => Promise<Array<any>>) | null} */
        this.getNoteBlocks = null;
    }

    /**
     * Give it the note list it counts, and the reader of a note's blocks.
     * @param {{noteList: {view(name: string): ReadonlyArray<any>}, getNoteBlocks: (noteId: string) => Promise<Array<any>>}} sources
     * @returns {void}
     */
    connect({ noteList, getNoteBlocks }) {
        this.noteList = noteList;
        this.getNoteBlocks = getNoteBlocks;
    }

    /**
     * A view of the note list, or no notes before connect()
     * @param {string} name
     * @returns {ReadonlyArray<any>}
     */
    _view(name) {
        return this.noteList ? this.noteList.view(name) : [];
    }

    /**
     * A note's blocks, or none before connect()
     * @param {string} noteId
     * @returns {Promise<Array<any>>}
     */
    async _blocksOf(noteId) {
        return this.getNoteBlocks ? this.getNoteBlocks(noteId) : [];
    }

    /**
     * Get global overview stats.
     * @returns {Promise<{totalNotes: number, archivedNotes: number, trashedNotes: number, totalWords: number}>} Overview statistics
     */
    async getGlobalStats() {
        const notes = this._view('active');
        const archived = this._view('archived');
        const trashed = this._view('trashed');

        // Total word count (rough estimate from text blocks)
        let totalWords = 0;
        const allNotes = [...notes, ...archived, ...trashed];

        for (const note of allNotes) {
            const elements = await this._blocksOf(note.id);
            for (const el of elements) {
                if (el.type === 'text' && el.content) {
                    totalWords += el.content.trim().split(/\s+/).length;
                }
            }
        }

        return {
            totalNotes: notes.length,
            archivedNotes: archived.length,
            trashedNotes: trashed.length,
            totalWords: totalWords,
        };
    }

    /**
     * Get activity data for the last X days.
     * @param {number} [days=30] - Number of days to look back
     * @returns {Promise<Array<{date: string, created: number, updated: number}>>} Activity data sorted by date
     */
    async getActivityData(days = 30) {
        const notes = this._view('active');
        const archived = this._view('archived');
        const allNotes = [...notes, ...archived];

        const activityMap = {};
        const now = new Date();

        // Initialize map with 0s for the last X days
        for (let i = 0; i < days; i++) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            activityMap[dateKey] = { created: 0, updated: 0 };
        }

        for (const note of allNotes) {
            const createdDate = new Date(note.createdAt).toISOString().split('T')[0];
            const updatedDate = new Date(note.updatedAt).toISOString().split('T')[0];

            if (activityMap[createdDate]) {
                activityMap[createdDate].created++;
            }
            if (activityMap[updatedDate]) {
                activityMap[updatedDate].updated++;
            }
        }

        // Convert map to sorted array
        return Object.entries(activityMap)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, counts]) => ({ date, ...counts }));
    }

    /**
     * Get distribution of tags across all notes.
     * @returns {Promise<Array<[string, number]>>} Top 10 tags as [tag, count] pairs
     */
    async getTagDistribution() {
        const notes = this._view('active');
        const tagCounts = {};

        for (const note of notes) {
            const elements = await this._blocksOf(note.id);
            const textContent = elements
                .filter(el => el.type === 'text')
                .map(el => el.content)
                .join(' ');

            const tags = this.extractTags(textContent);
            tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        }

        return Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1]) // Sort by count descending
            .slice(0, 10); // Top 10 tags
    }

    /**
     * Get breakdown of content types (blocks) across all notes.
     * @returns {Promise<Object<string, number>>} Block type counts
     */
    async getContentTypeBreakdown() {
        const notes = this._view('active');
        const typeCounts = {
            text: 0,
            image: 0,
            todo: 0,
            bookmark: 0,
            code: 0,
            video: 0,
            file: 0
        };

        for (const note of notes) {
            const elements = await this._blocksOf(note.id);
            elements.forEach(el => {
                if (typeCounts.hasOwnProperty(el.type)) {
                    typeCounts[el.type]++;
                } else {
                    typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
                }
            });
        }

        return typeCounts;
    }

    /**
     * Extract hashtags from text content.
     * @param {string} text - Text to extract tags from
     * @returns {Array<string>} Unique lowercase tags
     */
    extractTags(text) {
        if (!text) return [];
        const tagRegex = /#([\w-]+)/g;
        const matches = text.matchAll(tagRegex);
        const tags = new Set();
        for (const match of matches) {
            tags.add(match[1].toLowerCase());
        }
        return Array.from(tags);
    }
}

// Global instance
const Analytics = new AnalyticsManager();
(typeof window !== 'undefined' ? window : self).Analytics = Analytics;
