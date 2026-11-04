/**
 * Thin client for the Evolution API REST surface (Baileys transport).
 * Auth: `apikey` header. Instance-scoped routes end in /:instanceName.
 */
function createEvolution(config, fetchImpl = fetch) {
  const base = config.evolutionBaseUrl;
  const instance = config.evolutionInstance;

  async function request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.evolutionTimeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: {
          apikey: config.evolutionApiKey,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`evolution api ${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request,
    sendText(number, text) {
      return request(`/message/sendText/${encodeURIComponent(instance)}`, { method: 'POST', body: { number, text } });
    },
    fetchGroups() {
      return request(`/group/fetchAllGroups/${encodeURIComponent(instance)}`, { query: { getParticipants: false } });
    },
    groupInfo(groupId) {
      return request(`/group/findGroupInfos/${encodeURIComponent(instance)}`, { query: { groupId } });
    },
    qr() {
      return request(`/instance/connect/${encodeURIComponent(instance)}`);
    },
    connectionState() {
      return request(`/instance/connectionState/${encodeURIComponent(instance)}`);
    },
    setWebhook(url, events = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']) {
      return request(`/webhook/set/${encodeURIComponent(instance)}`, {
        method: 'POST',
        body: {
          webhook: {
            enabled: true,
            url,
            events,
            byEvents: false,
            base64: false
          }
        }
      });
    }
  };
}

module.exports = { createEvolution };
