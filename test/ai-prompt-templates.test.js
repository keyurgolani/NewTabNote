const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultAIPromptTemplates,
  sanitizeAIPromptTemplates,
  getAIPromptTemplatesForScope,
  moveAIPromptTemplate,
} = require('../js/ai-prompt-templates.js');

test('AI prompt template defaults include note and global templates', () => {
  const templates = getDefaultAIPromptTemplates();

  assert.ok(templates.length >= 6);
  assert.ok(templates.some(template => template.scope === 'note'));
  assert.ok(templates.some(template => template.scope === 'global'));
  assert.ok(templates.every(template => template.label && template.prompt));
});

test('AI prompt template sanitization falls back to defaults for malformed saved data', () => {
  const templates = sanitizeAIPromptTemplates({ bad: true });

  assert.deepEqual(templates, getDefaultAIPromptTemplates());
});

test('AI prompt template filtering includes both-scope templates in each surface', () => {
  const templates = sanitizeAIPromptTemplates([
    { id: 'note-only', label: 'Note only', prompt: 'Summarize this note', scope: 'note', behavior: 'send' },
    { id: 'global-only', label: 'Global only', prompt: 'Find my tasks', scope: 'global', behavior: 'send' },
    { id: 'both-template', label: 'Works everywhere', prompt: 'Help me organize this', scope: 'both', behavior: 'prefill' },
  ]);

  assert.deepEqual(getAIPromptTemplatesForScope(templates, 'note').map(template => template.id), [
    'note-only',
    'both-template',
  ]);
  assert.deepEqual(getAIPromptTemplatesForScope(templates, 'global').map(template => template.id), [
    'global-only',
    'both-template',
  ]);
});

test('AI prompt template reorder moves templates up and down without dropping items', () => {
  const templates = sanitizeAIPromptTemplates([
    { id: 'first', label: 'First', prompt: 'one', scope: 'note', behavior: 'send' },
    { id: 'second', label: 'Second', prompt: 'two', scope: 'note', behavior: 'send' },
    { id: 'third', label: 'Third', prompt: 'three', scope: 'global', behavior: 'prefill' },
  ]);

  const movedUp = moveAIPromptTemplate(templates, 'third', 'up');
  assert.deepEqual(movedUp.map(template => template.id), ['first', 'third', 'second']);

  const movedDown = moveAIPromptTemplate(movedUp, 'first', 'down');
  assert.deepEqual(movedDown.map(template => template.id), ['third', 'first', 'second']);
});

test('AI prompt template sanitization keeps duplicate labels by assigning unique ids', () => {
  const templates = sanitizeAIPromptTemplates([
    { label: 'Review tasks', prompt: 'Review the tasks in this note', scope: 'note', behavior: 'send' },
    { label: 'Review tasks', prompt: 'Review the tasks across all notes', scope: 'global', behavior: 'send' },
  ]);

  assert.equal(templates.length, 2);
  assert.notEqual(templates[0].id, templates[1].id);
});

test('AI prompt template sanitization preserves explicit empty arrays for reset-only state', () => {
  const templates = sanitizeAIPromptTemplates([]);

  assert.deepEqual(templates, []);
});
