// src/index.js (极限简化修复版)

// #################################################################
// #                  DURABLE OBJECT: ChatRoom                     #
// #################################################################
// 这部分代码没有改动
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

          ws.send(JSON.stringify({ type: "info", message: "欢迎你, " + session.name + "!" }));
          ws.send(JSON.stringify({ type: "identity", id: session.id, name: session.name, avatar: session.avatar }));
          
          this.broadcast({ type: "info", message: session.name + " 加入了聊天。" });
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
            this.broadcast({ type: "info", message: session.name + " 离开了。" });
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
    return randomAdj + randomNoun + '_' + randomNum;
  }
}


// #################################################################
// #                  WORKER ENTRYPOINT: fetch()                     #
// #################################################################
export default {
  async fetch(request, env) {
    try {
      if (request.headers.get("Upgrade") === "websocket") {
        const id = env.CHAT_ROOM.idFromName("global-chat-room");
        const stub = env.CHAT_ROOM.get(id);
        return stub.fetch(request);
      } else {
        return new Response(HTML, {
          headers: {
            "Content-Type": "text/html;charset=UTF-8",
          },
        });
      }
    } catch (e) {
      return new Response(e.message);
    }
  },
};


// #################################################################
// #                  HTML, CSS, and JavaScript                    #
// #################################################################
const HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>秘密聊天室</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>
    <style>
        :root { --theme-color: #007bff; --bg-color: #f0f2f5; --panel-bg: #fff; --text-color: #333; --border-color: #ddd; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background-color: var(--bg-color); display: flex; height: 100vh; overflow: hidden; }
        
        .app-container { display: flex; width: 100%; height: 100%; transition: transform 0.3s ease-in-out; }
        .app-container.settings-open { transform: translateX(-300px); }

        .main-content { flex-grow: 1; display: flex; flex-direction: column; width: 100%; height: 100%; }
        .chat-header { padding: 10px 50px; border-bottom: 1px solid var(--border-color); font-size: 12px; color: #666; text-align: center; position: relative; flex-shrink: 0; background-color: var(--panel-bg); }
        .toggle-button { position: absolute; top: 50%; transform: translateY(-50%); background: none; border: 1px solid var(--border-color); border-radius: 50%; width: 30px; height: 30px; cursor: pointer; font-size: 18px; line-height: 28px; z-index: 10; }
        #toggle-settings { right: 15px; }
        
        .messages { flex-grow: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; }
        .message { display: flex; margin-bottom: 15px; max-width: 80%; }
        .message .avatar { font-size: 24px; width: 40px; height: 40px; line-height: 40px; text-align: center; border-radius: 50%; background-color: #e9e9eb; margin-right: 10px; flex-shrink: 0; }
        .message .content { display: flex; flex-direction: column; }
        .message .meta { font-size: 12px; color: #888; margin-bottom: 5px; }
        .message .text { background-color: #e9e9eb; padding: 10px 15px; border-radius: 18px; word-wrap: break-word; }
        .message .text p { margin: 0; }
        .message.mine { align-self: flex-end; flex-direction: row-reverse; }
        .message.mine .avatar { margin-right: 0; margin-left: 10px; }
        .message.mine .text { background-color: var(--theme-color); color: white; }
        .message.mine .meta { text-align: right; }
        .message.info, .message.error { align-self: center; text-align: center; color: #aaa; font-size: 12px; max-width: 100%; }
        .message.error { color: #ff4d4f; font-weight: bold; }
        
        .input-area { display: flex; flex-direction: column; padding: 15px; border-top: 1px solid var(--border-color); flex-shrink: 0; background-color: var(--panel-bg); }
        .input-row { display: flex; width: 100%; align-items: center; position: relative; }
        #message-input { flex-grow: 1; border: 1px solid #ccc; border-radius: 20px; padding: 10px 15px; font-size: 16px; outline: none; resize: none; }
        .input-actions { display: flex; align-items: center; margin-left: 10px; }
        #emoji-toggle { font-size: 24px; cursor: pointer; background: none; border: none; padding: 0 5px; }
        #send-button { background-color: var(--theme-color); color: white; border: none; border-radius: 20px; padding: 10px 20px; cursor: pointer; font-size: 16px; }
        .typing-indicator { height: 20px; font-size: 12px; color: #888; padding: 5px 0 0; }
        
        .emoji-picker { position: absolute; bottom: 55px; right: 0; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 -4px 12px rgba(0,0,0,0.1); display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; padding: 10px; z-index: 10; display: none; }
        .emoji-picker.visible { display: grid; }
        .emoji-picker span { cursor: pointer; font-size: 22px; text-align: center; padding: 5px; border-radius: 4px; }
        .emoji-picker span:hover { background-color: #f0f0f0; }

        .side-panel { position: fixed; top: 0; width: 300px; height: 100%; background-color: #f8f9fa; z-index: 20; display: flex; flex-direction: column; box-shadow: 0 0 15px rgba(0,0,0,0.2); transition: transform 0.3s ease-in-out; padding: 20px; box-sizing: border-box; }
        .settings-panel { right: 0; transform: translateX(100%); }
        .app-container.settings-open .settings-panel { transform: translateX(0); }
        .settings-panel h3 { background-color: #e9ecef; color: #333; margin: 0; padding: 15px; text-align: center; font-size: 16px; }
        .setting-item { margin-bottom: 20px; }
        .setting-item label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 14px; }
        .setting-item input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        .avatar-selector { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 10px; }
        .avatar-option { font-size: 24px; text-align: center; padding: 5px; border-radius: 50%; cursor: pointer; transition: background-color 0.2s; }
        .avatar-option.selected { background-color: var(--theme-color); color: white; }
        #save-settings { background-color: var(--theme-color); color: white; border: none; border-radius: 4px; padding: 10px; width: 100%; cursor: pointer; font-size: 16px; margin-top: auto; }
    </style>
</head>
<body>
    <div class="app-container" id="app-container">
        <div class="main-content">
            <div class="chat-header">
                <span id="status">正在连接...</span>
                <button id="toggle-settings" class="toggle-button">⚙️</button>
            </div>
            <div class="messages" id="messages"></div>
            <div class="input-area">
                <div class="typing-indicator" id="typing-indicator"></div>
                <div class="input-row">
                   <input type="text" id="message-input" placeholder="输入消息..." autocomplete="off">
                   <div class="input-actions">
                       <button id="emoji-toggle">😀</button>
                       <button id="send-button">发送</button>
                   </div>
                   <div class="emoji-picker" id="emoji-picker"></div>
                </div>
            </div>
        </div>
        <div class="side-panel settings-panel">
            <h3>个人设置</h3>
            <div class="setting-item">
                <label for="name-input">昵称</label>
                <input type="text" id="name-input" placeholder="设置你的昵称">
            </div>
            <div class="setting-item">
                <label>头像</label>
                <div class="avatar-selector" id="avatar-selector"></div>
            </div>
            <button id="save-settings">保存并加入聊天</button>
        </div>
    </div>

    <script>
    // 使用 IIFE (立即调用函数表达式) 来避免污染全局作用域
    (function() {
        // --- UI Elements ---
        const ui = {
            appContainer: document.getElementById('app-container'),
            messagesDiv: document.getElementById('messages'),
            statusSpan: document.getElementById('status'),
            input: document.getElementById('message-input'),
            sendButton: document.getElementById('send-button'),
            nameInput: document.getElementById('name-input'),
            avatarSelector: document.getElementById('avatar-selector'),
            saveButton: document.getElementById('save-settings'),
            toggleSettingsButton: document.getElementById('toggle-settings'),
            emojiToggleButton: document.getElementById('emoji-toggle'),
            emojiPicker: document.getElementById('emoji-picker'),
            typingIndicator: document.getElementById('typing-indicator'),
        };

        // --- State ---
        let socket;
        let myIdentity = { id: '', name: '', avatar: '' };
        const avatars = ['😀', '😎', '🤖', '👻', '👽', '🧑‍🚀', '🦄', '🐼', '🦊', '🧙'];
        const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥', '💯', '🤔', '😊', '🥳', '🤯', '🤣', '🙌', '✨'];
        let typingTimeout;
        const typingUsers = new Map();
        let reconnectAttempts = 0;

        // --- Initialization ---
        function initialize() {
            console.log('应用初始化...');
            loadSettings();
            populateAvatars();
            populateEmojis();
            connect();

            // Event Listeners
            ui.sendButton.addEventListener('click', sendMessage);
            ui.input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                } else {
                    sendTyping();
                }
            });
            ui.saveButton.addEventListener('click', saveAndIdentify);
            ui.toggleSettingsButton.addEventListener('click', () => ui.appContainer.classList.toggle('settings-open'));
            ui.emojiToggleButton.addEventListener('click', (e) => {
                e.stopPropagation();
                ui.emojiPicker.classList.toggle('visible');
            });
            document.addEventListener('click', (e) => {
                if (ui.emojiPicker && !ui.emojiPicker.contains(e.target) && e.target !== ui.emojiToggleButton) {
                    ui.emojiPicker.classList.remove('visible');
                }
            });
        }

        // --- Settings ---
        function loadSettings() {
            myIdentity.id = localStorage.getItem('chat_id') || crypto.randomUUID();
            localStorage.setItem('chat_id', myIdentity.id);
            myIdentity.name = localStorage.getItem('chat_name') || '';
            myIdentity.avatar = localStorage.getItem('chat_avatar') || avatars[0];
            ui.nameInput.value = myIdentity.name;
            console.log('加载本地设置: ' + JSON.stringify(myIdentity));
        }

        function populateAvatars() {
            ui.avatarSelector.innerHTML = '';
            avatars.forEach(avatar => {
                const option = document.createElement('div');
                option.classList.add('avatar-option');
                option.textContent = avatar;
                if (avatar === myIdentity.avatar) option.classList.add('selected');
                option.addEventListener('click', (e) => {
                    const currentSelected = ui.avatarSelector.querySelector('.avatar-option.selected');
                    if (currentSelected) currentSelected.classList.remove('selected');
                    e.currentTarget.classList.add('selected');
                });
                ui.avatarSelector.appendChild(option);
            });
        }

        function populateEmojis() {
            emojis.forEach(emoji => {
                const span = document.createElement('span');
                span.textContent = emoji;
                span.addEventListener('click', () => {
                    ui.input.value += emoji;
                    ui.input.focus();
                });
                ui.emojiPicker.appendChild(span);
            });
        }

        function saveAndIdentify() {
            myIdentity.name = ui.nameInput.value.trim();
            myIdentity.avatar = ui.avatarSelector.querySelector('.avatar-option.selected').textContent;
            localStorage.setItem('chat_name', myIdentity.name);
            localStorage.setItem('chat_avatar', myIdentity.avatar);
            console.log('保存新设置: ' + JSON.stringify(myIdentity));
            
            if (socket && socket.readyState === WebSocket.OPEN) {
                sendIdentity();
            } else {
                console.warn('连接未建立，将在连接后自动发送身份信息。');
            }
            ui.appContainer.classList.remove('settings-open');
        }

        // --- WebSocket Logic ---
        function connect() {
            console.log('开始连接 WebSocket...');
            const protocol = window.location.protocol === "https:" ? "wss" : "ws";
            const wsUrl = protocol + '://' + window.location.host + '/';
            socket = new WebSocket(wsUrl);
            socket.onopen = onSocketOpen;
            socket.onmessage = onSocketMessage;
            socket.onclose = onSocketClose;
            socket.onerror = onSocketError;
        }

        function onSocketOpen() {
            console.info('WebSocket 连接成功！');
            reconnectAttempts = 0;
            sendIdentity();
        }
        
        function sendIdentity() {
            if (socket && socket.readyState === WebSocket.OPEN) {
                const identityPayload = { type: 'identity', ...myIdentity };
                socket.send(JSON.stringify(identityPayload));
                console.log('发送身份信息: ' + JSON.stringify(identityPayload));
            }
        }

        function onSocketMessage(event) {
            try {
                const data = JSON.parse(event.data);
                console.log('收到消息: ' + event.data);
                switch (data.type) {
                    case 'info':
                    case 'error':
                        addSystemMessage(data.message, data.type);
                        break;
                    case 'status':
                        updateStatus(data.online, data.remaining);
                        break;
                    case 'history':
                        ui.messagesDiv.innerHTML = '';
                        data.messages.forEach(msg => addMessage(msg));
                        break;
                    case 'message':
                        addMessage(data);
                        break;
                    case 'identity':
                        myIdentity = { id: data.id, name: data.name, avatar: data.avatar };
                        console.info('身份已确认: ' + JSON.stringify(myIdentity));
                        break;
                    case 'typing':
                        if (data.id !== myIdentity.id) {
                            updateTypingIndicator(data.name, true);
                        }
                        break;
                }
                ui.messagesDiv.scrollTop = ui.messagesDiv.scrollHeight;
            } catch (e) {
                console.error('解析收到的消息时出错:', e);
            }
        }

        function onSocketClose() {
            reconnectAttempts++;
            const delay = Math.min(30000, (Math.pow(2, reconnectAttempts) * 1000));
            const jitter = delay * 0.2 * Math.random();
            const reconnectDelay = delay + jitter;
            
            console.error('WebSocket 连接已断开，将在 ' + Math.round(reconnectDelay / 1000) + ' 秒后尝试重连 (第 ' + reconnectAttempts + ' 次)...');
            setTimeout(connect, reconnectDelay);
        }

        function onSocketError(error) {
            console.error('WebSocket 连接出现错误:', error);
        }

        // --- UI Rendering & Actions ---
        function addMessage(msg) {
            const isMine = msg.id === myIdentity.id;
            const msgEl = document.createElement('div');
            msgEl.classList.add('message', isMine ? 'mine' : 'theirs');
            
            const avatarHTML = '<div class="avatar">' + escapeHtml(msg.avatar) + '</div>';
            const contentHTML = '<div class="content">' +
                                  '<div class="meta">' + escapeHtml(msg.name) + ' - ' + new Date(msg.timestamp).toLocaleTimeString() + '</div>' +
                                  '<div class="text">' + DOMPurify.sanitize(marked.parse(msg.text)) + '</div>' +
                                '</div>';

            msgEl.innerHTML = avatarHTML + contentHTML;
            ui.messagesDiv.appendChild(msgEl);
        }

        function addSystemMessage(text, type) {
            const msgEl = document.createElement('div');
            msgEl.classList.add('message', type);
            msgEl.textContent = escapeHtml(text);
            ui.messagesDiv.appendChild(msgEl);
        }

        function updateStatus(online, remaining) {
            ui.statusSpan.textContent = '在线: ' + online + ' 人 | 今日剩余消息: ' + remaining.toLocaleString();
        }

        function sendMessage() {
            const text = ui.input.value.trim();
            if (socket && socket.readyState === WebSocket.OPEN && text !== '') {
                const payload = { type: 'chat', text: text };
                socket.send(JSON.stringify(payload));
                console.log('发送聊天消息: ' + JSON.stringify(payload));
                ui.input.value = '';
            } else {
                console.error('无法发送消息。连接未打开或输入为空。');
            }
        }

        function sendTyping() {
            if (socket && socket.readyState === WebSocket.OPEN) {
                if (!typingTimeout) {
                    socket.send(JSON.stringify({ type: 'typing' }));
                    typingTimeout = setTimeout(() => { typingTimeout = null; }, 2000);
                }
            }
        }

        function updateTypingIndicator(name, isTyping) {
            if (isTyping) {
                typingUsers.set(name, Date.now());
            } else {
                typingUsers.delete(name);
            }

            const now = Date.now();
            for (const [userName, lastTyped] of typingUsers.entries()) {
                if (now - lastTyped > 3000) {
                    typingUsers.delete(userName);
                }
            }

            const names = Array.from(typingUsers.keys());
            if (names.length === 0) {
                ui.typingIndicator.textContent = '';
            } else if (names.length === 1) {
                ui.typingIndicator.textContent = names[0] + ' 正在输入...';
            } else if (names.length === 2) {
                ui.typingIndicator.textContent = names.join(' 和 ') + ' 正在输入...';
            } else {
                ui.typingIndicator.textContent = '多个人正在输入...';
            }
        }
        
        function escapeHtml(unsafe) {
            if (typeof unsafe !== 'string') return '';
            return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }

        // --- Start the application ---
        document.addEventListener('DOMContentLoaded', initialize);
    })();
    </script>
</body>
</html>
`;
