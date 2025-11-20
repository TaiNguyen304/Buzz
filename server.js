const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Dữ liệu phòng
const rooms = {};
const userIdMap = {};

// --- UTILS ---
function generateRoomId() {
    let roomId;
    do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms[roomId]);
    return roomId;
}

function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const participantsArray = Object.values(room.participants);
    
    const roomState = {
        roomId: roomId,
        bellStatus: room.bellStatus,
        bellOpenTimestamp: room.bellOpenTimestamp,
        bellSessionId: room.bellSessionId,
        bellDuration: room.bellDuration,
        lockedUsers: room.lockedUsers,
        options: room.options,
        participants: participantsArray,
        buzzes: room.buzzes
    };

    io.to(roomId).emit('roomStateUpdate', roomState);
}

// --- SOCKET ---
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Host tạo phòng
    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        const userId = `host-${socket.id}`;
        
        rooms[roomId] = {
            hostId: socket.id,
            bellStatus: 'locked',
            bellOpenTimestamp: null,
            bellDuration: null,
            bellSessionId: Date.now().toString(),
            lockedUsers: [],
            options: { buzzCount: 'single', buzzMode: 'single-winner' },
            participants: {},
            buzzes: []
        };
        
        rooms[roomId].participants[socket.id] = { userId: userId, username: 'Host (Bạn)', isHost: true };
        userIdMap[socket.id] = userId;

        socket.join(roomId);
        socket.emit('roomCreated', { roomId });
        broadcastRoomState(roomId);
    });

    // Cập nhật phòng từ Host
    socket.on('hostUpdateRoom', ({ roomId, data }) => {
        const room = rooms[roomId];
        if (!room) return;

        const isHost = (room.hostId === socket.id);
        const participant = room.participants[socket.id]; 
        const isManager = (participant && participant.isManager === true);

        if (!isHost && !isManager) return;

        // Reset
        if (data.reset) {
            room.bellStatus = 'locked';
            room.buzzes = [];
            room.bellOpenTimestamp = null;
            room.bellDuration = null;
            room.bellSessionId = Date.now().toString();
        }

        // Cập nhật status
        if (data.bellStatus) {
            room.bellStatus = data.bellStatus;
            if (data.bellStatus.startsWith('open')) {
                // [FIX QUAN TRỌNG] Luôn dùng giờ Server, bỏ qua giờ Client gửi lên để tránh lệch giờ
                room.bellOpenTimestamp = Date.now();
            }
        }

        // [FIX] Cập nhật thời gian mở chuông, kể cả khi giá trị là null (tức là chuyển sang vô hạn)
        if (data.bellDuration !== undefined) room.bellDuration = data.bellDuration; 

        if (data.lockedUsers !== undefined) room.lockedUsers = data.lockedUsers;
        if (data.options) room.options = { ...room.options, ...data.options };

        broadcastRoomState(roomId);
    });
    
    // Manager tham gia
    socket.on('joinRoomAsManager', ({ roomId, username, userId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }
        if (Object.values(room.participants).some(p => p.username === username)) {
            socket.emit('joinRoomError', { message: 'Username đã tồn tại.' });
            return;
        }

        room.participants[socket.id] = { userId: userId, username: username, isHost: false, isManager: true };
        userIdMap[socket.id] = userId;
        socket.join(roomId);
        socket.emit('joinedAsManager', { roomId, username, roomState: rooms[roomId] }); 
        broadcastRoomState(roomId);
    });

    // Contestant tham gia
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }
        
        const userId = socket.id;
        userIdMap[socket.id] = userId;
        room.participants[socket.id] = { userId: userId, username: username, isHost: false, isManager: false };
        socket.join(roomId);
        socket.emit('roomJoined', { roomId, username });
        broadcastRoomState(roomId);
    });

    // Xử lý bấm chuông
    socket.on('buzz', ({ roomId, username, userId, bellSessionId }) => {
        const room = rooms[roomId];
        if (!room || !room.bellStatus.startsWith('open') || room.bellSessionId !== bellSessionId) return;

        const participant = room.participants[socket.id];
        if (!participant || room.lockedUsers.includes(participant.userId)) return;

        const iHaveBuzzed = room.buzzes.some(buzz => buzz.userId === userId && buzz.bellSessionId === bellSessionId);
        if (room.options.buzzCount === 'single' && iHaveBuzzed) return;

        // Tính toán thời gian dựa trên giờ Server
        const buzzTime = (Date.now() - room.bellOpenTimestamp) / 1000;
        
        // Nếu chuông có giới hạn và bấm muộn hơn giới hạn (tính theo server) -> bỏ qua
        if (room.bellStatus === 'open_timed' && room.bellDuration && buzzTime > room.bellDuration) {
             return; 
        }

        room.buzzes.push({ userId, username, time: buzzTime, bellSessionId });

        if (room.options.buzzMode === 'single-winner') {
            room.bellStatus = 'locked_winner';
        }
        
        broadcastRoomState(roomId);
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].hostId === socket.id) {
                io.to(roomId).emit('roomClosed', { message: 'Host đã rời phòng.' });
                delete rooms[roomId];
                delete userIdMap[socket.id];
                return;
            }
            if (rooms[roomId].participants[socket.id]) {
                delete rooms[roomId].participants[socket.id];
                delete userIdMap[socket.id];
                broadcastRoomState(roomId);
                return;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});