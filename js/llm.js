/**
 * LLM Service for AI-powered features
 * Supports OpenAI, Anthropic, OpenRouter, Gemini, xAI, Deepseek, Mistral, Groq,
 * Qwen, GLM, Kimi, MiniMax, and Ollama providers with dynamic model loading from APIs
 */

class LLMService {
  constructor() {
    this.provider = 'none';
    this.apiKey = '';
    this.model = '';
    this.ollamaUrl = 'http://localhost:11434';
    this.cachedModels = {};
    this.loadingModels = false;
  }

  async init() {
    this.provider = await Storage.getSetting('llmProvider', 'none');
    this.apiKey = await Storage.getSetting('llmApiKey', '');
    this.model = await Storage.getSetting('llmModel', '');
    this.ollamaUrl = await Storage.getSetting('ollamaUrl', 'http://localhost:11434');
  }

  isConfigured() {
    if (this.provider === 'none') return false;
    if (this.provider === 'ollama') return true; // Ollama doesn't need API key
    return !!this.apiKey;
  }

  /**
   * Make an API request via the background service worker to bypass CORS
   * Falls back to direct fetch if background worker is unavailable
   */
  async fetchViaBackground(url, options = {}) {
    // Check if chrome.runtime is available (extension context)
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error('Background worker timeout'));
          }, 30000); // 30 second timeout
          
          chrome.runtime.sendMessage(
            { type: 'API_REQUEST', url, options },
            (response) => {
              clearTimeout(timeoutId);
              
              if (chrome.runtime.lastError) {
                console.warn('Background worker error:', chrome.runtime.lastError.message);
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (!response) {
                reject(new Error('No response from background worker'));
                return;
              }
              if (response.error) {
                reject(new Error(response.error));
                return;
              }
              resolve(response);
            }
          );
        });
      } catch (bgError) {
        console.warn('Background fetch failed, trying direct fetch:', bgError.message);
        // Fall through to direct fetch
      }
    }

    // Fallback to direct fetch (may fail due to CORS for some endpoints)
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }
    
    return {
      ok: response.ok,
      status: response.status,
      data: data
    };
  }

  /**
   * Get fallback models for a provider (used when API fetch fails)
   */
  getFallbackModels(provider) {
    const models = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'o1', name: 'o1' },
        { id: 'o1-mini', name: 'o1 Mini' },
        { id: 'o1-preview', name: 'o1 Preview' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
      ],
      anthropic: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
      ],
      gemini: [
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      ],
      xai: [
        { id: 'grok-3', name: 'Grok 3' },
        { id: 'grok-3-fast', name: 'Grok 3 Fast' },
        { id: 'grok-2', name: 'Grok 2' },
        { id: 'grok-2-mini', name: 'Grok 2 Mini' },
        { id: 'grok-beta', name: 'Grok Beta' },
      ],
      deepseek: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' },
      ],
      mistral: [
        { id: 'mistral-large-latest', name: 'Mistral Large' },
        { id: 'mistral-medium-latest', name: 'Mistral Medium' },
        { id: 'mistral-small-latest', name: 'Mistral Small' },
        { id: 'codestral-latest', name: 'Codestral' },
        { id: 'open-mixtral-8x22b', name: 'Mixtral 8x22B' },
        { id: 'open-mixtral-8x7b', name: 'Mixtral 8x7B' },
        { id: 'open-mistral-7b', name: 'Mistral 7B' },
      ],
      groq: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
        { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
        { id: 'llama3-70b-8192', name: 'Llama 3 70B' },
        { id: 'llama3-8b-8192', name: 'Llama 3 8B' },
        { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
        { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
      ],
      qwen: [
        { id: 'qwen-max', name: 'Qwen Max' },
        { id: 'qwen-plus', name: 'Qwen Plus' },
        { id: 'qwen-turbo', name: 'Qwen Turbo' },
        { id: 'qwen-long', name: 'Qwen Long' },
        { id: 'qwen2.5-72b-instruct', name: 'Qwen 2.5 72B' },
        { id: 'qwen2.5-32b-instruct', name: 'Qwen 2.5 32B' },
        { id: 'qwen2.5-14b-instruct', name: 'Qwen 2.5 14B' },
        { id: 'qwen2.5-7b-instruct', name: 'Qwen 2.5 7B' },
      ],
      glm: [
        { id: 'glm-4-plus', name: 'GLM-4 Plus' },
        { id: 'glm-4-air', name: 'GLM-4 Air' },
        { id: 'glm-4-airx', name: 'GLM-4 AirX' },
        { id: 'glm-4-long', name: 'GLM-4 Long' },
        { id: 'glm-4-flash', name: 'GLM-4 Flash' },
        { id: 'glm-4', name: 'GLM-4' },
      ],
      kimi: [
        { id: 'moonshot-v1-128k', name: 'Moonshot 128K' },
        { id: 'moonshot-v1-32k', name: 'Moonshot 32K' },
        { id: 'moonshot-v1-8k', name: 'Moonshot 8K' },
      ],
      minimax: [
        { id: 'abab6.5s-chat', name: 'ABAB 6.5s Chat' },
        { id: 'abab6.5-chat', name: 'ABAB 6.5 Chat' },
        { id: 'abab5.5s-chat', name: 'ABAB 5.5s Chat' },
        { id: 'abab5.5-chat', name: 'ABAB 5.5 Chat' },
      ],
      openrouter: [
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
        { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
        { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
      ],
      ollama: [],
    };
    return models[provider] || [];
  }

  /**
   * Fetch models dynamically from provider API
   */
  async fetchModels(provider, apiKey) {
    if (!provider || provider === 'none') return [];
    
    // For Ollama, no API key needed
    if (provider === 'ollama') {
      return this.fetchOllamaModels();
    }
    
    // Other providers need API key
    if (!apiKey) return this.getFallbackModels(provider);

    try {
      switch (provider) {
        case 'openai':
          return await this.fetchOpenAIModels(apiKey);
        case 'anthropic':
          return await this.fetchAnthropicModels(apiKey);
        case 'gemini':
          return await this.fetchGeminiModels(apiKey);
        case 'openrouter':
          return await this.fetchOpenRouterModels(apiKey);
        case 'xai':
          return await this.fetchXAIModels(apiKey);
        case 'deepseek':
          return await this.fetchDeepseekModels(apiKey);
        case 'mistral':
          return await this.fetchMistralModels(apiKey);
        case 'groq':
          return await this.fetchGroqModels(apiKey);
        case 'qwen':
          return await this.fetchQwenModels(apiKey);
        case 'glm':
          return await this.fetchGLMModels(apiKey);
        case 'kimi':
          return await this.fetchKimiModels(apiKey);
        case 'minimax':
          return await this.fetchMiniMaxModels(apiKey);
        default:
          return this.getFallbackModels(provider);
      }
    } catch (error) {
      console.warn(`Failed to fetch models for ${provider}:`, error);
      return this.getFallbackModels(provider);
    }
  }

  async fetchOpenAIModels(apiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch OpenAI models, using fallback list');
        return this.getFallbackModels('openai');
      }
      
      const data = await response.json();
      const chatModels = (data.data || [])
        .filter(m => m.id.startsWith('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3'))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(m => ({ id: m.id, name: m.id }));
      
      return chatModels.length > 0 ? chatModels : this.getFallbackModels('openai');
    } catch (error) {
      console.warn('OpenAI models fetch error:', error);
      return this.getFallbackModels('openai');
    }
  }

  async fetchAnthropicModels(apiKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch Anthropic models, using fallback list');
        return this.getFallbackModels('anthropic');
      }
      
      const data = await response.json();
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.display_name || m.id,
      }));
      
      return models.length > 0 ? models : this.getFallbackModels('anthropic');
    } catch (error) {
      console.warn('Anthropic models fetch error:', error);
      return this.getFallbackModels('anthropic');
    }
  }

  async fetchGeminiModels(apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );
      
      if (!response.ok) {
        console.warn('Failed to fetch Gemini models, using fallback');
        return this.getFallbackModels('gemini');
      }
      
      const data = await response.json();
      const chatModels = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
        }))
        // Sort to show newer models first (gemini-2.x before gemini-1.x)
        .sort((a, b) => b.id.localeCompare(a.id));
      
      return chatModels.length > 0 ? chatModels : this.getFallbackModels('gemini');
    } catch (error) {
      console.warn('Gemini models fetch error:', error);
      return this.getFallbackModels('gemini');
    }
  }

  async fetchOpenRouterModels(apiKey) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch OpenRouter models');
        return this.getFallbackModels('openrouter');
      }
      
      const data = await response.json();
      const models = (data.data || [])
        .slice(0, 100)
        .map(m => ({ 
          id: m.id, 
          name: m.name || m.id 
        }));
      
      return models.length > 0 ? models : this.getFallbackModels('openrouter');
    } catch (error) {
      console.warn('OpenRouter models fetch error:', error);
      return this.getFallbackModels('openrouter');
    }
  }

  async fetchXAIModels(apiKey) {
    try {
      const response = await fetch('https://api.x.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch xAI models, using fallback');
        return this.getFallbackModels('xai');
      }
      
      const data = await response.json();
      const models = (data.data || [])
        .filter(m => m.id.startsWith('grok'))
        .map(m => ({ id: m.id, name: m.id }));
      
      return models.length > 0 ? models : this.getFallbackModels('xai');
    } catch (error) {
      console.warn('xAI models fetch error:', error);
      return this.getFallbackModels('xai');
    }
  }

  async fetchDeepseekModels(apiKey) {
    try {
      const response = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch Deepseek models, using fallback');
        return this.getFallbackModels('deepseek');
      }
      
      const data = await response.json();
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
      }));
      
      return models.length > 0 ? models : this.getFallbackModels('deepseek');
    } catch (error) {
      console.warn('Deepseek models fetch error:', error);
      return this.getFallbackModels('deepseek');
    }
  }

  async fetchMistralModels(apiKey) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch Mistral models, using fallback');
        return this.getFallbackModels('mistral');
      }
      
      const data = await response.json();
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
      }));
      
      return models.length > 0 ? models : this.getFallbackModels('mistral');
    } catch (error) {
      console.warn('Mistral models fetch error:', error);
      return this.getFallbackModels('mistral');
    }
  }

  async fetchGroqModels(apiKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (!response.ok) {
        console.warn('Failed to fetch Groq models, using fallback');
        return this.getFallbackModels('groq');
      }
      
      const data = await response.json();
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
      }));
      
      return models.length > 0 ? models : this.getFallbackModels('groq');
    } catch (error) {
      console.warn('Groq models fetch error:', error);
      return this.getFallbackModels('groq');
    }
  }

  async fetchQwenModels(apiKey) {
    // Qwen (DashScope) doesn't have a public models list API, use fallback
    return this.getFallbackModels('qwen');
  }

  async fetchGLMModels(apiKey) {
    // GLM (Zhipu) doesn't have a public models list API, use fallback
    return this.getFallbackModels('glm');
  }

  async fetchKimiModels(apiKey) {
    // Kimi (Moonshot) doesn't have a public models list API, use fallback
    return this.getFallbackModels('kimi');
  }

  async fetchMiniMaxModels(apiKey) {
    // MiniMax doesn't have a public models list API, use fallback
    return this.getFallbackModels('minimax');
  }

  async fetchOllamaModels() {
    try {
      const response = await this.fetchViaBackground(`${this.ollamaUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        if (response.status === 403) {
          console.warn('Ollama CORS error: Run Ollama with OLLAMA_ORIGINS=chrome-extension://* ollama serve');
        }
        throw new Error('Failed to connect to Ollama');
      }
      
      const data = response.data;
      return data.models?.map(m => ({
        id: m.name,
        name: `${m.name} (${this.formatBytes(m.size)})`,
      })) || [];
    } catch (error) {
      console.warn('Ollama not available:', error);
      return [];
    }
  }

  formatModelName(id) {
    return id
      .replace(/^models\//, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  formatBytes(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  }

  getDefaultModelForProvider(provider) {
    const defaults = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-3-5-sonnet-20241022',
      gemini: 'gemini-2.0-flash',
      xai: 'grok-2',
      deepseek: 'deepseek-chat',
      mistral: 'mistral-small-latest',
      groq: 'llama-3.3-70b-versatile',
      qwen: 'qwen-turbo',
      glm: 'glm-4-flash',
      kimi: 'moonshot-v1-8k',
      minimax: 'abab6.5s-chat',
      openrouter: 'openai/gpt-4o-mini',
      ollama: 'llama3.2',
    };
    return defaults[provider] || '';
  }

  async setProvider(provider) {
    this.provider = provider;
    await Storage.setSetting('llmProvider', provider);
    
    // Clear cached models for this provider to force refresh
    delete this.cachedModels[provider];
    
    // Set default model for the provider
    const defaultModel = this.getDefaultModelForProvider(provider);
    await this.setModel(defaultModel);
  }

  async setApiKey(apiKey) {
    this.apiKey = apiKey;
    await Storage.setSetting('llmApiKey', apiKey);
    
    // Clear cached models to force refresh with new key
    delete this.cachedModels[this.provider];
  }

  async setModel(model) {
    this.model = model;
    await Storage.setSetting('llmModel', model);
  }

  async setOllamaUrl(url) {
    this.ollamaUrl = url;
    await Storage.setSetting('ollamaUrl', url);
    delete this.cachedModels['ollama'];
  }

  async chat(messages) {
    if (!this.isConfigured()) {
      throw new Error('LLM not configured. Please set up API key in settings.');
    }
    
    if (!this.model) {
      throw new Error('No model selected. Please select a model in settings.');
    }

    switch (this.provider) {
      case 'openai':
        return this.chatOpenAI(messages);
      case 'anthropic':
        return this.chatAnthropic(messages);
      case 'gemini':
        return this.chatGemini(messages);
      case 'openrouter':
        return this.chatOpenRouter(messages);
      case 'xai':
        return this.chatXAI(messages);
      case 'deepseek':
        return this.chatDeepseek(messages);
      case 'mistral':
        return this.chatMistral(messages);
      case 'groq':
        return this.chatGroq(messages);
      case 'qwen':
        return this.chatQwen(messages);
      case 'glm':
        return this.chatGLM(messages);
      case 'kimi':
        return this.chatKimi(messages);
      case 'minimax':
        return this.chatMiniMax(messages);
      case 'ollama':
        return this.chatOllama(messages);
      default:
        throw new Error('Unknown provider');
    }
  }

  async chatOpenAI(messages) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'gpt-4o-mini',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatAnthropic(messages) {
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model || 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        system: systemMessage,
        messages: userMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Anthropic API error');
    }

    const data = await response.json();
    return data.content[0].text;
  }

  async chatGemini(messages) {
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');
    
    // Convert to Gemini format
    const contents = userMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const model = this.model || 'gemini-1.5-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: systemMessage ? { parts: [{ text: systemMessage }] } : undefined,
          generationConfig: { maxOutputTokens: 2000 },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }

  async chatOpenRouter(messages) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'chrome-extension://new-tab-note',
        'X-Title': 'New Tab Note',
      },
      body: JSON.stringify({
        model: this.model || 'openai/gpt-4o-mini',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'OpenRouter API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatXAI(messages) {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'grok-2',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'xAI API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatDeepseek(messages) {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'deepseek-chat',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Deepseek API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatMistral(messages) {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'mistral-small-latest',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Mistral API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatGroq(messages) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Groq API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatQwen(messages) {
    // Qwen uses DashScope API (Alibaba Cloud)
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'qwen-turbo',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Qwen API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatGLM(messages) {
    // GLM uses Zhipu AI API
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'glm-4-flash',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'GLM API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatKimi(messages) {
    // Kimi uses Moonshot API
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'moonshot-v1-8k',
        messages: messages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Kimi API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatMiniMax(messages) {
    // MiniMax API
    const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || 'abab6.5s-chat',
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'system' : (m.role === 'assistant' ? 'assistant' : 'user'),
          content: m.content,
        })),
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.base_resp?.status_msg || 'MiniMax API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async chatOllama(messages) {
    const requestBody = {
      model: this.model || 'llama3.2',
      messages: messages,
      stream: false,
    };
    
    const response = await this.fetchViaBackground(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      // Check for CORS/403 error and provide helpful message
      if (response.status === 403) {
        throw new Error(
          'Ollama blocked the request (403 Forbidden). ' +
          'To fix this, restart Ollama with: OLLAMA_ORIGINS=chrome-extension://* ollama serve'
        );
      }
      const errorMessage = response.data?.error || response.error || `Ollama API error (status: ${response.status})`;
      throw new Error(errorMessage);
    }

    return response.data.message.content;
  }

  async summarize(content) {
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful assistant that summarizes notes concisely. Provide a clear, well-structured summary.',
      },
      {
        role: 'user',
        content: `Please summarize the following note:\n\n${content}`,
      },
    ];
    return this.chat(messages);
  }

  async expand(content) {
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful assistant that expands on notes with additional details, examples, and explanations.',
      },
      {
        role: 'user',
        content: `Please expand on the following note with more details:\n\n${content}`,
      },
    ];
    return this.chat(messages);
  }

  async ask(content, question) {
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful assistant that answers questions about notes. Use the note content as context to provide accurate answers.',
      },
      {
        role: 'user',
        content: `Note content:\n${content}\n\nQuestion: ${question}`,
      },
    ];
    return this.chat(messages);
  }

  /**
   * Generate a title for a note based on its content
   * Returns a concise, descriptive title (max 50 chars)
   */
  async generateTitle(content) {
    if (!content || content.trim().length < 10) {
      return null; // Not enough content to generate a meaningful title
    }

    const messages = [
      {
        role: 'system',
        content: `You are a title generator. Generate a concise, descriptive title for the given note content.
Rules:
- Maximum 50 characters
- No quotes or special formatting
- Capture the main topic or theme
- Be specific but brief
- Return ONLY the title, nothing else`,
      },
      {
        role: 'user',
        content: `Generate a title for this note:\n\n${content.substring(0, 2000)}`, // Limit content to avoid token limits
      },
    ];

    try {
      const title = await this.chat(messages);
      // Clean up the response - remove quotes, trim, limit length
      return title
        .replace(/^["']|["']$/g, '')
        .replace(/^Title:\s*/i, '')
        .trim()
        .substring(0, 50);
    } catch (error) {
      console.error('Failed to generate title:', error);
      return null;
    }
  }

  /**
   * Extract actionable insights from note content
   * Returns structured data with todos, reminders, deadlines, highlights, and tags
   */
  async extractInsights(content, noteTitle = '') {
    if (!content || content.trim().length < 20) {
      return null;
    }

    const today = new Date().toISOString().split('T')[0];
    
    const messages = [
      {
        role: 'system',
        content: `You are an assistant that extracts actionable insights from notes. Today's date is ${today}.

Analyze the note and extract:
1. **todos**: Action items or tasks to complete (things to do)
2. **reminders**: Things to remember or keep in mind
3. **deadlines**: Important dates, deadlines, or time-sensitive items (include the date if mentioned)
4. **highlights**: Key information, important facts, or notable points
5. **tags**: Relevant topic tags or categories for this note (e.g., "work", "personal", "meeting", "project-x", "finance")

Rules:
- Only extract items that are clearly stated or strongly implied
- For deadlines, always try to include the specific date in YYYY-MM-DD format if mentioned
- Keep each item concise (max 100 characters)
- Maximum 5 items per category
- For tags: generate 2-5 short, lowercase tags (no spaces, use hyphens for multi-word tags)
- Tags should reflect the main topics, projects, or categories of the note
- If a category has no items, return an empty array
- Return ONLY valid JSON, no markdown or explanation

Return JSON in this exact format:
{
  "todos": ["item1", "item2"],
  "reminders": ["item1", "item2"],
  "deadlines": [{"text": "description", "date": "YYYY-MM-DD"}],
  "highlights": ["item1", "item2"],
  "tags": ["tag1", "tag2", "tag3"]
}`,
      },
      {
        role: 'user',
        content: `Note title: ${noteTitle || 'Untitled'}\n\nNote content:\n${content.substring(0, 4000)}`,
      },
    ];

    try {
      const response = await this.chat(messages);
      
      // Log raw response for debugging
      console.log('LLM raw response for insights:', response);
      
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
      
      // Log extracted JSON string for debugging
      console.log('Extracted JSON string:', jsonStr);
      
      let insights;
      try {
        insights = JSON.parse(jsonStr);
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        console.error('Failed to parse JSON string:', jsonStr);
        return null;
      }
      
      // Validate that we got an object
      if (!insights || typeof insights !== 'object') {
        console.error('Parsed insights is not an object:', insights);
        return null;
      }
      
      // Validate and sanitize the response
      const result = {
        todos: Array.isArray(insights.todos) ? insights.todos.slice(0, 5).map(s => String(s).substring(0, 100)) : [],
        reminders: Array.isArray(insights.reminders) ? insights.reminders.slice(0, 5).map(s => String(s).substring(0, 100)) : [],
        deadlines: Array.isArray(insights.deadlines) ? insights.deadlines.slice(0, 5).map(d => ({
          text: String(d.text || d).substring(0, 100),
          date: d.date || null
        })) : [],
        highlights: Array.isArray(insights.highlights) ? insights.highlights.slice(0, 5).map(s => String(s).substring(0, 100)) : [],
        tags: Array.isArray(insights.tags) ? insights.tags.slice(0, 5).map(t => String(t).toLowerCase().replace(/\s+/g, '-').substring(0, 30)) : [],
        extractedAt: Date.now()
      };
      
      // Check if we actually extracted anything meaningful
      const hasContent = result.todos.length > 0 || 
                        result.reminders.length > 0 || 
                        result.deadlines.length > 0 || 
                        result.highlights.length > 0 ||
                        result.tags.length > 0;
      
      if (!hasContent) {
        console.log('No meaningful insights extracted from response');
        return null;
      }
      
      console.log('Successfully extracted insights:', result);
      return result;
    } catch (error) {
      console.error('Failed to extract insights:', error);
      return null;
    }
  }

  /**
   * Generate a daily summary from multiple notes' insights
   */
  async generateDailySummary(notesWithInsights) {
    if (!notesWithInsights || notesWithInsights.length === 0) {
      return null;
    }

    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    // Compile all insights
    const allTodos = [];
    const allReminders = [];
    const allDeadlines = [];
    
    for (const note of notesWithInsights) {
      if (!note.insights) continue;
      
      const prefix = note.name ? `[${note.name}] ` : '';
      
      if (note.insights.todos) {
        allTodos.push(...note.insights.todos.map(t => prefix + t));
      }
      if (note.insights.reminders) {
        allReminders.push(...note.insights.reminders.map(r => prefix + r));
      }
      if (note.insights.deadlines) {
        allDeadlines.push(...note.insights.deadlines.map(d => ({
          ...d,
          text: prefix + d.text,
          noteId: note.id
        })));
      }
    }

    // Filter deadlines for today and upcoming
    const todayDeadlines = allDeadlines.filter(d => d.date === today);
    const upcomingDeadlines = allDeadlines.filter(d => d.date && d.date > today && d.date <= nextWeek);

    return {
      date: today,
      todayDeadlines,
      upcomingDeadlines,
      todos: allTodos.slice(0, 10),
      reminders: allReminders.slice(0, 10),
      generatedAt: Date.now()
    };
  }

  /**
   * RAG Step 1: Analyze user query and determine which notes to retrieve
   * Returns note IDs, tags to filter by, and the follow-up prompt
   */
  async ragAnalyzeQuery(userQuery, notesMetadata) {
    if (!userQuery || !notesMetadata || notesMetadata.length === 0) {
      return null;
    }

    const notesListStr = notesMetadata.map(n => 
      `- ID: "${n.id}", Title: "${n.title || 'Untitled'}", Tags: [${(n.tags || []).join(', ')}]`
    ).join('\n');

    const allTags = [...new Set(notesMetadata.flatMap(n => n.tags || []))];
    const tagsListStr = allTags.length > 0 ? allTags.join(', ') : '(no tags)';

    const messages = [
      {
        role: 'system',
        content: `You are an intelligent assistant that helps users find information across their notes.

The user has a collection of notes. Your task is to:
1. Analyze the user's query
2. Determine which notes are most likely to contain relevant information based on their titles and tags
3. Return a structured response indicating which notes to retrieve

Available notes:
${notesListStr}

All available tags: ${tagsListStr}

Rules:
- Select only notes that are likely relevant to the query (max 5 notes)
- If the query is general or unclear, select notes with the most relevant titles/tags
- Also specify any tags that might help filter relevant content
- Create a follow-up prompt that will be used with the full note content to answer the user's query
- Return ONLY valid JSON, no markdown or explanation

Return JSON in this exact format:
{
  "noteIds": ["id1", "id2"],
  "relevantTags": ["tag1", "tag2"],
  "followUpPrompt": "Based on the following notes, [specific instruction to answer the user's query]",
  "reasoning": "Brief explanation of why these notes were selected"
}`
      },
      {
        role: 'user',
        content: userQuery
      }
    ];

    try {
      const response = await this.chat(messages);
      
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const result = JSON.parse(jsonStr);
      
      return {
        noteIds: Array.isArray(result.noteIds) ? result.noteIds : [],
        relevantTags: Array.isArray(result.relevantTags) ? result.relevantTags : [],
        followUpPrompt: result.followUpPrompt || 'Answer the user query based on the following notes.',
        reasoning: result.reasoning || ''
      };
    } catch (error) {
      console.error('RAG analysis failed:', error);
      return null;
    }
  }

  /**
   * RAG Step 2: Answer the user query using the retrieved note content
   */
  async ragAnswerQuery(userQuery, followUpPrompt, notesContent) {
    if (!userQuery || !notesContent || notesContent.length === 0) {
      return null;
    }

    const notesStr = notesContent.map(n => 
      `=== Note: ${n.title || 'Untitled'} ===\n${n.content}\n`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: `You are a helpful assistant answering questions based on the user's notes.

${followUpPrompt}

Notes content:
${notesStr}

Rules:
- Answer based ONLY on the information in the provided notes
- If the information is not in the notes, say so clearly
- Be concise but thorough
- If referencing specific notes, mention their titles
- Format your response clearly with paragraphs or bullet points as appropriate`
      },
      {
        role: 'user',
        content: userQuery
      }
    ];

    try {
      return await this.chat(messages);
    } catch (error) {
      console.error('RAG answer failed:', error);
      throw error;
    }
  }
}


// Global LLM instance
const LLM = new LLMService();
window.LLM = LLM;
