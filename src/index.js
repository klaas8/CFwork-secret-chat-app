// 这是 Durable Object 的实现，是聊天室的大脑
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    // `sessions` 用于存储所有当前在线用户的 WebSocket 连接
    this.sessions = [];
    // `lastTimestamps` 用于简单的速率限制，防止刷屏
    this.lastTimestamps = new Map();
  }

  // 处理所有进入此 Durable Object 的请求
  async fetch(request) {
    // 检查请求是否是 WebSocket 升级请求
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket 连接", { status: 400 });
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

    // 为新用户创建一个会话对象，包含 WebSocket 实例和随机生成的匿名
    const session = { ws, name: this.generateName(), quit: false };
    this.sessions.push(session);

    // 从持久化存储中加载历史消息
    const history = await this.state.storage.get("messages") || [];
    // 给新用户发送历史消息
    ws.send(JSON.stringify({ type: "history", messages: history }));
    // 发送欢迎语
    ws.send(JSON.stringify({ type: "info", message: `欢迎你, ${session.name}!` }));

    // 向聊天室里的所有人广播新用户加入的消息
    this.broadcast({ type: "info", message: `${session.name} 加入了聊天。` });
    // 更新并广播在线状态（人数、剩余消息数）
    await this.updateAndBroadcastStatus();

    // 监听从这个用户发来的消息
    ws.addEventListener("message", async msg => {
      try {
        if (session.quit) return; // 如果用户已退出，则忽略

        // 速率限制：每个用户每 0.5 秒最多发一条消息
        const now = Date.now();
        const last = this.lastTimestamps.get(ws) || 0;
        if (now - last < 500) {
          ws.send(JSON.stringify({ type: "error", message: "你说话太快了！" }));
          return;
        }
        this.lastTimestamps.set(ws, now);

        // 检查当天剩余消息数
        const today = new Date().toISOString().split('T')[0];
        let lastWriteDate = await this.state.storage.get("lastWriteDate") || today;
        let dailyWrites = await this.state.storage.get("dailyWrites") || 0;

        // 如果是新的一天，重置计数器
        if (today !== lastWriteDate) {
          dailyWrites = 0;
          await this.state.storage.put("lastWriteDate", today);
        }

        if (dailyWrites >= 100000) {
          ws.send(JSON.stringify({ type: "error", message: "今天的话题已聊完，明天再来吧！" }));
          return;
        }

        // 构造消息对象
        const message = {
          name: session.name,
          text: msg.data.toString(),
          timestamp: now,
        };
        
        history.push(message);
        // 只保留最近的 100 条消息
        while (history.length > 100) {
          history.shift();
        }
        
        // 使用事务来确保数据一致性：同时更新消息列表和写入计数
        await this.state.storage.transaction(async (txn) => {
            await txn.put("messages", history);
            await txn.put("dailyWrites", dailyWrites + 1);
        });

        // 广播新消息和更新状态
        this.broadcast({ type: "message", ...message });
        await this.updateAndBroadcastStatus();

      } catch (e) {
        // 忽略错误
      }
    });

    // 当用户关闭浏览器或断开连接时触发
    const closeOrErrorHandler = () => {
      if (!session.quit) {
        session.quit = true;
        this.sessions = this.sessions.filter(s => s !== session);
        this.lastTimestamps.delete(ws);
        this.broadcast({ type: "info", message: `${session.name} 离开了。` });
        this.updateAndBroadcastStatus();
      }
    };
    ws.addEventListener("close", closeOrErrorHandler);
    ws.addEventListener("error", closeOrErrorHandler);
  }

  // 广播消息给所有在线用户
  broadcast(message) {
    const preparedMessage = JSON.stringify(message);
    this.sessions = this.sessions.filter(session => {
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
    
    this.broadcast({
      type: "status",
      online: this.sessions.length,
      remaining: remaining > 0 ? remaining : 0,
    });
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

// 这是 Worker 的入口，是所有请求的第一站
export default {
  async fetch(request, env) {
    // 从 URL 路径中提取房间名，但为了简单，我们只用一个全局房间
    // let roomName = new URL(request.url).pathname.slice(1);

    // 我们需要一个唯一的 ID 来代表我们的全局聊天室
    // 这里我们用一个固定的字符串 "global-chat-room" 来生成这个 ID
    let id = env.CHAT_ROOM.idFromName("global-chat-room");
    
    // 从环境中获取 Durable Object 的 "存根" (stub)
    let stub = env.CHAT_ROOM.get(id);
    
    // 将请求直接转发给这个 Durable Object 实例去处理
    return stub.fetch(request);
  },
};
