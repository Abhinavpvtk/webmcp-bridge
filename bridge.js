'use strict';

const http = require('http');
const https = require('https');

const CONFIG = {
  PORT: process.env.PORT || 3456,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || '',
  CLAUDE_MODEL: 'claude-opus-4-6',
};

if (!CONFIG.CLAUDE_API_KEY) {
  console.error('ERROR: CLAUDE_API_KEY environment variable is not set!');
  process.exit(1);
}

console.log('Starting WebMCP Bridge v3...');
console.log('Port:', CONFIG.PORT);
console.log('Model:', CONFIG.CLAUDE_MODEL);

function scrapeUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html'
      },
      timeout: 15000
    };

    const req = mod.get(url, options, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return scrapeUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        const text = data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 4000);
        const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : url;
        resolve({ title: title, content: text, url: url });
      });
    });

    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function callClaude(prompt) {
  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch(e) {
          reject(new Error('Failed to parse Claude response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 'v3' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/scrape') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        const payload = JSON.parse(body);
        const url = payload.url;
        const query = payload.query;

        if (!url && !query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Provide url or query' }));
          return;
        }

        console.log('Request: url=' + (url || 'N/A') + ' query=' + (query || 'N/A'));

        let prompt = '';

        if (url) {
          console.log('Scraping ' + url);
          const scraped = await scrapeUrl(url);
          console.log('Scraped: ' + scraped.title);
          prompt = 'Analyze this webpage and return ONLY a JSON object:\n\nURL: ' + url + '\nTitle: ' + scraped.title + '\nContent: ' + scraped.content + (query ? '\nUser question: "' + query + '"' : '') + '\n\nReturn ONLY this JSON:\n{\n  "title": "page title",\n  "summary": "2-3 sentence summary",\n  "key_points": ["point1", "point2", "point3", "point4", "point5"],\n  "key_data": "important data found",\n  "answer": "' + (query || 'general insights') + '"\n}';
        } else {
          prompt = 'Provide information about: "' + query + '"\n\nReturn ONLY this JSON:\n{\n  "query": "' + query + '",\n  "summary": "3-4 sentence summary",\n  "key_points": ["point1", "point2", "point3", "point4", "point5"],\n  "details": "detailed explanation",\n  "sources": ["url1", "url2", "url3"]\n}';
        }

        console.log('Calling Claude...');
        const claudeResponse = await callClaude(prompt);
        console.log('Got response');

        let result;
        try {
          const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
          result = jsonMatch ? JSON.parse(jsonMatch[0]) : { text: claudeResponse };
        } catch(e) {
          result = { text: claudeResponse };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result, timestamp: new Date().toISOString() }));

      } catch(err) {
        console.error('Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use POST /scrape' }));
});

server.listen(CONFIG.PORT, '0.0.0.0', function() {
  console.log('');
  console.log('WebMCP Bridge Server v3 READY');
  console.log('==============================');
  console.log('Port: ' + CONFIG.PORT);
  console.log('POST /scrape - main endpoint');
  console.log('GET  /health - health check');
  console.log('');
});
