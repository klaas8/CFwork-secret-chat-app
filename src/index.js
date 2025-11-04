// Durable Object 的实现 (这部分没有改动，和之前一样)
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
    await this.handleSession(server, request); // 传递整个 request
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws, request) {
    ws.accept();
    // 从连接的 URL 中获取用户自定义的昵称和头像
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || this.generateName();
    const avatar = url.searchParams.get('avatar') || '🤖';

    const session = { ws, name, avatar, quit: false };
    this.sessions.push(session);

    const history = await this.state.storage.get("messages") || [];
    ws.send(JSON.stringify({ type: "history", messages: history }));
    ws.send(JSON.stringify({ type: "info", message: `欢迎你, ${session.name}!` }));
    ws.send(JSON.stringify({ type: "identity", name: session.name, avatar: session.avatar }));

    this.broadcast({ type: "info", message: `${session.name} 加入了聊天。` });
    await this.updateAndBroadcastStatus();

    ws.addEventListener("message", async msg => {
      try {
        if (session.quit) return;
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
          text: msg.data.toString(),
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

      } catch (e) { /* 忽略错误 */ }
    });

    const closeOrErrorHandler = () => {
      if (!session.quit) {
        session.quit = true;
        this.sessions = this.sessions.filter(s => s !== session);
        this.lastTimestamps.delete(ws);
        this.broadcast({ type: "info", message: `${session.name} 离开了。` });
        this.updateAndBroadcastStatus();
      }
    };
    ws。addEventListener("close"， closeOrErrorHandler);
    ws.addEventListener("error", closeOrErrorHandler);
  }

  broadcast(message) {
    const preparedMessage = JSON.stringify(message);
    this.sessions = this。sessions。filter(session => {
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
    let dailyWrites = await this.state.storage。get("dailyWrites") || 0;
    if (today !== lastWriteDate) { dailyWrites = 0; }
    
    const remaining = 100000 - dailyWrites;
    
    this。broadcast({
      输入: "status"，
      online: this.sessions.length,
      remaining: remaining > 0 ? remaining : 0,
    });
  }

  generateName() {
    const adjectives = ["神秘的", "快乐的", "沉思的", "勇敢的", "聪明的", "好奇的"];
    const nouns = ["访客"， "旅人"， "思想家"， "探险家"， "梦想家", "观察者"];
    const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNum = Math.floor(Math.random() * 9000) + 1000;
    return `${randomAdj}${randomNoun}_${randomNum}`;
  }
}

// 这是 Worker 的入口 - 【【【重大修改部分】】】
export default {
  async fetch(request, env, ctx) {
    // 检查请求是否是 WebSocket 升级请求
    if (request.headers.get("Upgrade") === "websocket") {
      // 如果是，则将其交给 Durable Object 处理
      let id = env.CHAT_ROOM.idFromName("global-chat-room");
      let stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    } else {
      // 如果是普通的 HTTP 请求（比如访问网页），则让 Pages 默认的静态资源处理器来处理
      // env.ASSETS.fetch(request) 会自动返回 public 文件夹里的文件
      return env.ASSETS.fetch(request);
    }
  },
};
