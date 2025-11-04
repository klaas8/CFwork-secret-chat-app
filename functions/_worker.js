// functions/_worker.js

/**
 * 这是 Durable Object 的实现，是聊天室的大脑。
 * 它管理所有用户的 WebSocket 连接、消息广播和持久化存储。
 */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
    this.lastTimestamps = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws) {
    ws.accept();
    const session = { ws, quit: false };
    this.sessions.push(session);

    const history = await this.state.storage.get("messages") || [];
    ws.send(JSON.stringify({ type: "history", messages: history }));
    
    await this.updateAndBroadcastStatus();

    ws.addEventListener("message", async msg => {
      try {
        if (session.quit) return;
        const data = JSON.parse(msg.data);

        if (data.type === 'identity') {
          session.id = data.id;
          session.name = data.name || this.generateName();
          session.avatar = data.avatar || '🤖';
          session.isIdentified = true;

          ws.send(JSON.stringify({ type: "info", message: `欢迎你, ${session.name}!` }));
          ws.send(JSON.stringify({ type: "identity", id: session.id, name: session.name, avatar: session.avatar }));
          
          this.broadcast({ type: "info", message: `${session.name} 加入了聊天。` });
          await this.updateAndBroadcastStatus();
          return;
        }

        if (!session.isIdentified) {
          ws.send(JSON.stringify({ type: "error", message: "请先设置身份再发送消息！" }));
          return;
        }
        
        if (data.type === 'typing') {
            this.broadcast({ type: 'typing', name: session.name, id: session.id }, session.id);
            return;
        }
        
        if (data.type === 'chat') {
            const now = Date.now();
            const last = this.lastTimestamps.get(ws) || 0;
            if (now - last < 500) {
              ws.send(JSON.stringify({ type: "error", message: "你说话太快了！" }));
              return;
            }
            this.lastTimestamps.set(ws, now);

            const today = new Date().toISOString().split('T')[0];
            let lastWriteDate = await this.state.storage.get("lastWriteDate") || today;
            let dailyWrites = await this.state.storage.get("dailyWrites") || 0;

            if (today !== lastWriteDate) {
              dailyWrites = 0;
              await this.state.storage.put("lastWriteDate", today);
            }

            if (dailyWrites >= 100000) {
              ws.send(JSON.stringify({ type: "error", message: "今天的话题已聊完，明天再来吧！" }));
              return;
            }

            const message = {
              id: session.id,
              name: session.name,
              avatar: session.avatar,
              text: data.text.toString(),
              timestamp: now,
            };
            
            const currentHistory = await this.state.storage.get("messages") || [];
            currentHistory.push(message);
            while (currentHistory.length > 100) {
              currentHistory.shift();
            }
            
            await this.state.storage.transaction(async (txn) => {
                await txn.put("messages", currentHistory);
                await txn.put("dailyWrites", dailyWrites + 1);
            });

            this.broadcast({ type: "message", ...message });
            await this.updateAndBroadcastStatus();
        }
      } catch (e) { /* 忽略错误 */ }
    });

    const closeOrErrorHandler = () => {
      if (!session.quit) {
        session.quit = true;
        this.sessions = this.sessions.filter(s => s !== session);
        this.lastTimestamps.delete(ws);
        if (session.isIdentified) {
            this.broadcast({ type: "info", message: `${session.name} 离开了。` });
            this.updateAndBroadcastStatus();
        }
      }
    };
    ws.addEventListener("close", closeOrErrorHandler);
    ws.addEventListener("error", closeOrErrorHandler);
  }

  broadcast(message, excludeId = null) {
    const preparedMessage = JSON.stringify(message);
    this.sessions = this.sessions.filter(session => {
      if (session.id === excludeId) return true;
      if (!session.isIdentified) return true;
      try {
        session.ws.send(preparedMessage);
        return true;
      } catch (err) {
        session.quit = true;
        return false;
      }
    });
  }

  async updateAndBroadcastStatus() {
    const today = new Date().toISOString().split('T')[0];
    let lastWriteDate = await this.state.storage.get("lastWriteDate") || today;
    let dailyWrites = await this.state.storage.get("dailyWrites") || 0;
    if (today !== lastWriteDate) { dailyWrites = 0; }
    
    const remaining = 100000 - dailyWrites;
    const onlineCount = this.sessions.filter(s => s.isIdentified).length;
    
    const statusMessage = JSON.stringify({
      type: "status",
      online: onlineCount,
      remaining: remaining > 0 ? remaining : 0,
    });

    this.sessions.forEach(session => {
      try {
        if (!session.quit) session.ws.send(statusMessage);
      } catch (err) {
        session.quit = true;
      }
    });
    this.sessions = this.sessions.filter(s => !s.quit);
  }

  generateName() {
    const adjectives = ["神秘的", "快乐的", "沉思的", "勇敢的", "聪明的", "好奇的"];
    const nouns = ["访客", "旅人", "思想家", "探险家", "梦想家", "观察者"];
    const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNum = Math.floor(Math.random() * 9000) + 1000;
    return `${randomAdj}${randomNoun}_${randomNum}`;
  }
}

/**
 * 这是 Worker 的入口，是所有请求的第一站。
 * 它作为一个路由器，将 WebSocket 请求转发给 Durable Object，
 * 其他所有请求都交给 Pages 的静态资源处理器。
 */
export default {
  async fetch(request, env, ctx) {
    // 检查请求是否是 WebSocket 升级请求
    if (request.headers.get("Upgrade") === "websocket") {
      // 如果是，则将其交给 Durable Object 处理
      const id = env.CHAT_ROOM.idFromName("global-chat-room");
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    } else {
      // 对于所有其他 HTTP 请求，让 Pages 的默认静态资源处理器来处理。
      // 这会返回 public 文件夹里的文件，比如 index.html。
      // `env.ASSETS.fetch` 是 Pages 函数环境提供的标准方法。
      return env.ASSETS.fetch(request);
    }
  },
};
