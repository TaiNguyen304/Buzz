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
        origin: "https://tainguyen304.github.io", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// ==========================================================
// CƠ SỞ DỮ LIỆU GIẢ LẬP (In-Memory Database)
// ==========================================================
/**
 * rooms: {
 * '123456': {
 * hostId: 'socketIdHost',
 * bellStatus: 'locked', // locked, open_infinite, open_timed, locked_winner
 * bellOpenTimestamp: null,
 * bellSessionId: 'uuid123',
 * lockedUsers: ['userId2'],
 * options: { buzzCount: 'single', buzzMode: 'all-buzz' },
 * participants: { 
 * 'socketIdHost': { username: 'Host (Bạn)', isHost: true, userId: 'host-socketIdHost' },
 * 'socketIdContestant1': { userId: 'user1', username: 'An', isHost: false, isManager: false },
 * 'socketIdManager1': { userId: 'manager1', username: 'Quản Lý', isHost: false, isManager: true }, // <<< Quản lý
 * },
 * buzzes: [ 
 * { userId: 'user1', username: 'An', time: 1.234, bellSessionId: 'uuid123' },
 * ],
 * }
 * }
 */
const rooms = {};
const userIdMap = {}; // socketId -> userId

// --- UTILS ---

/** Tạo ID phòng 6 chữ số ngẫu nhiên */
function generateRoomId() {
    let roomId;
    do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms[roomId]);
    return roomId;
}

/** * Chuẩn bị và broadcast trạng thái phòng đến tất cả người tham gia
 * @param {string} roomId 
 */
function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Chuyển đổi participants từ object sang array để dễ xử lý ở client
    const participantsArray = Object.values(room.participants);
    
    // Tạo data để gửi đi (loại bỏ hostId và userIdMap)
    const roomState = {
        roomId: roomId,
        bellStatus: room.bellStatus,
        bellOpenTimestamp: room.bellOpenTimestamp,
        bellSessionId: room.bellSessionId,
        lockedUsers: room.lockedUsers,
        options: room.options,
        participants: participantsArray,
        buzzes: room.buzzes
    };

    io.to(roomId).emit('roomStateUpdate', roomState);
}

// ==========================================================
// XỬ LÝ SOCKET.IO
// ==========================================================

io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // --- HOST EVENTS ---
    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        const userId = `host-${socket.id}`;
        
        rooms[roomId] = {
            hostId: socket.id,
            bellStatus: 'locked',
            bellOpenTimestamp: null,
            bellSessionId: Date.now().toString(),
            lockedUsers: [], // Lưu trữ userId của người bị khóa
            options: { buzzCount: 'single', buzzMode: 'single-winner' }, // Mặc định
            participants: {},
            buzzes: []
        };
        
        // Thêm Host vào participants
        rooms[roomId].participants[socket.id] = { 
            userId: userId, 
            username: 'Host (Bạn)', 
            isHost: true 
        };
        userIdMap[socket.id] = userId;

        socket.join(roomId);
        console.log(`Room ${roomId} created by Host ${socket.id}`);
        socket.emit('roomCreated', { roomId });
        broadcastRoomState(roomId);
    });

    socket.on('hostUpdateRoom', ({ roomId, data }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        // Xử lý lệnh reset chuông
        if (data.reset) {
            room.bellStatus = 'locked';
            room.buzzes = [];
            room.bellOpenTimestamp = null;
            room.bellSessionId = Date.now().toString(); // Tạo session mới
        }

        // Cập nhật trạng thái chuông
        if (data.bellStatus) {
            room.bellStatus = data.bellStatus;
            if (data.bellStatus.startsWith('open')) {
                room.bellOpenTimestamp = Date.now();
                // Không tạo session mới khi mở lại chuông trong cùng 1 vòng
                // session mới chỉ tạo khi Host bấm Reset (đã xử lý ở trên)
            } else if (data.bellStatus === 'locked') {
                // Khóa chuông KHÔNG xóa lịch sử
            }
        }

        // Cập nhật danh sách người bị khóa
        if (data.lockedUsers !== undefined) {
            room.lockedUsers = data.lockedUsers;
        }

        // Cập nhật tùy chọn chuông
        if (data.options) {
            room.options = { ...room.options, ...data.options };
        }

        broadcastRoomState(roomId);
    });
    
    // --- MANAGER EVENTS (MỚI) ---
    socket.on('joinRoomAsManager', ({ roomId, username, userId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }

        // 1. Kiểm tra trùng username (Không cho trùng với Host, Manager, hay Contestant khác)
        const usernameExists = Object.values(room.participants).some(p => p.username === username);
        if (usernameExists) {
            socket.emit('joinRoomError', { message: 'Username đã tồn tại trong phòng. Vui lòng chọn tên khác.' });
            return;
        }

        // 2. Thêm Quản lý vào phòng
        room.participants[socket.id] = { 
            userId: userId, 
            username: username, 
            isHost: false,
            isManager: true // <<< Dòng quan trọng: đánh dấu là Quản lý
        };
        userIdMap[socket.id] = userId;

        socket.join(roomId);
        console.log(`Manager ${username} joined room ${roomId}`);

        // 3. Phản hồi thành công về cho Manager (Host.html)
        // Gửi toàn bộ roomState để client Host.html biết mà cập nhật giao diện điều khiển
        socket.emit('joinedAsManager', { roomId, username, roomState: rooms[roomId] }); 
        
        // 4. Broadcast trạng thái mới cho tất cả mọi người (bao gồm Host)
        broadcastRoomState(roomId);
    });


    // --- CONTESTANT EVENTS ---
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('joinRoomError', { message: 'Phòng không tồn tại.' });
            return;
        }
        
        const userId = socket.id; // Dùng socket.id làm userId tạm thời cho Contestant
        userIdMap[socket.id] = userId;

        // Thêm Contestant vào phòng
        room.participants[socket.id] = { userId: userId, username: username, isHost: false, isManager: false };
        socket.join(roomId);
        console.log(`Contestant ${username} joined room ${roomId}`);

        socket.emit('roomJoined', { roomId, username });
        broadcastRoomState(roomId);
    });

    socket.on('buzz', ({ roomId, username, userId, bellSessionId }) => {
        const room = rooms[roomId];
        if (!room || room.bellStatus.startsWith('locked') || room.bellSessionId !== bellSessionId) return;

        const participant = room.participants[socket.id];
        if (!participant) return;

        // NEW LOGIC: KIỂM TRA NGƯỜI CHƠI BỊ KHÓA CHUÔNG
        if (room.lockedUsers.includes(participant.userId)) {
            console.log(`[BELL LOCK] User ${username} is locked and cannot buzz.`);
            return; 
        }

        // 1. Kiểm tra Buzz Count (Mỗi người chỉ được bấm 1 lần/vòng)
        const iHaveBuzzed = room.buzzes.some(buzz => buzz.userId === userId && buzz.bellSessionId === bellSessionId);
        if (room.options.buzzCount === 'single' && iHaveBuzzed) {
            console.log(`User ${username} tried to buzz again (single buzz mode).`);
            return;
        }

        // 2. Xử lý Buzz hợp lệ
        const buzzTime = (Date.now() - room.bellOpenTimestamp) / 1000;
        
        room.buzzes.push({ 
            userId: userId, 
            username: username, 
            time: buzzTime, 
            bellSessionId: bellSessionId 
        });

        console.log(`Buzz received from ${username} at ${buzzTime.toFixed(3)}s`);

        // 3. Xử lý Buzz Mode (Một người thắng: Khóa chuông ngay lập tức)
        if (room.options.buzzMode === 'single-winner') {
            room.bellStatus = 'locked_winner';
            console.log(`Single-winner mode: Bell locked after buzz by ${username}`);
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
            
            // 2. Kiểm tra nếu là Contestant hoặc Manager
            if (rooms[roomId].participants[socket.id]) {
                const username = rooms[roomId].participants[socket.id].username;
                // Cập nhật logic: Nếu là Manager, vẫn thông báo là đã ngắt kết nối
                const role = rooms[roomId].participants[socket.id].isManager ? 'Manager' : 'Contestant';

                console.log(`${role} ${username} in room ${roomId} disconnected.`);
                delete rooms[roomId].participants[socket.id];
                delete userIdMap[socket.id];
                
                // Cập nhật trạng thái phòng cho Host
                broadcastRoomState(roomId);
                return;
            }
        }
    });
});


server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Access Host: http://localhost:${PORT}/Host.html`);
    console.log(`Access Contestant: http://localhost:${PORT}/Contestant.html`);
});