// POST JSON para o portal, com timeout e teto de tamanho da resposta.
// Usado pela consulta à lista de bloqueados e pela conferência diária.

const http = require('http');
const https = require('https');
const { URL } = require('url');

function createPostJson({ maxResponseBytes = 16 * 1024, defaultTimeoutMs = 5000 } = {}) {
  return function postJson(urlString, { body, headers, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlString);
      } catch (_error) {
        reject(new Error('invalid_portal_url'));
        return;
      }

      const transport = url.protocol === 'http:' ? http : https;
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            data += chunk;
            if (data.length > maxResponseBytes) request.destroy(new Error('response_too_large'));
          });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        }
      );

      request.setTimeout(timeoutMs || defaultTimeoutMs, () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end(body);
    });
  };
}

module.exports = { createPostJson };
