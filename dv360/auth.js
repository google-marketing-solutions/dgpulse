/**
 * @fileoverview Script to generate OAuth2 refresh tokens for DV360 authentication.
 * Supports both automatic localhost callback and manual code paste (ideal for Cloud Shell).
 */
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const readline = require('readline');

const KEY_PATH = './client_secret.json';
if (!fs.existsSync(KEY_PATH)) {
  console.error(`Error: ${KEY_PATH} not found.`);
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const credentials = keys.installed || keys.web || keys;

if (!credentials || !credentials.client_id || !credentials.client_secret) {
  console.error('Error: client_secret.json does not contain valid client_id and client_secret.');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/display-video',
  'https://www.googleapis.com/auth/doubleclickbidmanager'
];

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2Client = new google.auth.OAuth2(
  credentials.client_id,
  credentials.client_secret,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('================================================================================');
console.log('DV360 OAuth2 Authorization');
console.log('================================================================================');
console.log('\n1. Open this URL in your browser and authorize access:\n');
console.log(authUrl);
console.log('\n================================================================================');

let completed = false;

async function exchangeCode(code) {
  if (completed) return;
  completed = true;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n================================================================================');
    console.log('🎉 Authorization Successful!');
    console.log('================================================================================');
    console.log('\nYour new REFRESH_TOKEN is:\n');
    console.log(tokens.refresh_token);
    console.log('\nTo use it in your terminal, run:');
    console.log(`export REFRESH_TOKEN="${tokens.refresh_token}"`);
    console.log('================================================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\nError retrieving access token:', err.message);
    process.exit(1);
  }
}

// 1. HTTP server listening on port 3000
const server = http.createServer((req, res) => {
  try {
    const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const code = urlParams.get('code');

    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication successful!</h1><p>You can close this tab and return to Cloud Shell.</p>');
      server.close();
      exchangeCode(code);
    }
  } catch (e) {}
});

server.listen(PORT, () => {
  console.log(`Waiting for authorization callback on ${REDIRECT_URI}...`);
});

// 2. Interactive prompt in case localhost:3000 is unreachable from browser
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\nIf the browser redirects to localhost and shows "refused to connect" or fails to load,');
console.log('simply copy the entire URL or the "code" query parameter from the browser address bar.');
rl.question('\nPaste the URL or code here (or press Enter if redirected automatically): ', (answer) => {
  if (answer && answer.trim()) {
    let raw = answer.trim();
    let code = raw;
    if (raw.includes('code=')) {
      try {
        const u = new URL(raw.startsWith('http') ? raw : `http://localhost/?${raw}`);
        code = u.searchParams.get('code') || raw;
      } catch (e) {
        const m = raw.match(/code=([^&]+)/);
        if (m && m[1]) code = decodeURIComponent(m[1]);
      }
    }
    server.close();
    exchangeCode(code);
  }
});