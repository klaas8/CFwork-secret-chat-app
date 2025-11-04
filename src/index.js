// src/index.js

/**
 * 这是 Durable Object 的实现，是聊天室的大脑。
 * 它管理所有用户的 WebSocket 连接、消息广播和持久化存储。
 */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    // `sessions` 用于存储所有当前在线用户的 WebSocket 连接和信息
    this.sessions = [];
    // `lastTimestamps` 用于简单的速率限制，防止刷屏
    this.lastTimestamps = new Map();
  }

  // 处理所有进入此 Durable Object 的请求
  async fetch(request) {
    // 我们只处理 WebSocket 升级请求
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    // 创建一个 WebSocket 对，一个是给客户端的，一个是给服务器（我们自己）的
    const [client, server] = Object.values(new WebSocketPair());

    // 将服务器端的 WebSocket 交给我们自己处理
    await this.handleSession(server);

    // 将客户端的 WebSocket 返回给浏览器
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // 处理一个新的用户会话
  async handleSession(ws) {
    ws.accept(); // 接受 WebSocket 连接

    // 创建一个临时的 session，等待前端发送身份信息
    const session = { ws, quit: false };
    this.sessions.push(session);

    // 先发送历史记录
    const history = await this.state.storage.get("messages") || [];
    ws.send(JSON.stringify({ type: "history", messages: history }));
    
    // 更新状态，此时新用户还未计入“具名”在线列表
    await this.updateAndBroadcastStatus();

    // 监听从这个用户发来的消息
    ws.addEventListener("message", async msg => {
      try {
        if (session.quit) return;

        const data = JSON.parse(msg.data);

        // 如果是身份认证消息，则设置用户信息并广播加入
        if (data.type === 'identity') {
          session.id = data.id;
          session.name = data.name || this.generateName();
          session.avatar = data.avatar || '🤖';
          session.isIdentified = true; // 标记为已认证

          ws.send(JSON.stringify({ type: "info", message: `欢迎你, ${session.name}!` }));
          ws.send(JSON.stringify({ type: "identity", id: session.id, name: session.name, avatar: session.avatar }));
          
          this.broadcast({ type: "info", message: `${session.name} 加入了聊天。` });
          await this.updateAndBroadcastStatus();
          return;
        }

        // 如果用户还未认证身份，则不允许发送消息
        if (!session.isIdentified) {
          ws.send(JSON.stringify({ type: "error", message: "请先设置身份再发送消息！" }));
          return;
        }
        
        // 如果是“正在输入”状态
        if (data.type === 'typing') {
            this.broadcast({ type: 'typing', name: session.name, id: session.id }, session.id); // 广播给除自己外的所有人
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

      } catch (e) { 
        // 忽略解析错误等，避免单个错误消息导致连接断开
      }
    });

    // 当用户关闭浏览器或断开连接时触发
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

  // 广播消息给所有在线用户
  broadcast(message, excludeId = null) {
    const preparedMessage = JSON.stringify(message);
    this.sessions = this.sessions.filter(session => {
      // 如果指定了排除ID，则不向该用户广播
      if (session.id === excludeId) {
        return true;
      }
      // 不向未认证的会话广播
      if (!session.isIdentified) {
        return true;
      }
      try {
        session.ws.send(preparedMessage);
        return true;
      } catch (err) {
        // 如果发送失败，说明用户已断开，将其从会话列表中移除
        session.quit = true;
        return false;
      }
    });
  }

  // 更新并广播状态信息
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

    // 向所有会话（包括未认证的）广播状态
    this.sessions.forEach(session => {
      try {
        if (!session.quit) {
            session.ws.send(statusMessage);
        }
      } catch (err) {
        session.quit = true;
      }
    });
    this.sessions = this.sessions.filter(s => !s.quit);
  }

  // 生成一个随机的匿名
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
      // 如果是普通的 HTTP 请求（比如访问网页），则让 Pages 默认的静态资源处理器来处理
      // env.ASSETS.fetch(request) 会自动返回 public 文件夹里的文件
      return env.ASSETS.fetch(request);
    }
  },
};
