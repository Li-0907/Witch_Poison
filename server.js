const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const extname = path.extname(filePath);
  let contentType = 'text/html';

  switch (extname) {
    case '.css':
      contentType = 'text/css';
      break;
    case '.js':
      contentType = 'text/javascript';
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(500);
        res.end('Server error: ' + err.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 游戏房间存储
const rooms = new Map();

// 游戏状态常量
const GameState = {
  WAITING: 'waiting',
  SETTING_CAKES: 'setting_cakes',
  CHOOSING_POISON: 'choosing_poison',
  PLAYING: 'playing',
  FINISHED: 'finished'
};

// 玩家角色
const PlayerRole = {
  HOST: 'host',
  GUEST: 'guest'
};

const WHO_GO_FIRST = {
  RANDOM: 'random',
  WIN_FIRST: 'win',
  LOSE_FIRST: 'lose',
  HOST: 'host',
  GUEST: 'guest'
}

// 处理WebSocket连接
wss.on('connection', (ws) => {
  let player = {
    ws,
    roomId: null,
    role: null,
    poisonPosition: null,
    isTurn: false
  };

  console.log('新玩家连接');

  // 处理消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(player, data);
    } catch (error) {
      console.error('消息解析错误:', error);
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    console.log('玩家断开连接');
    // if (player.roomId && rooms.has(player.roomId)) {
    //   const room = rooms.get(player.roomId);
    //   const otherPlayer = room.players.find(p => p !== player);

    //   // 通知另一个玩家
    //   if (otherPlayer && otherPlayer.ws.readyState === WebSocket.OPEN) {
    //     otherPlayer.ws.send(JSON.stringify({
    //       type: 'opponent_disconnected'
    //     }));
    //   }

    //   // 清理房间
    //   if (room.players.length <= 1) {
    //     rooms.delete(player.roomId);
    //     console.log(`房间 ${player.roomId} 已删除`);
    //   } else {
    //     // 移除断开连接的玩家
    //     room.players = room.players.filter(p => p !== player);
    //   }
    // }
    handleLeaveRoom(player);

  });
});

// 处理客户端消息
function handleMessage(player, data) {
  switch (data.type) {
    case 'create_room':
      handleCreateRoom(player, data.roomId);
      break;
    case 'join_room':
      handleJoinRoom(player, data.roomId);
      break;
    case 'set_cakes':
      handleSetCakes(player, data.gridSize, data.who_go_first);
      break;
    case 'choose_poison':
      handleChoosePoison(player, data.position);
      break;
    case 'select_cake':
      handleSelectCake(player, data.position);
      break;
    case 'restart_game':
      handleRestartGame(player);
      break;
    case 'leave_room':
      handleLeaveRoom(player);
      break;
  }
}

// 添加离开房间的处理函数
function handleLeaveRoom(player) {
  if (!player.roomId || !rooms.has(player.roomId)) {
    return;
  }

  const room = rooms.get(player.roomId);

  // 从房间中移除玩家
  const playerIndex = room.players.findIndex(p => p === player);
  if (playerIndex !== -1) {
    room.players.splice(playerIndex, 1);
  }

  // 如果房间还有另一个玩家，通知他们对手离开了
  if (room.players.length > 0) {
    const remainingPlayer = room.players[0];
    remainingPlayer.ws.send(JSON.stringify({
      type: 'opponent_disconnected'
    }));
  }

  // 如果房间没有玩家了，删除房间
  if (room.players.length === 0) {
    rooms.delete(player.roomId);
    console.log(`房间 ${player.roomId} 已删除（所有玩家离开）`);
  } else {
    console.log(`玩家离开房间 ${player.roomId}，剩余玩家数: ${room.players.length}`);
  }

  // 重置玩家的房间信息
  player.roomId = null;
  player.role = null;
  player.poisonPosition = null;
  player.isTurn = false;

  // 通知玩家已成功离开房间
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify({
      type: 'room_left'
    }));
  }
}

// 创建房间
function handleCreateRoom(player, roomId) {
  // 验证房间号格式
  if (!/^\d{4}$/.test(roomId)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '房间号必须是4位数字'
    }));
    return;
  }

  // 检查房间是否已存在
  if (rooms.has(roomId)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '房间已存在'
    }));
    return;
  }

  // 创建房间
  const room = {
    id: roomId,
    players: [player],
    state: GameState.WAITING,
    gridSize: null,
    poisonPositions: {},
    currentTurn: null,
    selectedCakes: new Set(),
    createdAt: Date.now()
  };

  rooms.set(roomId, room);
  player.roomId = roomId;
  player.role = PlayerRole.HOST;

  console.log(`房间 ${roomId} 创建成功`);

  // 通知房主
  player.ws.send(JSON.stringify({
    type: 'room_created',
    roomId,
    role: PlayerRole.HOST
  }));
}

// 加入房间
function handleJoinRoom(player, roomId) {
  // 验证房间号格式
  if (!/^\d{4}$/.test(roomId)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '房间号必须是4位数字'
    }));
    return;
  }

  // 检查房间是否存在
  if (!rooms.has(roomId)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '房间不存在'
    }));
    return;
  }

  const room = rooms.get(roomId);

  // 检查房间是否已满
  if (room.players.length >= 2) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '房间已满'
    }));
    return;
  }

  // 检查游戏是否已经开始
  if (room.state !== GameState.WAITING && room.state !== GameState.SETTING_CAKES) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '游戏已经开始，无法加入'
    }));
    return;
  }

  // 加入房间
  room.players.push(player);
  player.roomId = roomId;
  player.role = PlayerRole.GUEST;

  // 更新房间状态
  room.state = GameState.SETTING_CAKES;

  console.log(`玩家加入房间 ${roomId}`);

  // 通知双方玩家
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'player_joined',
      roomId,
      role: p.role,
      state: room.state
    }));
  });
}

// 设置蛋糕网格大小
function handleSetCakes(player, gridSize, who_go_first) {
  const room = rooms.get(player.roomId);
  if (!room || player.role !== PlayerRole.HOST) return;

  // 检查游戏状态，只有在等待或设置阶段才能设置
  if (room.state !== GameState.WAITING && room.state !== GameState.SETTING_CAKES) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '游戏已经开始，无法更改设置'
    }));
    return;
  }

  // 检查房间是否有两名玩家
  if (room.players.length < 2) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '等待另一名玩家加入'
    }));
    return;
  }

  // 验证网格大小
  const size = parseInt(gridSize);
  if (isNaN(size) || size < 3 || size > 8) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '网格大小必须在3到8之间'
    }));
    return;
  }

  if (!Object.values(WHO_GO_FIRST).includes(who_go_first)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '请选择先手设置',
    }));
  } else {
    room.who_go_first = who_go_first;
  }

  room.gridSize = size;
  room.state = GameState.CHOOSING_POISON;
  room.poisonPositions = {};
  room.selectedCakes = new Set();
  room.currentTurn = null; // 游戏开始前没有当前回合

  console.log(`房间 ${room.id} 设置网格大小: ${size}x${size}`);

  // 通知双方玩家进入毒药选择阶段
  room.players.forEach(p => {
    p.poisonPosition = null;
    p.isTurn = false; // 毒药选择阶段没有回合概念
    p.ws.send(JSON.stringify({
      type: 'game_started',
      gridSize: size,
      state: room.state,
      isTurn: false,
      currentPlayer: null
    }));
  });
}

// 选择毒药蛋糕
function handleChoosePoison(player, position) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== GameState.CHOOSING_POISON) return;

  // 验证位置
  const [row, col] = position;
  if (row < 0 || row >= room.gridSize || col < 0 || col >= room.gridSize) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '无效的位置'
    }));
    return;
  }

  // 检查是否已选择过毒药
  if (player.poisonPosition !== null) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '你已经选择了毒药'
    }));
    return;
  }

  // 保存毒药位置
  room.poisonPositions[player.role] = position;
  player.poisonPosition = position;

  console.log(`玩家 ${player.role} 选择毒药位置: [${row}, ${col}]`);

  // 通知玩家已选择毒药
  player.ws.send(JSON.stringify({
    type: 'poison_chosen',
    yourPoison: position,
    allPoisonsChosen: false
  }));

  // 通知对方玩家已选择毒药（但不同步毒药位置）
  const otherPlayer = room.players.find(p => p !== player);
  if (otherPlayer && otherPlayer.ws.readyState === WebSocket.OPEN) {
    otherPlayer.ws.send(JSON.stringify({
      type: 'opponent_poison_chosen',
      opponentRole: player.role
    }));
  }

  // 检查是否双方都选择了毒药
  const bothChosen = room.players.every(p => p.poisonPosition !== null);

  if (bothChosen) {
    room.state = GameState.PLAYING;
    // 随机决定谁先开始游戏
    room.currentTurn = handleWhoGoFirst(room, room.who_go_first);

    console.log(`双方都选择了毒药，游戏开始！先手玩家: ${room.currentTurn}`);

    // 通知双方玩家游戏开始
    room.players.forEach(p => {
      p.isTurn = p.role === room.currentTurn;
      p.ws.send(JSON.stringify({
        type: 'all_poisons_chosen',
        yourPoison: p.poisonPosition,
        state: room.state,
        isTurn: p.isTurn,
        currentPlayer: room.currentTurn
      }));
    });
  }
}

function handleWhoGoFirst(room, who_go_first) {
  let player = null;
  switch (who_go_first) {
    case WHO_GO_FIRST.WIN_FIRST:  // 赢者先
      if (room.lastWinners && room.lastWinners.length > 0) {
        player = room.lastWinners[room.lastWinners.length - 1];
      } else {
        player = handleWhoGoFirst(room, WHO_GO_FIRST.RANDOM);
      }
      break;
    case WHO_GO_FIRST.LOSE_FIRST: // 输者先
      if (room.lastWinners && room.lastWinners.length > 0) {
        player = room.lastWinners[room.lastWinners.length - 1] === PlayerRole.HOST ? PlayerRole.GUEST : PlayerRole.HOST;
      } else {
        player = handleWhoGoFirst(room, WHO_GO_FIRST.RANDOM);
      }
      break;
    case WHO_GO_FIRST.HOST: // 房主先
      player = PlayerRole.HOST;
    case WHO_GO_FIRST.GUEST:  // 玩家2先
      player = PlayerRole.GUEST;
    default:  // 随机
      player = Math.random() > 0.5 ? PlayerRole.HOST : PlayerRole.GUEST;
      break;
  }
  return player;
}

// 选择蛋糕
function handleSelectCake(player, position) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== GameState.PLAYING) return;

  // 检查是否轮到该玩家
  if (room.currentTurn !== player.role) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '现在不是你的回合'
    }));
    return;
  }

  // 验证位置
  const [row, col] = position;
  if (row < 0 || row >= room.gridSize || col < 0 || col >= room.gridSize) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '无效的位置'
    }));
    return;
  }

  // 检查蛋糕是否已被选择
  const posKey = `${row},${col}`;
  if (room.selectedCakes.has(posKey)) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '这个蛋糕已经被选择了'
    }));
    return;
  }

  console.log(`玩家 ${player.role} 选择蛋糕: [${row}, ${col}]`);

  // 标记蛋糕为已选择
  room.selectedCakes.add(posKey);

  // 检查是否选中了毒药
  let gameOver = false;
  let winner = null;
  let loser = null;
  let poisonOwner = null;
  let isSelfPoison = false;

  // 检查是否选中了自己的毒药
  if (player.poisonPosition && player.poisonPosition[0] === row && player.poisonPosition[1] === col) {
    gameOver = true;
    poisonOwner = player.role;
    isSelfPoison = true;
    // 选中了自己的毒药 -> 自己输，对方赢
    loser = player.role;
    winner = player.role === PlayerRole.HOST ? PlayerRole.GUEST : PlayerRole.HOST;
  }
  // 检查是否选中了对方的毒药
  else {
    const opponentRole = player.role === PlayerRole.HOST ? PlayerRole.GUEST : PlayerRole.HOST;
    const opponentPoison = room.poisonPositions[opponentRole];
    if (opponentPoison && opponentPoison[0] === row && opponentPoison[1] === col) {
      gameOver = true;
      poisonOwner = opponentRole;
      isSelfPoison = false;
      // 选中了对方的毒药 -> 自己输，对方赢
      loser = player.role;
      winner = opponentRole;
    }
  }

  if (gameOver) {
    room.state = GameState.FINISHED;
    room.lastWinners = room.lastWinners ? [...room.lastWinners, winner] : [winner];
    // 通知双方玩家游戏结束
    room.players.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'game_over',
        winner,
        loser,
        lastWinners: room.lastWinners,
        selectedPosition: position,
        poisonOwner,
        isSelfPoison: p.role === player.role ? isSelfPoison : !isSelfPoison,
        yourRole: p.role,
        yourPoison: p.poisonPosition,
        opponentPoison: p.role === PlayerRole.HOST ?
          room.poisonPositions[PlayerRole.GUEST] :
          room.poisonPositions[PlayerRole.HOST]
      }));
    });

    console.log(`游戏结束! 获胜者: ${winner}, 输家: ${loser}, 毒药所有者: ${poisonOwner}`, 'lastWinners:' , room.lastWinners.toString());
  } else {
    // 切换回合
    room.currentTurn = room.currentTurn === PlayerRole.HOST ? PlayerRole.GUEST : PlayerRole.HOST;

    // 通知双方玩家
    room.players.forEach(p => {
      p.isTurn = p.role === room.currentTurn;
      p.ws.send(JSON.stringify({
        type: 'cake_selected',
        selectedPosition: position,
        selectedBy: player.role,
        isTurn: p.isTurn,
        currentPlayer: room.currentTurn,
        selectedCakes: Array.from(room.selectedCakes)
      }));
    });
  }
}

// 重新开始游戏
function handleRestartGame(player) {
  const room = rooms.get(player.roomId);
  if (!room) return;

  // 只有房主可以重新开始
  if (player.role !== PlayerRole.HOST) {
    player.ws.send(JSON.stringify({
      type: 'error',
      message: '您不是房主，已向房主发出申请'
    }));
    room.players.find(p => p.role === PlayerRole.HOST).ws.send(JSON.stringify({
      type: 'request_restart_game',
      data: { requester: player.role }
    }))
    console.log(`玩家 ${player.role} 请求重新开始游戏`);
    return;
  }

  // 重置游戏状态
  room.state = GameState.CHOOSING_POISON;
  room.poisonPositions = {};
  room.selectedCakes = new Set();
  room.currentTurn = Math.random() > 0.5 ? PlayerRole.HOST : PlayerRole.GUEST;

  // 重置玩家状态
  room.players.forEach(p => {
    p.poisonPosition = null;
    p.isTurn = p.role === room.currentTurn;
  });

  // 通知双方玩家
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'game_restarted',
      gridSize: room.gridSize,
      state: room.state,
      isTurn: p.isTurn,
      currentPlayer: room.currentTurn
    }));
  });
}

// 启动服务器
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`WebSocket服务器运行在 ws://localhost:${PORT}`);
});