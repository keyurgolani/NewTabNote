(function (global) {
  const VALID_SCOPES = new Set(['note', 'global', 'both']);
  const VALID_BEHAVIORS = new Set(['send', 'prefill']);

  /**
   * @typedef {Object} AIPromptTemplate
   * @property {string} id - Unique template identifier
   * @property {string} label - Display label (max 40 chars)
   * @property {string} prompt - Prompt text (max 1000 chars)
   * @property {'note'|'global'|'both'} scope - Template scope
   * @property {'send'|'prefill'} behavior - Template behavior
   */

  const DEFAULT_AI_PROMPT_TEMPLATES = Object.freeze([
    Object.freeze({
      id: 'note-summarize',
      label: 'Summarize note',
      prompt: 'Summarize this note',
      scope: 'note',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'note-expand',
      label: 'Expand content',
      prompt: 'Expand on the main points in this note',
      scope: 'note',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'note-title',
      label: 'Generate title',
      prompt: 'Generate a concise title for this note',
      scope: 'note',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'note-takeaways',
      label: 'Key takeaways',
      prompt: 'What are the key takeaways from this note?',
      scope: 'note',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'note-questions',
      label: 'Suggest questions',
      prompt: 'Suggest follow-up questions based on this note',
      scope: 'note',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'global-deadlines',
      label: 'Upcoming deadlines',
      prompt: 'What are my upcoming deadlines?',
      scope: 'global',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'global-meetings',
      label: 'Meeting summaries',
      prompt: 'Summarize my recent meeting notes',
      scope: 'global',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'global-tasks',
      label: 'Pending tasks',
      prompt: 'What tasks do I have pending?',
      scope: 'global',
      behavior: 'send',
    }),
    Object.freeze({
      id: 'global-find',
      label: 'Find notes about...',
      prompt: 'Find notes about',
      scope: 'global',
      behavior: 'prefill',
    }),
  ]);

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  /**
   * Get a copy of the default AI prompt templates.
   * @returns {Array<AIPromptTemplate>} Default templates
   */
  function getDefaultAIPromptTemplates() {
    return DEFAULT_AI_PROMPT_TEMPLATES.map(template => ({ ...template }));
  }

  /**
   * Sanitize and validate a single AI prompt template.
   * @param {Object} template - Raw template object
   * @param {number} index - Index for fallback ID generation
   * @returns {AIPromptTemplate|null} Sanitized template or null if invalid
   */
  function sanitizeAIPromptTemplate(template, index) {
    if (!template || typeof template !== 'object') {
      return null;
    }

    const label = String(template.label || '').trim().slice(0, 40);
    const prompt = String(template.prompt || '').trim().slice(0, 1000);

    if (!label || !prompt) {
      return null;
    }

    const scope = VALID_SCOPES.has(template.scope) ? template.scope : 'note';
    const behavior = VALID_BEHAVIORS.has(template.behavior) ? template.behavior : 'send';
    const id = slugify(template.id || label) || `ai-template-${index + 1}`;

    return {
      id,
      label,
      prompt,
      scope,
      behavior,
    };
  }

  /**
   * Sanitize an array of AI prompt templates, deduplicating IDs.
   * @param {Array<Object>|null|undefined} templates - Raw templates array
   * @returns {Array<AIPromptTemplate>} Sanitized templates
   */
  function sanitizeAIPromptTemplates(templates) {
    if (templates == null) {
      return getDefaultAIPromptTemplates();
    }

    if (!Array.isArray(templates)) {
      return getDefaultAIPromptTemplates();
    }

    const usedIds = new Set();
    const sanitized = [];

    templates.forEach((template, index) => {
      const normalized = sanitizeAIPromptTemplate(template, index);
      if (!normalized) {
        return;
      }

      let candidateId = normalized.id;
      let suffix = 2;

      while (usedIds.has(candidateId)) {
        candidateId = `${normalized.id}-${suffix}`;
        suffix += 1;
      }

      usedIds.add(candidateId);
      sanitized.push({
        ...normalized,
        id: candidateId,
      });
    });

    if (sanitized.length === 0 && templates.length > 0) {
      return getDefaultAIPromptTemplates();
    }

    return sanitized;
  }

  /**
   * Filter templates by scope ('note' or 'global').
   * @param {Array<Object>} templates - Templates to filter
   * @param {'note'|'global'} scope - Scope to filter by
   * @returns {Array<AIPromptTemplate>} Matching templates
   */
  function getAIPromptTemplatesForScope(templates, scope) {
    if (!VALID_SCOPES.has(scope) || scope === 'both') {
      return [];
    }

    return sanitizeAIPromptTemplates(templates).filter(template => {
      return template.scope === scope || template.scope === 'both';
    });
  }

  /**
   * Move a template up or down in the list.
   * @param {Array<Object>} templates - Templates array
   * @param {string} id - Template ID to move
   * @param {'up'|'down'} direction - Direction to move
   * @returns {Array<AIPromptTemplate>} Reordered templates
   */
  function moveAIPromptTemplate(templates, id, direction) {
    const items = sanitizeAIPromptTemplates(templates);
    const index = items.findIndex(template => template.id === id);

    if (index === -1) {
      return items;
    }

    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const nextIndex = index + delta;

    if (nextIndex < 0 || nextIndex >= items.length || delta === 0) {
      return items;
    }

    const reordered = items.slice();
    const [item] = reordered.splice(index, 1);
    reordered.splice(nextIndex, 0, item);
    return reordered;
  }

  const api = {
    DEFAULT_AI_PROMPT_TEMPLATES,
    getDefaultAIPromptTemplates,
    sanitizeAIPromptTemplates,
    getAIPromptTemplatesForScope,
    moveAIPromptTemplate,
  };

  global.AIPromptTemplates = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof window !== 'undefined' ? window : globalThis));
