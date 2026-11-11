#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Fork: the relay exits after this long with no Figma plugin connected, so it
// only runs while it is in use. RELAY_IDLE_MINUTES=0 keeps it running.
const parsedIdleMinutes = Number(process.env.RELAY_IDLE_MINUTES ?? 10);
const IDLE_MINUTES = Number.isFinite(parsedIdleMinutes) ? parsedIdleMinutes : 10;
let pluginClients = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleExit() {
  if (IDLE_MINUTES <= 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    console.log(`No Figma plugin connected for ${IDLE_MINUTES} minutes, exiting`);
    process.exit(0);
  }, IDLE_MINUTES * 60_000);
}

function cancelIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

// Fork: tells the MCP server whether a plugin is in the channel, so a command
// can fail fast with a useful message instead of timing out.
function publishPluginCount(channelName: string) {
  const clients = channels.get(channelName);
  if (!clients) return;
  const pluginCount = [...clients].filter((client) => client.data?.isPlugin).length;
  const payload = JSON.stringify({
    type: "system",
    message: "Plugin presence",
    channel: channelName,
    pluginCount,
  });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function handleConnection(ws: ServerWebSocket<any>) {
  if (ws.data?.isPlugin) {
    pluginClients++;
    cancelIdleExit();
  }

  // Don't add to clients immediately - wait for channel join
  console.log("New client connected");

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  ws.close = () => {
    console.log("Client disconnected");

    // Remove client from their channel
    channels.forEach((clients, channelName) => {
      if (clients.has(ws)) {
        clients.delete(ws);

        // Notify other clients in same channel
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "system",
              message: "A user has left the channel",
              channel: channelName
            }));
          }
        });
      }
    });
  };
}

const server = Bun.serve({
  port: 3055,
  // localhost only; use "0.0.0.0" for Windows WSL
  hostname: "127.0.0.1",
  fetch(req: Request, server: Server) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Fork: browsers always send Origin on a WebSocket handshake, and a page's
    // origin is its site. Figma plugin UIs send "null"; the MCP server and
    // scripts send none. Anything else is a web page, which must not get in.
    const origin = req.headers.get("Origin");
    if (origin !== null && origin !== "null") {
      console.warn(`Rejected connection from origin: ${origin}`);
      return new Response("Forbidden", { status: 403 });
    }

    // Handle WebSocket upgrade
    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      data: { isPlugin: origin === "null" },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          publishPluginCount(channelName);
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      // Remove client from their channel
      channels.forEach((clients, channelName) => {
        if (clients.delete(ws)) publishPluginCount(channelName);
      });

      if (ws.data?.isPlugin) {
        pluginClients = Math.max(0, pluginClients - 1);
        if (pluginClients === 0) scheduleIdleExit();
      }
    }
  }
});

console.log(`WebSocket server running on port ${server.port}`);
scheduleIdleExit();
