(function (global) {
  /**
   * Normalize a palette query string to lowercase trimmed form.
   * @param {string} [query=''] - Raw query
   * @returns {string} Normalized query
   */
  function normalizePaletteQuery(query = '') {
    return String(query)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function toTokens(query) {
    const normalized = normalizePaletteQuery(query);
    return normalized ? normalized.split(' ') : [];
  }

  function buildBadges(item) {
    const badges = Array.isArray(item.badges) ? [...item.badges] : [];

    if (item.isActive) {
      badges.push('Current');
    }

    if (item.isOpen) {
      badges.push('Open');
    }

    return badges;
  }

  function getSubsequenceScore(text, token, baseScore) {
    let previousIndex = -1;
    let gapPenalty = 0;

    for (const char of token) {
      const index = text.indexOf(char, previousIndex + 1);
      if (index === -1) {
        return 0;
      }

      gapPenalty += Math.max(0, index - previousIndex - 1);
      previousIndex = index;
    }

    return Math.max(8, baseScore - gapPenalty);
  }

  function scoreField(textValue, tokens, weights) {
    const text = normalizePaletteQuery(textValue);
    if (!text || !tokens.length) {
      return 0;
    }

    let total = 0;

    for (const token of tokens) {
      let tokenScore = 0;

      if (text === token) {
        tokenScore = weights.exact;
      } else if (text.startsWith(token)) {
        tokenScore = weights.prefix;
      } else if (text.includes(token)) {
        tokenScore = weights.contains;
      } else {
        tokenScore = getSubsequenceScore(text, token, weights.subsequence);
      }

      if (!tokenScore) {
        return 0;
      }

      total += tokenScore;
    }

    return total;
  }

  function createCommandItem(command, queryTokens, index) {
    const title = command.title || 'Untitled Command';
    const subtitle = command.subtitle || command.description || '';
    const keywords = Array.isArray(command.keywords) ? command.keywords : [];
    const emptyQuery = queryTokens.length === 0;

    let score;
    if (emptyQuery) {
      score = 10000 - index;
    } else {
      score = Math.max(
        scoreField(title, queryTokens, {
          exact: 240,
          prefix: 190,
          contains: 150,
          subsequence: 120,
        }),
        scoreField(keywords.join(' '), queryTokens, {
          exact: 210,
          prefix: 170,
          contains: 140,
          subsequence: 135,
        }),
        scoreField(subtitle, queryTokens, {
          exact: 150,
          prefix: 120,
          contains: 90,
          subsequence: 72,
        })
      );
    }

    if (!score) {
      return null;
    }

    return {
      id: `command:${command.id}`,
      commandId: command.id,
      kind: 'command',
      title,
      subtitle,
      icon: command.icon || null,
      score,
    };
  }

  function createNoteItem(note, queryTokens) {
    const title = note.name || 'Untitled';
    const preview = note.preview || '';
    const searchText = note.searchText || preview;
    const tags = Array.isArray(note.tags) ? note.tags : [];
    const badges = buildBadges(note);
    const emptyQuery = queryTokens.length === 0;

    let score;
    if (emptyQuery) {
      score = 5000 + ((Number(note.updatedAt) || Number(note.createdAt) || 0) / 1e13);
    } else {
      const titleScore = scoreField(title, queryTokens, {
        exact: 220,
        prefix: 180,
        contains: 150,
        subsequence: 110,
      });
      const previewScore = scoreField(preview, queryTokens, {
        exact: 110,
        prefix: 90,
        contains: 75,
        subsequence: 54,
      });
      const contentScore = scoreField(searchText, queryTokens, {
        exact: 95,
        prefix: 80,
        contains: 65,
        subsequence: 48,
      });
      const tagScore = scoreField(tags.join(' '), queryTokens, {
        exact: 90,
        prefix: 72,
        contains: 60,
        subsequence: 42,
      });

      score = Math.max(titleScore, previewScore, contentScore, tagScore);

      if (score && titleScore) {
        score += 20;
      }
    }

    if (!score) {
      return null;
    }

    return {
      id: `note:${note.id}`,
      noteId: note.id,
      kind: 'note',
      title,
      subtitle: preview,
      badges,
      updatedAt: note.updatedAt || note.createdAt || 0,
      score,
    };
  }

  /**
   * Build a ranked list of command palette items from commands and notes.
   * @param {Object} [options={}] - Options
   * @param {string} [options.query=''] - Search query
   * @param {Array<Object>} [options.commands=[]] - Available commands
   * @param {Array<Object>} [options.notes=[]] - Available notes
   * @param {number} [options.limit=12] - Maximum items to return
   * @returns {Array<{id: string, kind: string, title: string, subtitle: string, score: number}>} Ranked items
   */
  function buildCommandPaletteItems({
    query = '',
    commands = [],
    notes = [],
    limit = 12,
  } = {}) {
    const queryTokens = toTokens(query);
    const items = [];

    commands.forEach((command, index) => {
      const item = createCommandItem(command, queryTokens, index);
      if (item) {
        items.push(item);
      }
    });

    notes.forEach(note => {
      const item = createNoteItem(note, queryTokens);
      if (item) {
        items.push(item);
      }
    });

    items.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      if (a.kind !== b.kind) {
        return a.kind === 'command' ? -1 : 1;
      }

      if (a.kind === 'note' && b.kind === 'note' && b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }

      return a.title.localeCompare(b.title);
    });

    return items.slice(0, limit);
  }

  const api = {
    buildCommandPaletteItems,
    normalizePaletteQuery,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.CommandPaletteUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
