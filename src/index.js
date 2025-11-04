// Durable Object 的实现
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
    // 创建一个临时的 session，等待前端发送身份信息
    const session = { ws, quit: false };
    this.sessions.push(session);

    // 先发送历史记录
    const history = await this.state.storage.get("messages") || [];
    ws.send(JSON.stringify({ type: "history", messages: history }));
    
    // 更新状态，此时新用户还未计入“具名”在线列表
    await this.updateAndBroadcastStatus();

    ws.addEventListener("message", async msg => {
      try {
        if (session.quit) return;

        const data = JSON.parse(msg.data);

        // 【【【重要改动】】】
        // 如果是身份认证消息，则设置用户信息并广播加入
        if (data.type === 'identity') {
          session.name = data.name || this.generateName();
          session.avatar = data.avatar || '🤖';
          session.isIdentified = true; // 标记为已认证

          ws.send(JSON.stringify({ type: "info", message: `欢迎你, ${session.name}!` }));
          ws.send(JSON.stringify({ type: "identity", name: session.name, avatar: session.avatar }));
          
          this.broadcast({ type: "info", message: `${session.name} 加入了聊天。` });
          await this.updateAndBroadcastStatus();
          return;
        }

        // 如果用户还未认证身份，则不允许发送消息
        if (!session.isIdentified) {
          ws.send(JSON.stringify({ type: "error", message: "请先设置身份再发送消息！" }));
          return;
        }
        
        // 如果是聊天消息
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
              name: session.name,
              avatar: session.avatar,
              text: data.text.toString(),
              timestamp: now,
            };
            
            history.push(message);
            while (history.length > 100) {
              history.shift();
            }
            
            await this.state.storage.transaction(async (txn) => {
                await txn.put("messages", history);
                await txn.put("dailyWrites", dailyWrites + 1);
            });

            this.broadcast({ type: "message", ...message });
            await this.updateAndBroadcastStatus();
        }

      } catch (e) { /* 忽略解析错误等 */ }
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
    ws.addEventListener("close"， closeOrErrorHandler);
    ws.addEventListener("error"， closeOrErrorHandler);
  }

  broadcast(message) {
    const preparedMessage = JSON.stringify(message);
    this。sessions = this。sessions。filter(session => {
      if (!session.isIdentified) return true; // 不向未认证的会话广播
      try {
        session。ws。send(preparedMessage);
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
    let dailyWrites = await this。state。storage。get("dailyWrites") || 0;
    if (today !== lastWriteDate) { dailyWrites = 0; }
    
    const remaining = 100000 - dailyWrites;
    const onlineCount = this.sessions.filter(s => s。isIdentified)。length;
    
    this.broadcast({
      type: "status",
      online: onlineCount,
      remaining: remaining > 0 ? remaining : 0，
    });
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

// Worker 的入口 (无需改动)
export default {
  async fetch(request, env, ctx) {
    if (request.headers.get("Upgrade") === "websocket") {
      let id = env.CHAT_ROOM.idFromName("global-chat-room");
      let stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    } else {
      return env.ASSETS.fetch(request);
    }
  },
};
