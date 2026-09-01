/**
 * A small ElevenLabs API client — just enough to provision and inspect an agent.
 *
 * Deliberately not the official SDK. The provisioner touches perhaps a dozen
 * endpoints, all of them plain JSON over HTTPS, and a hand-written client keeps
 * two properties that matter more here than convenience:
 *
 *   - Every failure reports the API's own response body verbatim. Parts of the
 *     Agents schema are documented by example rather than exhaustively, so the
 *     fastest way to learn that a field name is wrong is to be shown the 422.
 *   - Nothing is installed into the runtime image. This client is used by
 *     operator scripts only; the service itself never calls ElevenLabs.
 */

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

export class ElevenLabsError extends Error {
  constructor(status, method, path, body) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    super(`ElevenLabs ${method} ${path} failed with ${status}:\n${detail}`);
    this.name = 'ElevenLabsError';
    this.status = status;
    this.body = body;
  }
}

export class ElevenLabsClient {
  /**
   * `baseUrl` falls back to ELEVENLABS_BASE_URL before the real API, so the
   * provisioner can be driven end to end against a stub. Provisioning creates
   * live resources on a clinic's account; discovering a bug in the middle of
   * that is expensive, and a dry run only exercises the paths that skip the
   * network.
   */
  constructor({
    apiKey,
    baseUrl = process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'xi-api-key': this.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* keep the raw text; an HTML error page is still worth printing */ }

    if (!response.ok) throw new ElevenLabsError(response.status, method, path, parsed);
    return parsed;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path) { return this.request('DELETE', path); }

  // --- identity -----------------------------------------------------------
  /** Confirms the key works, and reports the tier — HIPAA needs Enterprise. */
  user() { return this.get('/v1/user'); }
  subscription() { return this.get('/v1/user/subscription'); }

  // --- voices -------------------------------------------------------------
  listVoices() { return this.get('/v1/voices'); }

  // --- secrets ------------------------------------------------------------
  listSecrets() { return this.get('/v1/convai/secrets'); }
  createSecret(name, value) {
    return this.post('/v1/convai/secrets', { type: 'new', name, value });
  }

  // --- tools --------------------------------------------------------------
  listTools() { return this.get('/v1/convai/tools'); }
  createTool(toolConfig) { return this.post('/v1/convai/tools', { tool_config: toolConfig }); }
  updateTool(toolId, toolConfig) {
    return this.patch(`/v1/convai/tools/${toolId}`, { tool_config: toolConfig });
  }

  // --- knowledge base -----------------------------------------------------
  listKnowledgeBase() { return this.get('/v1/convai/knowledge-base'); }
  createKnowledgeBaseText(name, text) {
    return this.post('/v1/convai/knowledge-base/text', { name, text });
  }

  // --- pronunciation ------------------------------------------------------
  createPronunciationDictionary(name, rules) {
    return this.post('/v1/pronunciation-dictionaries/add-from-rules', { name, rules });
  }

  // --- agents -------------------------------------------------------------
  listAgents() { return this.get('/v1/convai/agents'); }
  getAgent(agentId) { return this.get(`/v1/convai/agents/${agentId}`); }
  createAgent(payload) { return this.post('/v1/convai/agents/create', payload); }
  updateAgent(agentId, payload) { return this.patch(`/v1/convai/agents/${agentId}`, payload); }

  // --- phone numbers ------------------------------------------------------
  listPhoneNumbers() { return this.get('/v1/convai/phone-numbers'); }
  createPhoneNumber(payload) { return this.post('/v1/convai/phone-numbers', payload); }
  assignPhoneNumber(phoneNumberId, agentId) {
    return this.patch(`/v1/convai/phone-numbers/${phoneNumberId}`, { agent_id: agentId });
  }
}
