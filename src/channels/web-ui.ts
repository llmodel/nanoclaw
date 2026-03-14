import { WebUIServer } from 'nanoclaw-web-ui';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';

// All web sessions share a single stable JID so messages are routed to a
// registered group. The user registers this JID once via the admin channel.
const WEB_JID = 'web:default';

class WebUIChannel implements Channel {
  name = 'web-ui';

  private server: WebUIServer;

  constructor(server: WebUIServer) {
    this.server = server;
  }

  async connect(): Promise<void> {
    await this.server.start();
    logger.info({}, 'Web UI channel connected');
  }

  async disconnect(): Promise<void> {
    await this.server.stop();
    logger.info({}, 'Web UI channel stopped');
  }

  isConnected(): boolean {
    return this.server.isRunning();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // Broadcast to all authenticated sessions — personal assistant has one user.
    const sent = this.server.broadcast('assistant', text);
    if (sent === 0) {
      logger.warn({}, 'Web UI broadcast: no active sessions');
    }
  }
}

registerChannel('web-ui', (opts: ChannelOpts): Channel | null => {
  const env = readEnvFile(['WEB_UI_PORT', 'WEB_UI_HOST', 'WEB_UI_AUTH_TOKEN']);
  const port = parseInt(env.WEB_UI_PORT ?? process.env.WEB_UI_PORT ?? '3000', 10);
  const host = env.WEB_UI_HOST ?? process.env.WEB_UI_HOST ?? 'localhost';
  const authToken = env.WEB_UI_AUTH_TOKEN ?? process.env.WEB_UI_AUTH_TOKEN ?? undefined;

  const server = new WebUIServer({
    port,
    host,
    authToken,
    onMessage: async (msg) => {
      const timestamp = msg.timestamp;

      opts.onChatMetadata(WEB_JID, timestamp, 'Web UI', 'web-ui', false);

      // Prepend trigger so all web messages are processed without requiring
      // the user to type @Andy in the browser UI.
      const content = `@${ASSISTANT_NAME} ${msg.content}`;

      opts.onMessage(WEB_JID, {
        id: msg.id,
        chat_jid: WEB_JID,
        sender: msg.sender,
        sender_name: msg.senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    },
  });

  return new WebUIChannel(server);
});
