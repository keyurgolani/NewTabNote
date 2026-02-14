/**
 * Analytics Manager - handles data aggregation for stats and insights
 */
class AnalyticsManager {
    constructor() {
        this.storage = window.Storage;
    }

    /**
     * Get global overview stats
     */
    async getGlobalStats() {
        const notes = await this.storage.getAllNotes();
        const archived = await this.storage.getArchivedNotes();
        const trashed = await this.storage.getTrashedNotes();

        // Total word count (rough estimate from text blocks)
        let totalWords = 0;
        const allNotes = [...notes, ...archived, ...trashed];

        for (const note of allNotes) {
            const elements = await this.storage.getElementsByNote(note.id);
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
     * Get activity data for the last X days
     */
    async getActivityData(days = 30) {
        const notes = await this.storage.getAllNotes();
        const archived = await this.storage.getArchivedNotes();
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
     * Get distribution of tags
     */
    async getTagDistribution() {
        const notes = await this.storage.getAllNotes();
        const tagCounts = {};

        for (const note of notes) {
            const elements = await this.storage.getElementsByNote(note.id);
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
     * Get breakdown of content types (blocks)
     */
    async getContentTypeBreakdown() {
        const notes = await this.storage.getAllNotes();
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
            const elements = await this.storage.getElementsByNote(note.id);
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
     * Helper to extract tags from text
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
