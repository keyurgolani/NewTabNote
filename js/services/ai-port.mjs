/**
 * The AI port (#12 slice 4): the provider calls the new tab's editors and note jobs make, in
 * place of BlockEditor.getLLM's lookup of the LLM global. The new tab's composition root
 * (js/kernel/composition/newtab.js) builds it, and App hands it to every editor, the PiP
 * editor's included, and to NotesManager.
 *
 * This module is the one place the port names the LLM global (js/llm.js), and the kernel
 * ledger has a row for it, owned by #11, whose provider registry injects the port in its
 * place. It reads the global when a call is made, not when the port is built, since
 * LLM.init runs in App.init, after the root builds the port.
 *
 * It's an .mjs file because Node reads js/services/ as CommonJS (js/services/sync-service.js
 * is required by its tests), and the kernel's tests import the new tab's root.
 */

/**
 * @typedef {object} AIPort
 * @property {() => boolean} isConfigured - whether a provider is set up, now
 * @property {(text: string) => Promise<string | null>} generateTitle
 * @property {(text: string, name?: string) => Promise<object | null>} extractInsights
 * @property {(messages: Array<{role: string, content: string}>) => Promise<string>} chat
 */

/**
 * The LLM service js/llm.js puts on the page, if it has loaded
 * @returns {any}
 */
const provider = () => /** @type {{LLM?: unknown}} */ (globalThis).LLM;

/**
 * @returns {AIPort}
 */
export function createAIPort() {
  /** @returns {any} the service, which a call needs */
  const service = () => {
    const llm = provider();
    if (!llm) throw new Error('NewTabNote: the AI provider service has not loaded');
    return llm;
  };
  return Object.freeze({
    isConfigured: () => {
      const llm = provider();
      return Boolean(llm && llm.isConfigured());
    },
    generateTitle: async text => service().generateTitle(text),
    extractInsights: async (text, name) => service().extractInsights(text, name),
    chat: async messages => service().chat(messages),
  });
}
