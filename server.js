// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Khởi tạo Socket.IO
const io = new Server(server, {
    cors: {
        // Cho phép frontend kết nối từ mọi nguồn
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Port mặc định
const PORT = 3000;

// ==========================================================
// CƠ SỞ DỮ LIỆU GIẢ LẬP (In-Memory Database)
// ==========================================================
/**
 * rooms: {
 * '123456': {
 * hostId: 'socketIdHost',
 * bellStatus: 'locked', // locked, open_infinite, open_timed
 * bellOpenTimestamp: null,
 * bellSessionId: 'uuid123',
 * lockedUsers: ['userId2'],
 * options: { buzzCount: 'single', buzzMode: 'all-buzz' },
 * participants: { 
 * 'socketIdHost': { username: 'Host (Bạn)', isHost: true },
 * 'socketIdContestant1': { userId: 'user1', username: 'An', isHost: false },
 * },
 * buzzes: [ 
 * { userId: 'user1', username: 'An', time: 1.234, bellSessionId: 'uuid123' }
 * ]
 * }
 * }
 */
const rooms = {};
const userIdMap = {}; // Map socketId to generated userId

// ==========================================================
// HÀM TIỆN ÍCH
// ==========================================================

// Gửi toàn bộ trạng thái phòng đến tất cả client trong phòng
function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Gửi trạng thái chuông và các tùy chọn đến tất cả client
    io.to(roomId).emit('roomStateUpdate', {
        bellStatus: room.bellStatus,
        bellOpenTimestamp: room.bellOpenTimestamp,
        bellSessionId: room.bellSessionId,
        lockedUsers: room.lockedUsers,
        options: room.options,
        participants: Object.values(room.participants).map(p => ({
            username: p.username,
            isHost: p.isHost
        })),
        buzzes: room.buzzes
    });
}

// ==========================================================
// LOGIC XỬ LÝ SOCKET.IO
// ==========================================================

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Tạo userId cho Contestant (vì không dùng Firebase Auth)
    const generatedUserId = `user-${socket.id}`;
    userIdMap[socket.id] = generatedUserId;

    // --- HOST EVENTS ---

    socket.on('createRoom', (data) => {
        let roomId;
        do {
            roomId = Math.floor(100000 + Math.random() * 900000).toString();
        } while (rooms[roomId]);

        const newRoom = {
            hostId: socket.id,
            bellStatus: "locked",
            bellOpenTimestamp: null,
            bellSessionId: crypto.randomUUID(),
            lockedUsers: [],
            options: {
                buzzCount: "single",
                buzzMode: "all-buzz"
            },
            participants: {},
            buzzes: []
        };
        rooms[roomId] = newRoom;
        
        // Thêm Host vào danh sách tham gia
        newRoom.participants[socket.id] = { username: 'Host (Bạn)', isHost: true, userId: socket.id };
        
        socket.join(roomId);
        socket.emit('roomCreated', { roomId: roomId });
        broadcastRoomState(roomId);
    });

    socket.on('hostUpdateRoom', ({ roomId, data }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return; // Chỉ host mới được update
        
        // Cập nhật trạng thái chuông
        if (data.bellStatus) {
            room.bellStatus = data.bellStatus;
            if (data.bellStatus.startsWith('open')) {
                room.bellOpenTimestamp = Date.now();
            } else if (data.bellStatus === 'locked') {
                room.bellOpenTimestamp = null;
            }
        }
        
        // Cập nhật Locked Users
        if (data.lockedUsers !== undefined) {
            room.lockedUsers = data.lockedUsers;
        }

        // Cập nhật Options
        if (data.options) {
            room.options = { ...room.options, ...data.options };
        }

        // Cập nhật Reset (cả trạng thái và session)
        if (data.reset) {
            room.bellStatus = "locked";
            room.bellOpenTimestamp = null;
            room.bellSessionId = crypto.randomUUID();
            room.buzzes = [];
        }
        
        broadcastRoomState(roomId);
    });

    // --- CONTESTANT EVENTS ---

    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }

        // Kiểm tra username trùng
        const existingUser = Object.values(room.participants).find(p => p.username === username);
        if (existingUser) {
             socket.emit('joinRoomError', { message: 'Username đã được sử dụng. Vui lòng chọn tên khác.' });
             return;
        }

        socket.join(roomId);
        
        room.participants[socket.id] = { 
            userId: generatedUserId, 
            username: username, 
            isHost: false,
            roomId: roomId // Lưu roomId vào contestant
        };
        
        socket.emit('roomJoined', { roomId, username, userId: generatedUserId });
        broadcastRoomState(roomId);
    });

    socket.on('buzz', ({ roomId, username, userId, bellSessionId }) => {
        const room = rooms[roomId];
        if (!room || room.bellStatus === 'locked' || room.bellSessionId !== bellSessionId) return;

        // 1. Kiểm tra đã bị khóa
        if (room.lockedUsers.includes(userId)) return;

        // 2. Kiểm tra chế độ "1 người bấm duy nhất" (single-winner)
        if (room.options.buzzMode === 'single-winner' && room.buzzes.length > 0) return;

        // 3. Kiểm tra chế độ "Chỉ được bấm 1 lần" (single)
        if (room.options.buzzCount === 'single' && room.buzzes.some(b => b.userId === userId && b.bellSessionId === bellSessionId)) return;
        
        // Bấm chuông hợp lệ
        const buzzTime = (Date.now() - room.bellOpenTimestamp) / 1000;
        
        const newBuzz = {
            userId: userId,
            username: username,
            time: buzzTime,
            bellSessionId: room.bellSessionId
        };
        room.buzzes.push(newBuzz);
        
        // Nếu là single-winner, khóa chuông ngay lập tức
        if (room.options.buzzMode === 'single-winner') {
             room.bellStatus = 'locked';
        }

        broadcastRoomState(roomId);
    });

    // --- DISCONNECT ---

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        // 1. Kiểm tra nếu là Host
        for (const roomId in rooms) {
            if (rooms[roomId].hostId === socket.id) {
                console.log(`Host of room ${roomId} disconnected. Room deleted.`);
                io.to(roomId).emit('roomClosed', { message: 'Host đã rời phòng.' });
                
                // Xóa phòng
                delete rooms[roomId];
                
                // Xóa userId map
                delete userIdMap[socket.id];
                return;
            }
            
            // 2. Kiểm tra nếu là Contestant
            if (rooms[roomId].participants[socket.id]) {
                const username = rooms[roomId].participants[socket.id].username;
                console.log(`Contestant ${username} in room ${roomId} disconnected.`);
                delete rooms[roomId].participants[socket.id];
                delete userIdMap[socket.id];
                
                // Cập nhật trạng thái phòng cho Host
                broadcastRoomState(roomId);
                return;
            }
        }
    });
});

// Phục vụ các file tĩnh (Host.html và Contestant.html)
app.use(express.static('./'));

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Access Host: http://localhost:${PORT}/Host.html`);
    console.log(`Access Contestant: http://localhost:${PORT}/Contestant.html`);
});