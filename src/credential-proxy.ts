/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth tokens are short-lived (~5h). The proxy reads them from
 * ~/.claude/.credentials.json and auto-refreshes using the refresh token
 * when the access token is expired or a 401 is returned.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Claude.ai OAuth constants
const CLAUDE_AI_TOKEN_URL = 'https://api.claude.ai/oauth/token';
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);
// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Serializes concurrent refresh attempts so only one runs at a time
let refreshLock: Promise<void> = Promise.resolve();

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

function readCredentialsFile(): ClaudeCredentials | null {
  try {
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(content) as ClaudeCredentials;
  } catch {
    return null;
  }
}

function writeCredentialsFile(creds: ClaudeCredentials): void {
  try {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  } catch (err) {
    logger.error({ err }, 'Failed to write credentials file');
  }
}

/** Get the current OAuth access token, refreshing if expired. */
async function getValidOAuthToken(
  oauthTokenFromEnv: string | undefined,
): Promise<string | undefined> {
  // Fast path: check without lock
  const creds = readCredentialsFile();
  const oauth = creds?.claudeAiOauth;
  if (oauth?.accessToken && oauth.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return oauth.accessToken;
  }

  // Needs refresh — serialize via lock to prevent concurrent refresh races
  let result: string | undefined;
  const prev = refreshLock;
  let release!: () => void;
  refreshLock = new Promise<void>((r) => (release = r));

  try {
    await prev; // wait for any in-flight refresh to complete

    // Double-check after acquiring lock (another caller may have already refreshed)
    const creds2 = readCredentialsFile();
    const oauth2 = creds2?.claudeAiOauth;
    if (
      oauth2?.accessToken &&
      oauth2.expiresAt - Date.now() > REFRESH_BUFFER_MS
    ) {
      result = oauth2.accessToken;
    } else if (oauth2?.refreshToken) {
      logger.info('OAuth token expired, refreshing...');
      const refreshed = await refreshOAuthToken(oauth2.refreshToken);
      if (refreshed) {
        const updated: ClaudeCredentials = {
          ...creds2,
          claudeAiOauth: {
            ...oauth2,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? oauth2.refreshToken,
            expiresAt: refreshed.expiresAt,
          },
        };
        writeCredentialsFile(updated);
        logger.info('OAuth token refreshed and saved');
        result = refreshed.accessToken;
      } else {
        logger.warn('Token refresh failed, falling back to existing token');
        result = oauth2.accessToken ?? oauthTokenFromEnv;
      }
    } else {
      result = oauthTokenFromEnv;
    }
  } finally {
    release();
  }

  return result;
}

interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

function refreshOAuthToken(
  refreshToken: string,
): Promise<RefreshedToken | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const url = new URL(CLAUDE_AI_TOKEN_URL);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.access_token) {
              const expiresIn = data.expires_in ?? 18000; // default 5h
              resolve({
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: Date.now() + expiresIn * 1000,
              });
            } else {
              logger.error(
                { data },
                'OAuth refresh response missing access_token',
              );
              resolve(null);
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse OAuth refresh response');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth token refresh request failed');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthTokenFromEnv =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = await getValidOAuthToken(oauthTokenFromEnv);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: (upstreamUrl.pathname !== '/' ? upstreamUrl.pathname : '') + req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
