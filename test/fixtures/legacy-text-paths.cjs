/**
 * The text readers test/linear-text-paths.test.js holds to their 1.4.x output, copied word for
 * word: the editor's, AI chat's and the AI insights' from the v1.4.1 tag, and the note
 * domain's wiki-link names as `847379fd` had them (the kernel came after 1.4.1, with the
 * expression 1.4.1's Utils.extractWikiLinks has). Utils' Markdown rendering comes from the v1.4.1
 * release copy in test/fixtures/storage/releases/v1.4.1/js/utils.js, and its extractWikiLinks
 * is here too, for the tests that ran it beside the kernel.
 *
 * Nothing in the extension loads this file.
 */

'use strict';

// ============ Utils.extractWikiLinks (js/utils.js), which the editor's save ran ============

function extractWikiLinks(text) {
  if (!text) return [];
  const regex = /\[\[([^\]]+)\]\]/g;
  const links = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)]; // Return unique links
}

// ============ BlockEditor (js/editor.js) ============

function isFencedCode(text) {
  return /^```[\s\S]*```\s*$/m.test(text);
}

function extractFencedCode(text) {
  const match = text.match(/^```[^\n]*\n?([\s\S]*?)```\s*$/);
  return match ? match[1].replace(/\n$/, '') : text;
}

// ============ AIChatController (js/controllers/ai-chat-controller.js) ============

function parseRetryAfter(errorMsg) {
  const match = errorMsg.match(/(\d+)\s*s(?:ec(?:ond)?s?)?/i);
  return match ? parseInt(match[1], 10) : 30;
}

// ============ LLMService.extractInsights (js/llm.js), from the trim to the JSON it parses ============

function insightsJson(response) {
  // Parse JSON from response (handle potential markdown code blocks and surrounding text)
  let jsonStr = response.trim();

  // Try to extract JSON from markdown code blocks first
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Try to find JSON object directly (starts with { and ends with })
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }
  return jsonStr;
}

// ============ wikiLinkNames (js/kernel/core/domain/note.js) ============

function wikiLinkNames(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1].trim()))];
}

module.exports = { extractWikiLinks, isFencedCode, extractFencedCode, parseRetryAfter, insightsJson, wikiLinkNames };
