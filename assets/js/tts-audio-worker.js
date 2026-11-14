(function () {
  'use strict';
  self.onmessage = async function (event) {
    const message = event.data || {};
    if (message.type !== 'synthesize') return;
    const payload = message.payload || {};
    const requestId = message.requestId || '';
    try {
      const endpoint = String(payload.endpoint || 'http://127.0.0.1:8770').replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (payload.apiKey) headers.Authorization = 'Bearer ' + payload.apiKey;
      const response = await fetch(endpoint + '/v1/audio/speech', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          input: payload.text,
          text: payload.text,
          voice: payload.voice || 'default',
          speed: Math.max(0.5, Math.min(2, Number(payload.speed) || 1))
        })
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).detail || ''; } catch (err) {}
        self.postMessage({
          type: 'error',
          requestId: requestId,
          payload: { error: 'GPT-SoVITS HTTP ' + response.status + (detail ? ' · ' + detail : '') }
        });
        return;
      }
      const buffer = await response.arrayBuffer();
      self.postMessage({
        type: 'audio',
        requestId: requestId,
        payload: {
          arrayBuffer: buffer,
          mimeType: response.headers.get('Content-Type') || 'audio/wav'
        }
      }, [buffer]);
    } catch (err) {
      self.postMessage({
        type: 'error',
        requestId: requestId,
        payload: { error: err && err.message ? err.message : String(err) }
      });
    }
  };
})();
