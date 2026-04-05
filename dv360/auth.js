/**
 * @fileoverview Local script to generate initial OAuth2 refresh tokens for DV360 authentication.
 * Run this locally to authorize the app and get credentials for deployment.
 */
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');

const KEY_PATH = './client_secret.json'; // Ensure this matches your filename
const keys = JSON.parse(fs.readFileSync(KEY_PATH));
const SCOPES = ['https://www.googleapis.com/auth/display-video'];

// Use a fixed port for the local server
const PORT = 3000;

const oauth2Client = new google.auth.OAuth2(
  keys.web.client_id,
  keys.web.client_secret,
  `http://localhost:${PORT}` // Use the local server as redirect URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // Critical to get a refresh_token
  scope: SCOPES,
});

console.log('1. Authorize this app by visiting this url:\n', authUrl);

// 2. Create a local server to listen for the redirect
const server = http.createServer((req, res) => {
  const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const code = urlParams.get('code');

  if (code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authentication successful!</h1><p>You can close this tab now and return to the terminal.</p>');

    server.close(); // Stop listening

    // Exchange the code for tokens
    oauth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      console.log('\n2. Copy this refresh token into your index.js or save it to a file:\n');
      console.log(token.refresh_token);
      process.exit(0);
    });
  }
});

server.listen(PORT, () => {
  console.log(`\nWaiting for authorization on http://localhost:${PORT}...`);
});