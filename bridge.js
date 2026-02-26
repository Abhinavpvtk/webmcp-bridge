#!/usr/bin/env node

/**
 * WebMCP Bridge Server v3 - Railway Edition
 * Real web scraping + Claude AI analysis
 * Deploy to Railway.app for permanent URL
 * 
 * Environment Variables (set in Railway dashboard):
 *   CLAUDE_API_KEY = your anthropic api key
 *   PORT           = auto-set by Railway
 */

const http = require('http');
const https = require('https');

// ============================================================
// CONFIG - API key is read from environment variable (secure!)
// ============================================================
const CONFIG = {
  PORT: process.env.PORT || 3456,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || '',
  CLAUDE_MODEL: 'claude-opus-4-6',
};
// ============================================================

if (!CONFIG.CLAUDE_API_KEY) {
  console.error('❌ CLAUDE_API_KEY environment variable is not set!');
  console.error('   Set it in Railway dashboard → Variables tab');
  process.exit(1);
}

// Scrape a URL using built-in Node.js (no external packages)
function scrapeUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    };

    const req = mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return scrapeUrl(res.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const text = data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 4000);

        const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : url;

        resolve({ title, content: text, url });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// Call Claude API
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch (e) {
          reject(new Error('Failed to parse Claude response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 'v3-railway' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/scrape') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url, query } = JSON.parse(body);

        if (!url && !query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Provide url or query' }));
          return;
        }

        console.log(`📥 Request: url=${url || 'N/A'} query=${query || 'N/A'}`);

        let prompt = '';

        if (url) {
          console.log(`🌐 Scraping ${url}...`);
          const scraped = await scrapeUrl(url);
          console.log(`✅ Scraped: ${scraped.title}`);

          prompt = `Analyze this scraped webpage and return ONLY a JSON object, no other text:

URL: ${url}
Title: ${scraped.title}
Content: ${scraped.content}
${query ? `\nUser question: "${query}"` : ''}

Return ONLY this JSON:
{
  "title": "page title",
  "summary": "2-3 sentence summary",
  "key_points": ["point1", "point2", "point3", "point4", "point5"],
  "key_data": "important data found",
  "answer": "${query || 'general insights'}"
}`;

        } else {
          prompt = `Provide information about: "${query}"

Return ONLY this JSON, no other text:
{
  "query": "${query}",
  "summary": "3-4 sentence summary",
  "key_points": ["point1", "point2", "point3", "point4", "point5"],
  "details": "detailed explanation",
  "sources": ["url1", "url2", "url3"]
}`;
        }

        console.log(`🤖 Calling Claude...`);
        const claudeResponse = await callClaude(prompt);
        console.log(`✅ Got response`);

        let result;
        try {
          const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
          result = jsonMatch ? JSON.parse(jsonMatch[0]) : { text: claudeResponse };
        } catch {
          result = { text: claudeResponse };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result, timestamp: new Date().toISOString() }));

      } catch (err) {
        console.error('❌ Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use POST /scrape' }));
});

server.listen(CONFIG.PORT, () => {
  console.log('\n🚀 WebMCP Bridge Server v3 - Railway Edition');
  console.log('=============================================');
  console.log(`✅ Port: ${CONFIG.PORT}`);
  console.log(`📡 POST /scrape`);
  console.log(`📡 GET  /health`);
  console.log('\n⏳ Ready for requests!\n');
});
