import { google } from "googleapis";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const CREDENTIALS_PATH = path.join(import.meta.dir, "credential.json");
const TOKEN_PATH = path.join(import.meta.dir, "token.json");

// Scopes needed to read and trash/modify emails
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
];

async function main() {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  const creds = JSON.parse(content);
  const installed = creds.installed || creds.web;
  const { client_id, client_secret } = installed;

  // Start local server to receive OAuth callback
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local callback server");
  }
  const port = address.port;
  const redirectUri = `http://localhost:${port}`;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("AUTH_URL_START");
  console.log(authUrl);
  console.log("AUTH_URL_END");
  console.log(`Waiting for authorization callback on port ${port}...`);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      try {
        const url = new URL(req.url || "", `http://localhost:${port}`);
        const codeParam = url.searchParams.get("code");
        if (codeParam) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>認証が完了しました。ブラウザを閉じてターミナルにお戻りください。</h1>");
          server.close();
          resolve(codeParam);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("No code provided");
        }
      } catch (e) {
        reject(e);
      }
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
  console.log("SUCCESS: token.json has been created!");
}

main().catch((err) => {
  console.error("Auth error:", err);
  process.exit(1);
});
